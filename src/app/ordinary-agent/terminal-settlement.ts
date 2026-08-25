import { toolInvocationId, sameResultForIdempotency, type ToolCallResult } from "../../domain/tools/index.js";
import { errorMessage } from "../../kernel/values/index.js";
import type { AgentSessionEntryRef } from "../model-runtime/agent-session.js";
import type {
  OrdinaryFeatureDiagnostic,
  OrdinaryStableTerminalRunFacts,
  OrdinaryRunSnapshotDocument,
  OrdinaryRunState,
  OrdinaryRunStatus,
} from "./contracts.js";
import { OrdinaryFeatureError } from "./contracts.js";

export function createTerminalSettlement(input: {
  readonly finalizeSession?: (runId: string, target?: AgentSessionEntryRef | null) => Promise<void>;
  readonly loadRun: (runId: string) => Promise<OrdinaryRunSnapshotDocument | undefined>;
  readonly cachedRun: (runId: string) => OrdinaryRunSnapshotDocument | undefined;
  readonly persistToolResult: (runId: string, result: ToolCallResult) => Promise<void>;
  readonly reconcilePendingToolRound: (runId: string) => Promise<OrdinaryRunState | undefined>;
  readonly reconcileLostApprovalResults: (runId: string) => Promise<OrdinaryRunState | undefined>;
  readonly externalSettlementCleared: (runId: string) => boolean;
  readonly isHiddenRun: (state: OrdinaryRunState) => boolean;
  readonly hasActivitySubscribers: (runId: string) => boolean;
  readonly releaseActivityStream: (runId: string) => void;
  readonly emitDiagnostic: (diagnostic: OrdinaryFeatureDiagnostic) => void;
  readonly onStable: (runId: string) => void;
}) {
  const acceptedToolResults = new Map<string, Map<string, ToolCallResult>>();
  const sessionsAwaitingFinalization = new Set<string>();
  const sessionFinalizationPending = new Set<string>();
  const sessionFinalizationFailures = new Map<string, unknown>();
  const sessionFinalizationAttempts = new Map<string, Promise<void>>();
  const stableTerminalListeners = new Set<(runId: string) => void>();

  function rememberToolResults(runId: string, results: readonly ToolCallResult[]): void {
    const accepted = acceptedToolResults.get(runId) ?? new Map<string, ToolCallResult>();
    for (const result of results) {
      const invocationId = toolInvocationId(result);
      const existing = accepted.get(invocationId);
      if (existing !== undefined && existing.status !== "approval_required" &&
          !sameResultForIdempotency(existing, result)) {
        throw new OrdinaryFeatureError(
          "ordinary_tool_result_conflict",
          `Ordinary run ${runId} observed different results for tool invocation ${invocationId}`,
        );
      }
      accepted.set(invocationId, cloneToolResult(result));
    }
    if (accepted.size > 0) acceptedToolResults.set(runId, accepted);
  }

  function forgetPersistedToolResults(runId: string, results: readonly ToolCallResult[]): void {
    const accepted = acceptedToolResults.get(runId);
    const state = input.cachedRun(runId)?.state;
    if (accepted === undefined || state === undefined) return;
    for (const result of results) {
      const invocationId = toolInvocationId(result);
      const persisted = state.toolCalls.find((item) => toolInvocationId(item) === invocationId);
      if (persisted !== undefined && sameResultForIdempotency(persisted, result)) {
        accepted.delete(invocationId);
      }
    }
    if (accepted.size === 0) acceptedToolResults.delete(runId);
  }

  function forgetReconciledApprovalResults(runId: string): void {
    const accepted = acceptedToolResults.get(runId);
    const state = input.cachedRun(runId)?.state;
    if (accepted === undefined || state === undefined) return;
    for (const [invocationId, result] of accepted) {
      if (result.status === "approval_required" &&
          state.toolCalls.some((persisted) => toolInvocationId(persisted) === invocationId &&
            persisted.status !== "approval_required")) {
        accepted.delete(invocationId);
      }
    }
    if (accepted.size === 0) acceptedToolResults.delete(runId);
  }

  async function settleExecution(runId: string): Promise<void> {
    let resultPersistenceFailure: unknown;
    for (const result of [...(acceptedToolResults.get(runId)?.values() ?? [])]) {
      try {
        await input.persistToolResult(runId, result);
        forgetPersistedToolResults(runId, [result]);
      } catch (error) {
        resultPersistenceFailure ??= error;
      }
    }
    let current = await input.loadRun(runId);
    if (current === undefined) return;
    if (current.state.status.kind === "awaiting_approval") {
      if (resultPersistenceFailure !== undefined) throw resultPersistenceFailure;
      return;
    }
    if (current.state.pendingToolRound !== undefined || current.state.pendingNestedToolCalls !== undefined) {
      try {
        await input.reconcilePendingToolRound(runId);
      } catch (error) {
        throw resultPersistenceFailure === undefined
          ? error
          : new AggregateError(
              [resultPersistenceFailure, error],
              `Ordinary run ${runId} could not reconcile its terminal tool round`,
            );
      }
      current = await input.loadRun(runId) ?? current;
      if (current.state.pendingToolRound === undefined &&
          current.state.pendingNestedToolCalls === undefined) acceptedToolResults.delete(runId);
      resultPersistenceFailure = undefined;
    }
    if (isTerminal(current.state) && current.state.toolCalls.some((result) => result.status === "approval_required")) {
      await input.reconcileLostApprovalResults(runId);
      current = await input.loadRun(runId) ?? current;
      forgetReconciledApprovalResults(runId);
    }
    if (resultPersistenceFailure !== undefined) throw resultPersistenceFailure;
  }

  function markSessionAwaitingFinalization(runId: string): void {
    if (input.finalizeSession !== undefined) sessionsAwaitingFinalization.add(runId);
  }

  async function finalizeSession(
    runId: string,
    state: OrdinaryRunState,
    restoreSafeLeaf: boolean,
  ): Promise<void> {
    if (input.finalizeSession === undefined) return;
    sessionFinalizationPending.add(runId);
    const target = restoreSafeLeaf ? rollbackLeafRef(state) : undefined;
    let firstFailure: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await input.finalizeSession(runId, target);
        clearFinalization(runId);
        return;
      } catch (error) {
        if (state.session.phase === "not_started" && errorMessage(error).includes("has no active Session control")) {
          clearFinalization(runId);
          return;
        }
        firstFailure ??= error;
      }
    }
    sessionFinalizationFailures.set(runId, firstFailure);
    input.emitDiagnostic({ kind: "session_finalization_failed", runId, error: firstFailure });
    throw firstFailure;
  }

  async function retryFinalization(runId: string): Promise<void> {
    if (!sessionFinalizationPending.has(runId) || !sessionFinalizationFailures.has(runId)) return;
    const existing = sessionFinalizationAttempts.get(runId);
    if (existing !== undefined) return existing;
    const attempt = (async () => {
      const document = await input.loadRun(runId);
      if (document === undefined || !isTerminal(document.state)) return;
      await finalizeSession(runId, document.state, document.state.status.kind !== "completed");
    })().catch(() => undefined);
    sessionFinalizationAttempts.set(runId, attempt);
    try {
      await attempt;
    } finally {
      if (sessionFinalizationAttempts.get(runId) === attempt) sessionFinalizationAttempts.delete(runId);
    }
  }

  function notifyStable(runId: string): void {
    const document = input.cachedRun(runId);
    if (document === undefined || input.isHiddenRun(document.state) || !isStable(document.state)) return;
    for (const listener of [...stableTerminalListeners]) {
      try {
        listener(runId);
      } catch {
        // Observers cannot roll back committed Ordinary facts.
      }
    }
    releaseStableResources(runId);
    input.onStable(runId);
  }

  function releaseStableResources(runId: string): void {
    if (input.hasActivitySubscribers(runId)) return;
    const document = input.cachedRun(runId);
    if (document === undefined || input.isHiddenRun(document.state) || !isStable(document.state)) return;
    input.releaseActivityStream(runId);
  }

  function subscribeStable(listener: (runId: string) => void): () => void {
    stableTerminalListeners.add(listener);
    return () => stableTerminalListeners.delete(listener);
  }

  function isStable(state: OrdinaryRunState): boolean {
    return isTerminal(state) &&
      state.pendingToolRound === undefined &&
      state.pendingNestedToolCalls === undefined &&
      !state.toolCalls.some((result) => result.status === "approval_required") &&
      !acceptedToolResults.has(state.runId) &&
      input.externalSettlementCleared(state.runId);
  }

  async function release(): Promise<void> {
    const failures: unknown[] = [];
    for (const runId of [...sessionsAwaitingFinalization]) {
      const document = await input.loadRun(runId);
      if (document === undefined) continue;
      try {
        await finalizeSession(runId, document.state, document.state.status.kind !== "completed");
      } catch (error) {
        failures.push(sessionFinalizationFailures.get(runId) ?? error);
      }
    }
    stableTerminalListeners.clear();
    sessionsAwaitingFinalization.clear();
    sessionFinalizationPending.clear();
    sessionFinalizationFailures.clear();
    sessionFinalizationAttempts.clear();
    acceptedToolResults.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to finalize one or more Agent sessions.");
    }
  }

  function clearFinalization(runId: string): void {
    sessionsAwaitingFinalization.delete(runId);
    sessionFinalizationPending.delete(runId);
    sessionFinalizationFailures.delete(runId);
  }

  return {
    rememberToolResults,
    forgetPersistedToolResults,
    settleExecution,
    markSessionAwaitingFinalization,
    finalizeSession,
    retryFinalization,
    notifyStable,
    releaseStableResources,
    subscribeStable,
    isStable,
    hasAcceptedToolResults: (runId: string) => acceptedToolResults.has(runId),
    hasAcceptedToolResult: (runId: string, invocationId: string) => acceptedToolResults.get(runId)?.has(invocationId) === true,
    clearAcceptedToolResults: (runId: string) => acceptedToolResults.delete(runId),
    isFinalizationPending: (runId: string) => sessionFinalizationPending.has(runId),
    finalizationFailure: (runId: string) => sessionFinalizationFailures.get(runId),
    release,
  };
}

