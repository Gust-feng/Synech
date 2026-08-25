import type { ConfirmationDecision } from "../../../domain/confirmation/index.js";
import { sameResultForIdempotency, toolInvocationId, type ToolCallRequest, type ToolCallResult } from "../../../domain/tools/index.js";
import { createStableInvocationId, type IdFactory } from "../../../kernel/id.js";
import type { AgentSessionRepository } from "../../model-runtime/agent-session.js";
import type { AcceptedToolInvocation, ProviderToolCall } from "../../model-runtime/agent-loop.js";
import {
  OrdinaryFeatureError,
  type DecideOrdinaryApprovalInput,
  type OrdinaryExecutionContinuation,
  type OrdinaryExecutionOutcome,
  type OrdinaryExecutionPort,
  type OrdinaryFeatureDiagnostic,
  type OrdinaryRunState,
  type OrdinaryRunTurn,
} from "../contracts.js";
import {
  interruptedOrdinaryApprovalResult,
  ordinaryToolResultKey,
  recordOrdinaryNestedToolRequests,
  recordOrdinaryToolResult,
  reconcileInterruptedOrdinaryNestedToolCalls,
  reconcileInterruptedOrdinaryToolRound,
  transitionOrdinaryRun,
  type OrdinaryRunTransition,
} from "../state.js";
import { cancellationReason, isTerminal, isTerminalEvent, ordinaryExecutionFailureFacts } from "../run-lifecycle-policy.js";
import type { OrdinaryRunActivityHub } from "../run-activity-hub.js";
import type { createTerminalSettlement } from "../terminal-settlement.js";
import type { OrdinaryRunStore } from "./run-store.js";
import type { OrdinaryApprovalDecisionLease, OrdinaryExecutionCoordinator } from "./execution-coordinator.js";

type OrdinaryTerminalSettlement = ReturnType<typeof createTerminalSettlement>;
type ExecutionRunStore = Pick<
  OrdinaryRunStore,
  "adoptPersisted" | "cached" | "inspectPersisted" | "load" | "mutate" |
  "mutateLocked" | "savePublished" | "withExclusiveRun"
>;
type ExecutionActivityHub = Pick<
  OrdinaryRunActivityHub,
  "completeReasoning" | "currentModelRequestId" | "recordDurableToolResult" |
  "recordModelRequest" | "recordOutputDelta" | "recordReasoningDelta" |
  "recordToolProgress" | "recordToolRequested" | "recordTransition" | "syncDurableToolResults"
>;
type ExecutionTerminalSettlement = Pick<
  OrdinaryTerminalSettlement,
  "finalizeSession" | "forgetPersistedToolResults" | "hasAcceptedToolResult" |
  "isFinalizationPending" | "markSessionAwaitingFinalization" | "notifyStable" |
  "rememberToolResults" | "settleExecution"
>;
type ExecutionStateOwner = Pick<
  OrdinaryExecutionCoordinator,
  "abortController" | "beginApprovalDecision" | "beginExecution" | "controller" |
  "finishApprovalDecision" | "hasContinuation" | "hasController" | "hasLiveExecution" |
  "registerApprovalContinuation" | "releaseCancellationContinuation" |
  "releaseControllerIfIdle" | "removeController" | "retainCancellationContinuation" |
  "rollbackApprovalDecision" | "startCancellationCleanup" | "startExecutionTask" |
  "takeContinuation" | "trackPostExecutionTask"
>;