export function projectStableTerminalRunFacts(
  document: OrdinaryRunSnapshotDocument,
): OrdinaryStableTerminalRunFacts {
  const state = document.state;
  if (!isTerminal(state)) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      `Ordinary run ${state.runId} is not terminal`,
    );
  }
  const status = state.status;
  return structuredClone({
    runId: state.runId,
    sourceRevision: document.revision,
    turn: state.turn,
    userMessage: state.input.userMessage,
    taskContextRefs: (state.input.context?.contextRefs ?? []).map((contextRef) => contextRef.ref),
    workspaceRoot: state.birth.capabilitySnapshot.executionRoot,
    workspaceSelection: state.birth.workspaceSelection ?? "default",
    executionStarted: state.timeline.some((event) => event.type === "run.started"),
    toolFacts: state.toolCalls
      .filter((result): result is ToolCallResult & { readonly status: "completed" | "failed" | "cancelled" } =>
        result.status === "completed" || result.status === "failed" || result.status === "cancelled")
      .map((result) => ({
        toolFactId: toolInvocationId(result),
        ...(result.parentInvocationId === undefined ? {} : { parentToolFactId: result.parentInvocationId }),
        toolName: result.toolName,
        status: result.status,
        durationMs: result.durationMs,
        ...(result.error === undefined ? {} : {
          error: {
            ...(result.errorDomain === undefined ? {} : { domain: result.errorDomain }),
            ...(typeof result.errorFacts?.code === "string" ? { code: result.errorFacts.code } : {}),
            message: result.error,
          },
        }),
      })),
    status,
    createdAt: state.timestamps.createdAt,
    terminalAt: state.timestamps.terminalAt!,
  });
}

function rollbackLeafRef(state: OrdinaryRunState): AgentSessionEntryRef | null {
  if (state.session.phase === "completion_candidate") return state.session.rollbackLeafRef;
  if (state.session.phase === "rollbackable") return state.session.endLeafRef;
  if (state.session.phase === "started") return state.session.startLeafRef;
  return null;
}

function isTerminal(
  state: OrdinaryRunState,
): state is OrdinaryRunState & {
  readonly status: Extract<OrdinaryRunStatus, { readonly kind: "completed" | "failed" | "cancelled" | "blocked" }>;
} {
  return state.status.kind === "completed" ||
    state.status.kind === "failed" ||
    state.status.kind === "cancelled" ||
    state.status.kind === "blocked";
}

function cloneToolResult(result: ToolCallResult): ToolCallResult {
  return structuredClone(result);
}