export function createOrdinaryExecutionOperations(options: {
  readonly state: ExecutionStateOwner;
  readonly runStore: ExecutionRunStore;
  readonly activityHub: ExecutionActivityHub;
  readonly terminalSettlement: ExecutionTerminalSettlement;
  readonly execution: OrdinaryExecutionPort;
  readonly sessionRepository: AgentSessionRepository;
  readonly now: () => string;
  readonly idFactory: IdFactory;
  readonly isReleased: () => boolean;
  readonly emitDiagnostic: (diagnostic: OrdinaryFeatureDiagnostic) => void;
  readonly activateSuccessor: (predecessorRunId: string) => Promise<void>;
}) {
  const executionCoordinator = options.state;
  const runStore = options.runStore;
  const activityHub = options.activityHub;
  const terminalSettlement = options.terminalSettlement;
  const now = options.now;
  const idFactory = options.idFactory;
  const activateSuccessor = options.activateSuccessor;

  function track(runId: string, operation: Promise<void>): void {
    executionCoordinator.startExecutionTask(runId, operation);
    const postExecution = operation.then(() => undefined, () => undefined).then(async () => {
      await activateSuccessor(runId);
      terminalSettlement.notifyStable(runId);
    });
    executionCoordinator.trackPostExecutionTask(postExecution);
  }

  function trackPostExecutionTask(task: Promise<void>): void {
    executionCoordinator.trackPostExecutionTask(task);
  }

  function start(runId: string): void {
    const controller = executionCoordinator.beginExecution(runId);
    track(runId, runExecution(runId, controller));
  }
  async function persistToolResult(runId: string, result: ToolCallResult): Promise<void> {
    await runStore.withExclusiveRun(runId, async () => {
      const current = await runStore.load(runId);
      if (current === undefined) return;
      const key = ordinaryToolResultKey(result);
      const invocationId = toolInvocationId(result);
      // Cancellation commits promptly, but an already executing tool may finish after
      // abort. Once accepted, the fact remains feature-owned after the controller
      // is released so terminal settlement can finish its durable write.
      if (current.state.status.kind !== "running" && !executionCoordinator.hasController(runId) &&
          !terminalSettlement.hasAcceptedToolResult(runId, invocationId)) return;
      const existing = current.state.toolCalls.find((item) => toolInvocationId(item) === invocationId);
      if (existing !== undefined) {
        if (existing.status !== "approval_required") {
          if (ordinaryToolResultKey(existing) === key && sameResultForIdempotency(existing, result)) {
            const reconciled = recordOrdinaryToolResult({ state: current.state, result, recordedAt: current.state.timestamps.updatedAt });
            if (reconciled === current.state) return;
            await runStore.savePublished(reconciled, current.revision);
            return;
          }
          throw new OrdinaryFeatureError(
            "ordinary_tool_result_conflict",
            `Ordinary run ${runId} already recorded a different result for tool invocation ${invocationId}`,
          );
        }
      }
      const recordedAt = current.state.toolResultRecordedAt[key] ?? now();
      const state = recordOrdinaryToolResult({ state: current.state, result, recordedAt });
      if (state === current.state) return;
      await runStore.savePublished(state, current.revision);
      if (result.status !== "approval_required") {
        activityHub.recordDurableToolResult(runId, result, recordedAt);
      }
    });
  }

  async function persistNestedToolRequests(
    runId: string,
    requests: readonly ToolCallRequest[],
  ): Promise<void> {
    if (requests.length === 0) return;
    await runStore.withExclusiveRun(runId, async () => {
      const current = await runStore.load(runId);
      if (current === undefined) {
        throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${runId} was not found`);
      }
      const state = recordOrdinaryNestedToolRequests({
        state: current.state,
        requests,
        recordedAt: now(),
      });
      if (state === current.state) return;
      await runStore.savePublished(state, current.revision);
    });
  }

  async function reconcilePendingToolRound(
    runId: string,
    reconcileOptions: { readonly persistState?: boolean } = {},
  ): Promise<OrdinaryRunState | undefined> {
    const persistState = reconcileOptions.persistState ?? true;
    return runStore.withExclusiveRun(runId, async () => {
      const current = await runStore.load(runId);
      if (current === undefined) return undefined;
      const recordedAt = now();
      let state = reconcileInterruptedOrdinaryNestedToolCalls({
        state: current.state,
        recordedAt,
      });
      const pending = state.pendingToolRound;
      let document = current;
      if (pending === undefined) {
        if (persistState && state !== current.state) {
          document = await runStore.savePublished(state, current.revision);
          activityHub.syncDurableToolResults(state);
        }
        return clone(state);
      }
      const orderedToolCalls = await options.sessionRepository.readToolCalls({
        sessionRef: state.sessionRef,
        assistantEntryRef: pending.assistantEntryRef,
      });
      state = reconcileInterruptedOrdinaryToolRound({ state, orderedToolCalls, recordedAt });
      if (persistState && state !== current.state) {
        document = await runStore.savePublished(state, current.revision);
        activityHub.syncDurableToolResults(state);
      }
      const rootResults = pending.invocationIds.map((invocationId) =>
        state.toolCalls.find((result) => toolInvocationId(result) === invocationId && result.parentInvocationId === undefined));
      if (rootResults.some((result) => result === undefined)) {
        throw new OrdinaryFeatureError(
          "ordinary_run_state_conflict",
          `Ordinary run ${runId} cannot reconcile a Session tool round without every root result`,
        );
      }
      const toolRoundLeafRef = await options.sessionRepository.reconcileToolResultEntries({
        sessionRef: state.sessionRef,
        assistantEntryRef: pending.assistantEntryRef,
        ...(state.session.phase === "rollbackable"
          ? { recoveryLeafRef: state.session.endLeafRef }
          : {}),
        orderedResults: rootResults as readonly ToolCallResult[],
      });
      if (!persistState) return clone(state);
      state = transitionOrdinaryRun({
        state,
        transition: {
          type: "record_session_checkpoint",
          checkpoint: {
            kind: "tool_result_entries_committed",
            sessionId: state.sessionRef.sessionId,
            toolRoundLeafRef,
            providerCallIds: rootResults.map((result) => result?.providerCallId ?? ""),
            invocationIds: pending.invocationIds,
          },
        },
        recordedAt: now(),
        eventId: idFactory("ordinary-event"),
      });
      if (persistState) {
        document = await runStore.savePublished(state, document.revision);
      }
      return clone(state);
    });
  }

  async function reconcileLostApprovalResults(runId: string): Promise<OrdinaryRunState | undefined> {
    return runStore.withExclusiveRun(runId, async () => {
      const current = await runStore.load(runId);
      if (current === undefined) return undefined;
      const closed = closeLostApprovalFacts(current.state);
      if (closed.toolCalls.length === 0) return clone(current.state);
      const recordedAt = now();
      let state = current.state;
      for (const result of closed.toolCalls) {
        state = recordOrdinaryToolResult({ state, result, recordedAt });
      }
      await runStore.savePublished(state, current.revision);
      activityHub.syncDurableToolResults(state);
      return clone(state);
    });
  }

  async function blockLostApproval(
    runId: string,
    reason: { readonly code: string; readonly message: string },
  ): Promise<OrdinaryRunState> {
    const reconciled = await reconcilePendingToolRound(runId, { persistState: false });
    const blocked = await runStore.withExclusiveRun(runId, async () => {
      const current = await runStore.load(runId);
      if (current === undefined) {
        throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${runId} was not found`);
      }
      if (current.state.status.kind !== "awaiting_approval") {
        throw new OrdinaryFeatureError(
          "ordinary_run_state_conflict",
          `Ordinary run ${runId} is not awaiting approval`,
        );
      }
      const recordedAt = now();
      let state = reconciled ?? current.state;
      const closed = closeLostApprovalFacts(state);
      for (const result of closed.toolCalls) {
        state = recordOrdinaryToolResult({ state, result, recordedAt });
      }
      state = transitionOrdinaryRun({
        state,
        transition: {
          type: "block",
          reason,
          continueBy: "new_turn",
        },
        recordedAt,
        eventId: idFactory("ordinary-event"),
      });
      await runStore.savePublished(state, current.revision);
      activityHub.syncDurableToolResults(state);
      activityHub.recordTransition(state.timeline.at(-1)!);
      return clone(state);
    });
    if (blocked.pendingToolRound === undefined && blocked.pendingNestedToolCalls === undefined) return blocked;
    return await reconcilePendingToolRound(runId) ?? blocked;
  }

  async function applyOutcome(runId: string, outcome: OrdinaryExecutionOutcome): Promise<void> {
    if (outcome.status === "approval_required") {
      let registered = false;
      try {
        registered = await runStore.withExclusiveRun(runId, async () => {
          const current = await runStore.load(runId);
          if (current === undefined || isTerminal(current.state)) return false;
          if (current.state.status.kind !== "running" || executionCoordinator.hasContinuation(runId)) {
            throw new OrdinaryFeatureError(
              "ordinary_run_state_conflict",
              `Ordinary run ${runId} cannot register a second live approval continuation`,
            );
          }
          const state = await runStore.mutateLocked(runId, {
            type: "request_approval",
            status: {
              kind: "awaiting_approval",
              confirmationRequests: outcome.confirmationRequests,
              continuationAvailability: "live_only",
            },
            session: outcome.session,
            toolCalls: outcome.toolCalls,
            usage: outcome.usage,
            toolMetrics: outcome.toolMetrics,
            capabilityResolution: outcome.capabilityResolution,
          });
          // The durable pause and its process-local handle are one admission fact.
          // Cancellation must either observe both inside this FIFO or win before both.
          if (state.status.kind !== "awaiting_approval") {
            throw new OrdinaryFeatureError(
              "ordinary_run_state_conflict",
              `Ordinary run ${runId} did not enter awaiting approval after accepting its continuation`,
            );
          }
          if (!executionCoordinator.registerApprovalContinuation(runId, outcome.continuation)) {
            throw new OrdinaryFeatureError(
              "ordinary_run_state_conflict",
              `Ordinary run ${runId} cannot register a second live approval continuation`,
            );
          }
          return true;
        });
      } catch (error) {
        await outcome.continuation.release().catch(() => undefined);
        throw error;
      }
      if (!registered) await outcome.continuation.release().catch(() => undefined);
      return;
    }
    const document = await runStore.load(runId);
    if (document === undefined || isTerminal(document.state)) return;
    if (outcome.status === "completed") {
      let state: OrdinaryRunState;
      try {
        state = await runStore.mutate(runId, { type: "complete", session: outcome.session, toolCalls: outcome.toolCalls, usage: outcome.usage, toolMetrics: outcome.toolMetrics, capabilityResolution: outcome.capabilityResolution });
      } catch (error) {
        throw new OrdinaryFeatureError(
          "ordinary_completion_commit_failed",
          "Model execution completed, but the terminal Ordinary snapshot could not be committed.",
          { cause: error },
        );
      }
      await terminalSettlement.finalizeSession(runId, state, false);
      return;
    }
    if (outcome.status === "cancelled") {
      const state = await runStore.mutate(runId, { type: "cancel", reason: outcome.reason, session: outcome.session, toolCalls: outcome.toolCalls, usage: outcome.usage, toolMetrics: outcome.toolMetrics, capabilityResolution: outcome.capabilityResolution });
      await terminalSettlement.finalizeSession(runId, state, true);
      return;
    }
    const state = await runStore.mutate(runId, { type: "fail", error: outcome.error, session: outcome.session, toolCalls: outcome.toolCalls, usage: outcome.usage, toolMetrics: outcome.toolMetrics, capabilityResolution: outcome.capabilityResolution });
    await terminalSettlement.finalizeSession(runId, state, true);
  }

  async function handleCompletedCommitFailure(
    runId: string,
    outcome: OrdinaryExecutionOutcome | undefined,
    error: unknown,
  ): Promise<boolean> {
    if (outcome?.status !== "completed" ||
        !(error instanceof OrdinaryFeatureError) ||
        error.code !== "ordinary_completion_commit_failed") {
      return false;
    }
    emitDiagnostic({ kind: "completion_commit_failed", runId, error });
    let latest = await runStore.load(runId);
    try {
      const persisted = await runStore.inspectPersisted(runId);
      if (persisted !== undefined && (latest === undefined || persisted.revision > latest.revision)) {
        await runStore.adoptPersisted(persisted);
        activityHub.syncDurableToolResults(persisted.state);
        const terminalEvent = persisted.state.timeline.at(-1);
        if (terminalEvent !== undefined && isTerminalEvent(terminalEvent)) activityHub.recordTransition(terminalEvent);
        latest = persisted;
      }
    } catch (refreshError) {
      emitDiagnostic({
        kind: "completion_commit_failed",
        runId,
        error: new AggregateError(
          [error, refreshError],
          `Ordinary run ${runId} could not verify whether its completed snapshot was committed`,
        ),
      });
    }
    if (latest === undefined || isTerminal(latest.state)) {
      // The repository may have committed before reporting a transport error.
      // Never rewrite an already-terminal fact in that case.
      if (latest?.state.status.kind === "completed") {
        await terminalSettlement.finalizeSession(runId, latest.state, false).catch(() => undefined);
      }
      if (latest !== undefined) {
        await activateSuccessor(runId);
        terminalSettlement.notifyStable(runId);
      }
      return true;
    }
    try {
      const acceptedCompletedSession = outcome.session.latestLeafRef === null
        ? outcome.session
        : { ...outcome.session, safeLeafRef: outcome.session.latestLeafRef };
      const blocked = await runStore.mutate(runId, {
        type: "block",
        reason: {
          code: "ordinary_completion_commit_failed",
          message: "模型执行已完成，但 Ordinary 终态无法写入。请发送新消息继续；系统不会将这次完成改写为失败。",
        },
        continueBy: "new_turn",
        session: acceptedCompletedSession,
        toolCalls: outcome.toolCalls,
      });
      // The Session already contains the completed assistant response. Keep that
      // leaf even though the Ordinary terminal snapshot had to record a block.
      await terminalSettlement.finalizeSession(runId, blocked, false).catch(() => undefined);
      await activateSuccessor(runId);
    } catch (blockError) {
      emitDiagnostic({ kind: "completion_commit_failed", runId, error: blockError });
    }
    return true;
  }

  function emitDiagnostic(diagnostic: OrdinaryFeatureDiagnostic): void {
    options.emitDiagnostic(diagnostic);
  }

  function bindToolInvocations(
    runId: string,
    turn: OrdinaryRunTurn,
    providerCalls: readonly ProviderToolCall[],
  ): Promise<AcceptedToolInvocation[]> {
    const document = runStore.cached(runId);
    const conversationId = document?.state.turn.conversationId ?? turn.conversationId;
    const bound: AcceptedToolInvocation[] = providerCalls.map((call) => {
      const invocationId = createStableInvocationId({
        runId,
        roundId: call.roundId,
        providerCallId: call.providerCallId,
      });
      return {
        providerCallId: call.providerCallId,
        toolName: call.toolName,
        input: call.input,
        roundId: call.roundId,
        invocationId,
      };
    });
    // No durable write here; the assistant_tool_call_entry_committed checkpoint
    // commits the canonical ordering and the pendingToolRound holds the ids.
    void conversationId;
    return Promise.resolve(bound);
  }

  function bindNestedToolInvocations(
    runId: string,
    providerCalls: readonly ProviderToolCall[],
  ): Promise<AcceptedToolInvocation[]> {
    const bound: AcceptedToolInvocation[] = providerCalls.map((call) => {
      const parentInvocationId = call.parentInvocationId;
      if (parentInvocationId === undefined) {
        throw new OrdinaryFeatureError(
          "ordinary_tool_result_conflict",
          `Ordinary run ${runId} received a nested provider call without a parent invocation id.`,
        );
      }
      return {
        providerCallId: call.providerCallId,
        toolName: call.toolName,
        input: call.input,
        roundId: call.roundId,
        invocationId: createStableInvocationId({
          runId,
          roundId: call.roundId,
          parentInvocationId,
          providerCallId: call.providerCallId,
        }),
        parentInvocationId,
      };
    });
    return Promise.resolve(bound);
  }

  async function runExecution(runId: string, controller: AbortController): Promise<void> {
    let outcome: OrdinaryExecutionOutcome | undefined;
    let admitted = false;
    try {
      const document = await runStore.load(runId);
      if (document === undefined || document.state.status.kind !== "running") return;
      admitted = true;
      const sessionRef = document.state.sessionRef;
      terminalSettlement.markSessionAwaitingFinalization(runId);
      activityHub.recordModelRequest(runId, "initial");
      outcome = await options.execution.execute({
        runId,
        conversationId: document.state.turn.conversationId,
        sessionRef,
        birth: document.state.birth,
        runInput: document.state.input,
        abortSignal: controller.signal,
        onModelContent: (event) => event.kind === "text"
          ? activityHub.recordOutputDelta(runId, event.contentIndex, event.content)
          : event.phase === "delta"
            ? activityHub.recordReasoningDelta(runId, event.contentIndex, event.content)
            : activityHub.completeReasoning(runId, event.contentIndex, event.content),
        acceptToolInvocations: (providerCalls) => bindToolInvocations(runId, document.state.turn, providerCalls),
        acceptNestedToolInvocations: (providerCalls) => bindNestedToolInvocations(runId, providerCalls),
        onToolRequested: (request) => activityHub.recordToolRequested(runId, request),
        onNestedToolRequestsAccepted: (requests) => persistNestedToolRequests(runId, requests),
        onToolProgress: (progress) => activityHub.recordToolProgress(runId, progress),
        onSessionWriteCheckpoint: async (checkpoint) => {
          let assistantText: string | undefined;
          if (checkpoint.kind === "assistant_tool_call_entry_committed" ||
              checkpoint.kind === "assistant_response_entry_committed") {
            const entry = (await options.sessionRepository.readAssistantEntries({
              sessionRef,
              entryRefs: [checkpoint.assistantEntryRef],
            }))[0];
            if (entry === undefined) {
              throw new OrdinaryFeatureError(
                "ordinary_run_state_conflict",
                "Committed assistant Session entry could not be read",
              );
            }
            assistantText = entry.text;
          }
          await runStore.mutate(runId, {
            type: "record_session_checkpoint",
            checkpoint,
            modelRequestId: activityHub.currentModelRequestId(runId),
            assistantText,
          });
        },
        onToolResult: async (result) => {
          terminalSettlement.rememberToolResults(runId, [result]);
          await persistToolResult(runId, result);
          terminalSettlement.forgetPersistedToolResults(runId, [result]);
          if (result.status !== "approval_required" && result.parentInvocationId === undefined) {
            activityHub.recordModelRequest(runId, "after_tool");
          }
        },
      });
      await activityHub.completeReasoning(runId);
      terminalSettlement.rememberToolResults(runId, outcome.toolCalls);
      await applyOutcome(runId, outcome);
      terminalSettlement.forgetPersistedToolResults(runId, outcome.toolCalls);
    } catch (error) {
      if (await handleCompletedCommitFailure(runId, outcome, error)) return;
      let failure = error;
      try {
        await activityHub.completeReasoning(runId);
      } catch (reasoningError) {
        failure = reasoningError;
      }
      const latest = await runStore.load(runId);
      if (latest !== undefined && !isTerminal(latest.state)) {
        const terminal = await runStore.mutate(runId, {
          type: controller.signal.aborted ? "cancel" : "fail",
          ...(controller.signal.aborted
            ? { reason: cancellationReason(controller.signal.reason) }
            : { error: ordinaryExecutionFailureFacts(failure) }),
          ...(outcome === undefined
            ? {}
            : {
                session: outcome.session,
                toolCalls: outcome.toolCalls,
                usage: outcome.usage,
                toolMetrics: outcome.toolMetrics,
                capabilityResolution: outcome.capabilityResolution,
              }),
        } as OrdinaryRunTransition, { keepTerminal: controller.signal.aborted });
        await terminalSettlement.finalizeSession(runId, terminal, true);
      }
    } finally {
      try {
        if (admitted) await terminalSettlement.settleExecution(runId);
      } finally {
        // A live approval continuation resumes the same Pi harness. Keep its
        // original controller so cancellation and late tool facts remain tied
        // to the run until that harness actually reaches a terminal outcome.
        if (outcome?.status !== "approval_required" && executionCoordinator.controller(runId) === controller) {
          executionCoordinator.removeController(runId, controller);
        }
      }
    }
  }

  async function cancel(runId: string, reason = "cancelled_by_user"): Promise<OrdinaryRunState> {
    const cancellation = await runStore.withExclusiveRun(runId, async () => {
      const current = await runStore.load(runId);
      if (current === undefined) {
        throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${runId} was not found`);
      }
      const wasTerminal = isTerminal(current.state);
      // Persisting the terminal fact is the cancellation linearization point.
      // A failed save must leave both the durable run and live execution active.
      const state = wasTerminal
        ? clone(current.state)
        : await runStore.mutateLocked(runId, { type: "cancel", reason }, { keepTerminal: true });
      executionCoordinator.abortController(runId, reason);
      const continuation = executionCoordinator.takeContinuation(runId);
      return {
        state,
        continuation,
        finalizeSession: !wasTerminal || terminalSettlement.isFinalizationPending(runId),
      };
    });
    scheduleCancellationCleanup(runId, cancellation.state, cancellation.finalizeSession, cancellation.continuation);
    return clone(cancellation.state);
  }

  function scheduleCancellationCleanup(
    runId: string,
    state: OrdinaryRunState,
    finalizeSession: boolean,
    continuation: OrdinaryExecutionContinuation | undefined,
  ): void {
    if (options.isReleased()) {
      executionCoordinator.retainCancellationContinuation(runId, continuation);
      return;
    }
    executionCoordinator.startCancellationCleanup(runId, continuation, async () => {
      try {
        await executionCoordinator.releaseCancellationContinuation(runId);
      } catch (error) {
        emitDiagnostic({ kind: "cancellation_cleanup_failed", runId, phase: "continuation_release", error });
        return;
      }
      executionCoordinator.releaseControllerIfIdle(runId);
      if (finalizeSession) {
        try {
          await terminalSettlement.finalizeSession(runId, state, state.status.kind !== "completed");
        } catch {
          return;
        }
      }
      const stillHasLiveExecution = executionCoordinator.hasLiveExecution(runId);
      if (!stillHasLiveExecution) {
        try {
          await terminalSettlement.settleExecution(runId);
        } catch (error) {
          emitDiagnostic({ kind: "cancellation_cleanup_failed", runId, phase: "terminal_settlement", error });
          return;
        }
      }
      await activateSuccessor(runId);
      terminalSettlement.notifyStable(runId);
    });
  }

  async function decideApproval(input: DecideOrdinaryApprovalInput): Promise<OrdinaryRunState> {
    const ownerRunId = input.ownerRunId;
    const decision: ConfirmationDecision = {
      confirmationId: input.confirmationId,
      decision: input.decision,
      decidedAt: input.decidedAt,
      ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
    };
    let approvalLease: OrdinaryApprovalDecisionLease | undefined;
    const reserved = await runStore.withExclusiveRun(ownerRunId, async () => {
      const document = await runStore.load(ownerRunId);
      if (document === undefined) {
        throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${ownerRunId} was not found`);
      }
      if (document.state.status.kind !== "awaiting_approval") {
        throw new OrdinaryFeatureError(
          "ordinary_run_state_conflict",
          `Ordinary run ${ownerRunId} is not awaiting approval`,
        );
      }
      if (!document.state.status.confirmationRequests.some((request) => request.confirmationId === decision.confirmationId)) {
        throw new OrdinaryFeatureError(
          "ordinary_confirmation_not_found",
          `Confirmation ${decision.confirmationId} does not belong to Ordinary run ${ownerRunId}`,
        );
      }
      const acquisition = executionCoordinator.beginApprovalDecision(ownerRunId, decision.confirmationId);
      if (acquisition.status === "busy") {
        throw new OrdinaryFeatureError(
          "ordinary_confirmation_in_progress",
          `A confirmation decision is already in progress for Ordinary run ${ownerRunId}`,
        );
      }
      if (acquisition.status === "continuation_missing") {
        return clone(document.state);
      }
      approvalLease = acquisition.lease;
      try {
        return await runStore.mutateLocked(ownerRunId, { type: "approval_decided", decision });
      } catch (error) {
        executionCoordinator.rollbackApprovalDecision(acquisition.lease);
        approvalLease = undefined;
        throw error;
      }
    });
    if (approvalLease === undefined) {
      const blocked = await blockLostApproval(ownerRunId, {
          code: "confirmation_continuation_lost",
          message: "The live confirmation continuation is no longer available.",
      });
      await activateSuccessor(ownerRunId);
      terminalSettlement.notifyStable(ownerRunId);
      return blocked;
    }
    const operation = (async () => {
      let outcome: OrdinaryExecutionOutcome | undefined;
      try {
        activityHub.recordModelRequest(ownerRunId, "after_approval");
        outcome = await approvalLease.continuation.decide({ decision, abortSignal: approvalLease.controller.signal });
        await activityHub.completeReasoning(ownerRunId);
        terminalSettlement.rememberToolResults(ownerRunId, outcome.toolCalls);
        await applyOutcome(ownerRunId, outcome);
        terminalSettlement.forgetPersistedToolResults(ownerRunId, outcome.toolCalls);
      } catch (error) {
        if (await handleCompletedCommitFailure(ownerRunId, outcome, error)) return;
        let failure = error;
        try {
          await activityHub.completeReasoning(ownerRunId);
        } catch (reasoningError) {
          failure = reasoningError;
        }
        const latest = await runStore.load(ownerRunId);
        if (latest !== undefined && !isTerminal(latest.state)) {
          const terminal = await runStore.mutate(ownerRunId, {
            type: approvalLease.controller.signal.aborted ? "cancel" : "fail",
            ...(approvalLease.controller.signal.aborted
              ? { reason: cancellationReason(approvalLease.controller.signal.reason) }
              : { error: ordinaryExecutionFailureFacts(failure) }),
            ...(outcome === undefined
              ? {}
              : {
                  toolCalls: outcome.toolCalls,
                  usage: outcome.usage,
                  toolMetrics: outcome.toolMetrics,
                  capabilityResolution: outcome.capabilityResolution,
                }),
          } as OrdinaryRunTransition, { keepTerminal: approvalLease.controller.signal.aborted });
          await terminalSettlement.finalizeSession(ownerRunId, terminal, true);
        }
      } finally {
        try {
          await terminalSettlement.settleExecution(ownerRunId);
        } finally {
          executionCoordinator.finishApprovalDecision(
            approvalLease,
            outcome?.status === "approval_required",
          );
        }
      }
    })();
    track(ownerRunId, operation);
    return reserved;
  }

  function closeLostApprovalFacts(state: OrdinaryRunState): {
    readonly toolCalls: readonly ToolCallResult[];
  } {
    const closedResults = state.toolCalls
      .filter((result) => result.status === "approval_required")
      .map((result): ToolCallResult => interruptedOrdinaryApprovalResult(
        state,
        result as ToolCallResult & { readonly status: "approval_required" },
      ));
    return { toolCalls: closedResults };
  }


  return {
    persistToolResult,
    persistNestedToolRequests,
    reconcilePendingToolRound,
    reconcileLostApprovalResults,
    blockLostApproval,
    start,
    cancel,
    decideApproval,
  };
}

function clone<T>(value: T): T {
  return globalThis.structuredClone(value);
}
