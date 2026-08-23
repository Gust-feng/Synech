import { createHash } from "node:crypto";
import type { ConfirmationDecision } from "../../domain/confirmation/index.js";
import { memoryOwnerKey, memoryOwnersForConversation } from "../../domain/memory/index.js";
import {
  toolCallFactId,
  type ToolCallProgress,
  type ToolCallRequest,
  type ToolCallResult,
} from "../../domain/tools/index.js";
import { createId, nowIso, type IdFactory } from "../../kernel/id.js";
import type {
  DecideOrdinaryApprovalInput,
  OrdinaryAgentFeature,
  OrdinaryStableTerminalRunFacts,
  OrdinaryConversationControlDocument,
  OrdinaryConversationControlRepository,
  OrdinaryConversationControlState,
  OrdinaryConversationReadModel,
  OrdinaryExecutionContinuation,
  OrdinaryExecutionOutcome,
  OrdinaryExecutionPort,
  OrdinaryFeatureDiagnostic,
  OrdinaryRunActivity,
  OrdinaryRunActivityCursor,
  OrdinaryRunActivityReplay,
  OrdinaryRunEvent,
  OrdinaryRunRepository,
  OrdinaryRunRecoveryInventory,
  OrdinaryRunSnapshotDocument,
  OrdinaryRunState,
  OrdinaryRunInput,
  OrdinaryMemoryFact,
  OrdinaryMemoryFactRepository,
  OrdinaryConversationTitleGenerator,
  StartOrdinaryRunInput,
  SubmitOrdinaryTurnInput,
  SubmitOrdinaryTurnResult,
} from "./contracts.js";
import { OrdinaryFeatureError } from "./contracts.js";
import { executionErrorFacts } from "../execution-errors/index.js";
import type { AgentSessionEntryRef, AgentSessionRef, AgentSessionRepository } from "../model-runtime/agent-session.js";
import {
  normalizeOrdinaryConversationTitle,
  projectOrdinaryConversation,
  visibleOrdinaryConversationRuns,
} from "./conversation-projection.js";
import {
  createInitialOrdinaryRunState,
  interruptedOrdinaryApprovalResult,
  ordinaryToolResultKey,
  recordOrdinaryNestedToolRequests,
  recordOrdinaryToolResult,
  reconcileInterruptedOrdinaryNestedToolCalls,
  reconcileInterruptedOrdinaryToolRound,
  transitionOrdinaryRun,
  type OrdinaryRunTransition,
} from "./state.js";
import {
  OrdinaryManagedAttachmentRepositoryError,
  type OrdinaryManagedAttachmentRecord,
  type OrdinaryManagedAttachmentRepository,
} from "./managed-attachment-repository.js";
import {
  managedUploadAttachmentId,
  managedUploadAttachmentRef,
} from "../context/attachments.js";
import { createInMemoryOrdinaryMemoryFactRepository } from "./memory-fact-repository.js";

export function createOrdinaryAgentFeature(input: {
  readonly repository: OrdinaryRunRepository;
  readonly conversationRepository: OrdinaryConversationControlRepository;
  readonly execution: OrdinaryExecutionPort;
  readonly sessionRepository: AgentSessionRepository;
  readonly releaseToolEvidenceOwner?: (ownerId: string) => void | Promise<void>;
  readonly managedAttachmentRepository?: OrdinaryManagedAttachmentRepository;
  readonly managedAttachmentInstanceId?: string;
  /** Durable Ordinary-owned read/reference facts for memory tools. */
  readonly memoryFactRepository?: OrdinaryMemoryFactRepository;
  /**
   * Host-provided neutral model capability for conversation title generation
   * (ADR：UI 摘要字段）。未接线时列表继续使用首条消息截断回退。
   */
  readonly generateConversationTitle?: OrdinaryConversationTitleGenerator;
  /**
   * Observability hook for failures that never rewrite committed run facts but
   * would otherwise be invisible: Session finalization failures that keep the
   * conversation queue paused, and startup recovery marking a conversation
   * unavailable. Never called for normal run failures (those are run facts).
   */
  readonly onDiagnostic?: (diagnostic: OrdinaryFeatureDiagnostic) => void;
  readonly now?: () => string;
  readonly idFactory?: IdFactory;
}): OrdinaryAgentFeature {
  const visibleAssistantCheckpointIntervalMs = 250;
  const now = input.now ?? nowIso;
  const idFactory = input.idFactory ?? createId;
  const memoryFactRepository = input.memoryFactRepository ?? createInMemoryOrdinaryMemoryFactRepository();
  if ((input.managedAttachmentRepository === undefined) !== (input.managedAttachmentInstanceId === undefined)) {
    throw new Error("Ordinary managed attachment repository and instance identity must be configured together.");
  }
  const documents = new Map<string, OrdinaryRunSnapshotDocument>();
  const conversationDocuments = new Map<string, OrdinaryConversationControlDocument>();
  const unavailableConversationIds = new Set<string>();
  const continuations = new Map<string, OrdinaryExecutionContinuation>();
  const approvalReservations = new Map<string, string>();
  const controllers = new Map<string, AbortController>();
  const executions = new Map<string, Promise<void>>();
  const acceptedToolResults = new Map<string, Map<string, ToolCallResult>>();
  const postExecutionTasks = new Set<Promise<void>>();
  const mutationQueues = new Map<string, Promise<void>>();
  const activityStreams = new Map<string, { streamId: string; nextSequence: number; activities: OrdinaryRunActivity[] }>();
  const listeners = new Map<string, Set<(activity: OrdinaryRunActivity) => void>>();
  const stableTerminalListeners = new Set<(runId: string) => void>();
  const activeModelRequestIds = new Map<string, string>();
  const reasoningBuffers = new Map<string, { readonly modelRequestId: string; content: string }>();
  const sessionsAwaitingFinalization = new Set<string>();
  const sessionFinalizationPending = new Set<string>();
  const sessionFinalizationFailures = new Map<string, unknown>();
  const sessionFinalizationRetries = new Map<string, Promise<void>>();
  const completionCommitRetryTimers = new Map<string, NodeJS.Timeout>();
  const completionCommitRetryCounts = new Map<string, number>();
  const successorActivationPumps = new Map<string, {
    diagnosticRunId: string;
    inFlight?: Promise<void>;
    retryTimer?: NodeJS.Timeout;
    consecutiveFailures: number;
  }>();
  const cancellationCleanupTasks = new Map<string, Promise<void>>();
  const cancellationCleanupContinuations = new Map<string, OrdinaryExecutionContinuation>();
  const cancellationCleanupRetryTimers = new Map<string, NodeJS.Timeout>();
  const cancellationCleanupFailureCounts = new Map<string, number>();
  const conversationCleanupTasks = new Map<string, Promise<void>>();
  const conversationCleanupRetryTimers = new Map<string, NodeJS.Timeout>();
  const conversationCleanupFailureCounts = new Map<string, number>();
  const pendingUncommittedConversationCleanups = new Map<string, {
    readonly control: OrdinaryConversationControlDocument;
    readonly runIds: readonly string[];
  }>();
  const pendingUncommittedConversationBirths = new Map<string, {
    readonly sessionRef: AgentSessionRef;
  }>();
  const managedAttachmentClaimRollbacks = new Map<string, ManagedAttachmentClaimRollback>();
  const managedAttachmentClaimRollbackTasks = new Map<string, Promise<void>>();
  const managedAttachmentClaimRollbackRetryTimers = new Map<string, NodeJS.Timeout>();
  const managedAttachmentClaimRollbackFailureCounts = new Map<string, number>();
  const visibleAssistantBuffers = new Map<string, string>();
  const visibleAssistantCheckpointTimers = new Map<string, NodeJS.Timeout>();
  // 每次会话只有一次生成机会：无论成败都记录，重启后首轮已完成也不会再触发。
  const autoTitleAttemptedConversationIds = new Set<string>();
  let startupRunEnumerationFailed = false;
  let released = false;
  let releasePromise: Promise<void> | undefined;
  /**
   * Distinguishes terminal replay streams across feature instances. Cursors are
   * process-lifetime handles: a restarted process must answer an old cursor with
   * the reset protocol, exactly like the mutable streams whose random streamIds
   * never repeat across restarts.
   */
  const streamEpoch = idFactory("ordinary-activity-stream");

  const readyPromise = recoverFeatureState();
  // Observe eager recovery immediately; public calls still await the original rejected promise.
  void readyPromise.catch(() => undefined);

  async function recoverFeatureState(): Promise<void> {
    await recoverPersistedRuns();
  }

  async function recoverPersistedRuns(): Promise<void> {
    let conversationSummaries: readonly Awaited<ReturnType<OrdinaryConversationControlRepository["list"]>>[number][] = [];
    try {
      conversationSummaries = await input.conversationRepository.list(Number.MAX_SAFE_INTEGER);
    } catch (error) {
      emitDiagnostic({ kind: "startup_recovery_failed", source: "conversation_repository", error });
    }
    for (const summary of conversationSummaries) {
      try {
        const document = await input.conversationRepository.get(summary.conversationId);
        if (document !== undefined) conversationDocuments.set(summary.conversationId, document);
      } catch (error) {
        markConversationUnavailable(summary.conversationId, error);
      }
    }
    let runSummaries: OrdinaryRunRecoveryInventory["summaries"] = [];
    try {
      const inventory = await input.repository.inspectRecoveryInventory();
      runSummaries = inventory.summaries;
      if (inventory.issues.length > 0) {
        startupRunEnumerationFailed = true;
        emitDiagnostic({
          kind: "startup_recovery_failed",
          source: "run_repository",
          error: new AggregateError(
            inventory.issues.map((issue) => issue.error),
            `Ordinary run recovery inventory is incomplete: ${inventory.issues.map((issue) => issue.runId).join(", ")}`,
          ),
        });
      }
    } catch (error) {
      startupRunEnumerationFailed = true;
      emitDiagnostic({ kind: "startup_recovery_failed", source: "run_repository", error });
    }
    for (const summary of runSummaries) {
      if (conversationDocuments.has(summary.conversationId)) continue;
      markConversationUnavailable(
        summary.conversationId,
        new Error("Conversation control document is missing; the run was isolated from recovery."),
      );
    }
    if (!startupRunEnumerationFailed) {
      for (const [conversationId, control] of [...conversationDocuments]) {
        if (control.state.deletedAt !== undefined ||
            runSummaries.some((summary) => summary.conversationId === conversationId)) continue;
        await scheduleConversationCleanup(conversationId, control, [], "delete_uncommitted");
      }
    }
    const deletedConversationIds = new Set<string>();
    for (const control of conversationDocuments.values()) {
      if (control.state.deletedAt === undefined) continue;
      deletedConversationIds.add(control.state.conversationId);
      const runIds = runSummaries
        .filter((summary) => summary.conversationId === control.state.conversationId)
        .map((summary) => summary.runId);
      await scheduleConversationCleanup(control.state.conversationId, control, runIds);
    }

    for (const summary of runSummaries) {
      if (unavailableConversationIds.has(summary.conversationId)) continue;
      if (deletedConversationIds.has(summary.conversationId)) continue;
      try {
        let document = await input.repository.get(summary.runId);
        if (document === undefined) continue;
        // Cache the durable run before Session recovery so an unavailable transcript
        // cannot force unrelated conversations to reopen this run during startup.
        documents.set(summary.runId, document);
        // Settled terminal runs receive no further activities; their streams are
        // pure projections of the persisted timeline and are rebuilt on demand by
        // replay (which passes the rebuild inputs). Materializing them here would
        // duplicate every historical run's timeline in memory for the whole
        // process lifetime. Runs that still need recovery below (pending tool
        // rounds, lost approvals) keep an eager stream because those paths append
        // activities through bare streamFor(runId), which must not start empty.
        if (needsLiveActivityStream(document.state)) {
          await restorePersistedActivityStream(document.state);
        }
        if (document.state.status.kind === "awaiting_approval") {
          await blockLostApproval(summary.runId, {
            code: "confirmation_continuation_lost",
            message: "The live confirmation continuation was lost when the process restarted.",
          });
          continue;
        }
        if (document.state.pendingToolRound !== undefined ||
            document.state.pendingNestedToolCalls !== undefined) {
          await reconcilePendingToolRound(summary.runId);
          document = await load(summary.runId);
          if (document === undefined) continue;
        }
        if (document.state.toolCalls.some((result) => result.status === "approval_required")) {
          await reconcileLostApprovalResults(summary.runId);
          document = await load(summary.runId);
          if (document === undefined) continue;
        }
        if (document.state.status.kind === "running") {
          const unknownToolOutcome = document.state.toolCalls.some((result) =>
            result.errorFacts?.code === "tool_execution_outcome_unknown");
          await mutate(summary.runId, {
            type: "block",
            reason: {
              code: unknownToolOutcome ? "tool_execution_outcome_unknown" : "execution_continuation_lost",
              message: unknownToolOutcome
                ? "The process restarted before at least one tool outcome could be determined. The call was not replayed."
                : "The live execution was interrupted when the process restarted.",
            },
            continueBy: "new_turn",
          });
        }
      } catch (error) {
        markConversationUnavailable(summary.conversationId, error);
      }
    }
    await reconcileRecoveredSessionBranches();
    await recoverManagedAttachments();
    for (const [conversationId, control] of conversationDocuments) {
      if (control.state.deletedAt !== undefined) continue;
      try {
        if (await conversationView(control) === undefined) {
          markConversationUnavailable(conversationId);
        }
      } catch (error) {
        // Unsupported or incomplete Session branches remain on disk for diagnosis, but
        // cannot make unrelated conversations or new tasks unavailable.
        markConversationUnavailable(conversationId, error);
      }
    }
    for (const document of [...documents.values()]) {
      if (document.state.status.kind !== "queued") continue;
      const conversationId = document.state.turn.conversationId;
      if (unavailableConversationIds.has(conversationId)) continue;
      try {
        if (document.state.turn.predecessorRunId === undefined) {
          await activateRootQueued(document.state.runId);
          continue;
        }
        const predecessor = documents.get(document.state.turn.predecessorRunId);
        if (predecessor === undefined) {
          await mutate(document.state.runId, {
            type: "block",
            reason: {
              code: "predecessor_run_unavailable",
              message: "The predecessor run is unavailable or incompatible. This queued run was not started.",
            },
            continueBy: "new_turn",
          });
        } else if (isTerminal(predecessor.state)) {
          await activateSuccessor(predecessor.state.runId);
        }
      } catch (error) {
        markConversationUnavailable(conversationId, error);
      }
    }
  }

  async function reconcileRecoveredSessionBranches(): Promise<void> {
    for (const [conversationId, control] of conversationDocuments) {
      if (control.state.deletedAt !== undefined || unavailableConversationIds.has(conversationId)) continue;
      const runs = [...documents.values()]
        .map((document) => document.state)
        .filter((run) => run.turn.conversationId === conversationId);
      if (runs.length === 0) continue;
      try {
        const activeBranch = await input.sessionRepository.getActiveBranchEntryRefs(control.state.sessionRef);
        const target = recoveredSessionLeaf(runs, activeBranch, conversationId);
        const activeLeaf = activeBranch.at(-1) ?? null;
        if (sameSessionEntryRef(activeLeaf, target)) continue;
        const restored = await input.sessionRepository.moveActiveLeaf(control.state.sessionRef, target);
        if (!sameSessionEntryRef(restored, target)) {
          throw new OrdinaryFeatureError(
            "ordinary_run_state_conflict",
            `Ordinary conversation ${conversationId} Session did not restore its persisted safe leaf`,
          );
        }
      } catch (error) {
        markConversationUnavailable(conversationId, error);
      }
    }
  }

  async function recoverManagedAttachments(): Promise<void> {
    if (input.managedAttachmentRepository === undefined || input.managedAttachmentInstanceId === undefined) return;
    const attachmentIdsByConversation = new Map<string, Set<string>>();
    const preserveConversationIds = new Set(unavailableConversationIds);
    if (startupRunEnumerationFailed) {
      for (const conversationId of conversationDocuments.keys()) preserveConversationIds.add(conversationId);
    }
    for (const document of documents.values()) {
      const conversationId = document.state.turn.conversationId;
      const control = conversationDocuments.get(conversationId);
      if (control === undefined) {
        preserveConversationIds.add(conversationId);
        continue;
      }
      if (control.state.deletedAt !== undefined) continue;
      const ids = attachmentIdsByConversation.get(conversationId) ?? new Set<string>();
      for (const attachmentId of managedAttachmentIds(document.state.input)) ids.add(attachmentId);
      attachmentIdsByConversation.set(conversationId, ids);
    }
    try {
      const recovered = await input.managedAttachmentRepository.recoverAtStartup({
        activeInstanceId: input.managedAttachmentInstanceId,
        durableClaims: [...attachmentIdsByConversation].map(([conversationId, attachmentIds]) => ({
          conversationId,
          attachmentIds: [...attachmentIds],
        })),
        preserveConversationIds: [...preserveConversationIds],
      });
      for (const issue of recovered.issues) {
        emitDiagnostic({
          kind: "managed_attachment_recovery_issue",
          identity: issue.identity,
          error: issue.error,
        });
      }
    } catch (error) {
      emitDiagnostic({ kind: "managed_attachment_recovery_issue", error });
    }
  }

  function markConversationUnavailable(conversationId: string, error?: unknown): void {
    conversationDocuments.delete(conversationId);
    if (unavailableConversationIds.has(conversationId)) return;
    unavailableConversationIds.add(conversationId);
    emitDiagnostic({ kind: "conversation_unavailable", conversationId, ...(error === undefined ? {} : { error }) });
  }

  async function loadConversationControl(conversationId: string): Promise<OrdinaryConversationControlDocument | undefined> {
    if (unavailableConversationIds.has(conversationId)) return undefined;
    const cached = conversationDocuments.get(conversationId);
    if (cached !== undefined) return cached;
    const document = await input.conversationRepository.get(conversationId);
    if (document !== undefined) conversationDocuments.set(conversationId, document);
    return document;
  }

  async function load(runId: string): Promise<OrdinaryRunSnapshotDocument | undefined> {
    const cached = documents.get(runId);
    if (cached !== undefined) return cached;
    if (startupRunEnumerationFailed) return undefined;
    const document = await input.repository.get(runId);
    if (document !== undefined) {
      // Settled terminal runs get their stream lazily from replay; runs that may
      // still append activities (live, pending round, lost approval) need it now.
      if (needsLiveActivityStream(document.state)) {
        await restorePersistedActivityStream(document.state);
      }
      documents.set(runId, document);
    }
    return document;
  }

  /** A run can still append activities while live or until its recovery paths settle. */
  function needsLiveActivityStream(state: OrdinaryRunState): boolean {
    return !isTerminal(state) ||
      state.pendingToolRound !== undefined ||
      state.pendingNestedToolCalls !== undefined ||
      state.toolCalls.some((result) => result.status === "approval_required");
  }

  /**
   * Ephemeral replay projection for a settled terminal run. The activities are a
   * pure function of the persisted document, so the streamId can be derived
   * deterministically from the run identity and revision: repeated replays stay
   * cursor-compatible with each other without pinning the stream in memory, and
   * a later revision (delete + recreate) naturally invalidates old cursors.
   *
   * The id is additionally scoped by a per-feature-instance epoch so cursors do
   * NOT survive process restarts: reconnecting clients must keep receiving the
   * established `run.stream.reset` + full terminal replay contract instead of a
   * silently empty stream. Memory eviction must not change the HTTP protocol.
   */
  async function terminalReplayStream(document: OrdinaryRunSnapshotDocument): Promise<{
    streamId: string;
    nextSequence: number;
    activities: OrdinaryRunActivity[];
  }> {
    const assistantEntries = await readRunAssistantEntries(document.state);
    const replay = durableOrdinaryRunReplayFromState(document.state, assistantEntries);
    return {
      streamId: `${streamEpoch}:terminal:${document.state.runId}:${document.revision}`,
      nextSequence: replay.activities.length + 1,
      activities: [...replay.activities],
    };
  }

  async function readRunAssistantEntries(state: OrdinaryRunState) {
    const entryRefs = state.timeline.flatMap((event) =>
      event.type === "model.output.completed" ? [event.assistantEntryRef] : []);
    if (entryRefs.length === 0) return [];
    return input.sessionRepository.readAssistantEntries({
      sessionRef: state.sessionRef,
      entryRefs,
    });
  }

  async function restorePersistedActivityStream(state: OrdinaryRunState) {
    const existing = activityStreams.get(state.runId);
    if (existing !== undefined) return existing;
    const replay = durableOrdinaryRunReplayFromState(state, await readRunAssistantEntries(state));
    return streamFor(state.runId, replay.activities);
  }

  async function enqueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(runId) ?? Promise.resolve();
    let resolveCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
    const tail = previous.then(() => current, () => current);
    mutationQueues.set(runId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      resolveCurrent();
      if (mutationQueues.get(runId) === tail) mutationQueues.delete(runId);
    }
  }

  async function mutate(
    runId: string,
    transition: OrdinaryRunTransition,
    options: { readonly keepTerminal?: boolean } = {},
  ): Promise<OrdinaryRunState> {
    return enqueue(runId, () => commitTransition(runId, transition, options));
  }

  async function commitTransition(
    runId: string,
    transition: OrdinaryRunTransition,
    options: { readonly keepTerminal?: boolean } = {},
  ): Promise<OrdinaryRunState> {
    const current = await load(runId);
    if (current === undefined) {
      throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${runId} was not found`);
    }
    if (options.keepTerminal === true && isTerminal(current.state)) return clone(current.state);
    const visibleAssistantText = visibleAssistantBuffers.get(runId);
    const state = transitionOrdinaryRun({
      state: visibleAssistantText === undefined || visibleAssistantText === current.state.visibleAssistantText
        ? current.state
        : { ...current.state, visibleAssistantText },
      transition,
      recordedAt: now(),
      eventId: idFactory("ordinary-event"),
    });
    const saved = await input.repository.save(state, current.revision);
    documents.set(runId, saved);
    syncDurableToolResults(state);
    if (state.timeline.length > current.state.timeline.length) {
      recordTransition(
        state.timeline.at(-1)!,
        transition.type === "record_session_checkpoint" ? transition.assistantText : undefined,
      );
    }
    return clone(state);
  }

  function emit(activity: OrdinaryRunActivity): void {
    for (const listener of listeners.get(activity.runId) ?? []) {
      try { listener(clone(activity)); }
      catch { /* A projection subscriber cannot roll back an already committed feature fact. */ }
    }
  }

  function streamFor(
    runId: string,
    durableActivities: readonly OrdinaryRunActivity[] = [],
  ): {
    streamId: string;
    nextSequence: number;
    activities: OrdinaryRunActivity[];
  } {
    const existing = activityStreams.get(runId);
    if (existing !== undefined) return existing;
    const activities = [...durableActivities];
    const created = { streamId: idFactory("ordinary-activity-stream"), nextSequence: activities.length + 1, activities };
    activityStreams.set(runId, created);
    return created;
  }

  function recordTransition(event: OrdinaryRunEvent, assistantText?: string): void {
    const stream = streamFor(event.runId);
    if (event.type === "model.output.completed") {
      if (assistantText === undefined) {
        throw new OrdinaryFeatureError(
          "ordinary_run_state_conflict",
          "Committed assistant output must be projected from its Session entry",
        );
      }
      stream.activities = stream.activities.filter((activity) =>
        activity.type !== "model.output.delta" || activity.modelRequestId !== event.modelRequestId);
      const activity: OrdinaryRunActivity = {
        activityId: `transition:${event.eventId}`,
        runId: event.runId,
        sequence: stream.nextSequence++,
        recordedAt: event.recordedAt,
        type: "model.output.completed",
        durability: "durable",
        modelRequestId: event.modelRequestId,
        assistantEntryRef: clone(event.assistantEntryRef),
        content: assistantText,
      };
      stream.activities.push(activity);
      emit(activity);
      return;
    }
    if (event.type === "model.reasoning.completed") {
      stream.activities = stream.activities.filter((activity) =>
        activity.type !== "model.reasoning.delta" || activity.modelRequestId !== event.modelRequestId);
    }
    const durableCallIds = toolCallIds(event);
    stream.activities = stream.activities.map((activity) =>
      activity.type === "tool.result" && durableCallIds.includes(toolCallFactId(activity.result))
        ? { ...activity, durability: "durable" }
        : activity);
    const activity: OrdinaryRunActivity = {
      activityId: `transition:${event.eventId}`,
      runId: event.runId,
      sequence: stream.nextSequence++,
      recordedAt: event.recordedAt,
      type: "run.transition",
      durability: "durable",
      event: clone(event),
    };
    stream.activities.push(activity);
    emit(activity);
    if (isTerminalEvent(event)) {
      // Final state is durable. Drop potentially large live-only deltas after subscribers
      // observe the terminal boundary; replay remains truthful from durable transitions.
      stream.activities = stream.activities.filter((item) => item.durability === "durable");
      activeModelRequestIds.delete(event.runId);
      reasoningBuffers.delete(event.runId);
      clearVisibleAssistantCheckpoint(event.runId);
    }
  }

  function recordOutputDelta(runId: string, delta: string): void {
    if (released || delta.length === 0) return;
    const document = documents.get(runId);
    if (document?.state.status.kind !== "running") return;
    const modelRequestId = activeModelRequestIds.get(runId);
    if (modelRequestId === undefined) return;
    const visibleAssistantText = `${visibleAssistantBuffers.get(runId) ?? document.state.visibleAssistantText ?? ""}${delta}`;
    visibleAssistantBuffers.set(runId, visibleAssistantText);
    scheduleVisibleAssistantCheckpoint(runId);
    const stream = streamFor(runId);
    const activity: OrdinaryRunActivity = {
      activityId: idFactory("ordinary-activity"),
      runId,
      sequence: stream.nextSequence++,
      recordedAt: now(),
      type: "model.output.delta",
      durability: "live_only",
      modelRequestId,
      delta,
    };
    stream.activities.push(activity);
    emit(activity);
  }

  function scheduleVisibleAssistantCheckpoint(runId: string): void {
    if (visibleAssistantCheckpointTimers.has(runId)) return;
    const timer = setTimeout(() => {
      visibleAssistantCheckpointTimers.delete(runId);
      const checkpoint = persistVisibleAssistantCheckpoint(runId).catch(() => undefined);
      postExecutionTasks.add(checkpoint);
      void checkpoint.finally(() => postExecutionTasks.delete(checkpoint));
    }, visibleAssistantCheckpointIntervalMs);
    timer.unref?.();
    visibleAssistantCheckpointTimers.set(runId, timer);
  }

  async function persistVisibleAssistantCheckpoint(runId: string): Promise<void> {
    await enqueue(runId, async () => {
      const visibleAssistantText = visibleAssistantBuffers.get(runId);
      if (visibleAssistantText === undefined) return;
      const current = await load(runId);
      if (current === undefined || current.state.status.kind !== "running" ||
          current.state.visibleAssistantText === visibleAssistantText) {
        return;
      }
      const saved = await input.repository.save({
        ...current.state,
        visibleAssistantText,
      }, current.revision);
      documents.set(runId, saved);
    });
  }

  function clearVisibleAssistantCheckpoint(runId: string): void {
    const timer = visibleAssistantCheckpointTimers.get(runId);
    if (timer !== undefined) clearTimeout(timer);
    visibleAssistantCheckpointTimers.delete(runId);
    visibleAssistantBuffers.delete(runId);
  }

  function recordReasoningDelta(runId: string, delta: string): void {
    if (released || delta.length === 0) return;
    const state = documents.get(runId)?.state;
    if (state?.status.kind !== "running") return;
    const modelRequestId = activeModelRequestIds.get(runId);
    if (modelRequestId === undefined) return;
    // AgentTool streams can settle after the owning root model response. Once
    // that request has a durable reasoning fact, later deltas belong elsewhere.
    if (state.timeline.some((event) =>
      event.type === "model.reasoning.completed" && event.modelRequestId === modelRequestId)) return;
    const buffer = reasoningBuffers.get(runId);
    if (buffer === undefined || buffer.modelRequestId !== modelRequestId) {
      reasoningBuffers.set(runId, { modelRequestId, content: delta });
    } else {
      buffer.content += delta;
    }
    const stream = streamFor(runId);
    const activity: OrdinaryRunActivity = {
      activityId: idFactory("ordinary-activity"),
      runId,
      sequence: stream.nextSequence++,
      recordedAt: now(),
      type: "model.reasoning.delta",
      durability: "live_only",
      modelRequestId,
      delta,
    };
    stream.activities.push(activity);
    emit(activity);
  }

  async function completeReasoning(runId: string, authoritativeContent?: string): Promise<void> {
    const modelRequestId = activeModelRequestIds.get(runId);
    if (modelRequestId === undefined) return;
    const buffered = reasoningBuffers.get(runId);
    if (buffered?.modelRequestId === modelRequestId) reasoningBuffers.delete(runId);
    const content = authoritativeContent !== undefined && authoritativeContent.length > 0
      ? authoritativeContent
      : buffered?.modelRequestId === modelRequestId ? buffered.content : undefined;
    if (content === undefined || content.length === 0) return;
    const document = await load(runId);
    if (document?.state.status.kind !== "running") return;
    const existing = document.state.timeline.find((event) =>
      event.type === "model.reasoning.completed" && event.modelRequestId === modelRequestId);
    if (existing?.type === "model.reasoning.completed") {
      return;
    }
    await mutate(runId, {
      type: "record_reasoning",
      modelRequestId,
      content,
    });
  }

  function recordModelRequest(runId: string, reason: "initial" | "after_tool" | "after_approval"): void {
    if (released) return;
    if (documents.get(runId)?.state.status.kind !== "running") return;
    const stream = streamFor(runId);
    const latest = stream.activities.at(-1);
    if (latest?.type === "model.request" && latest.reason === reason) return;
    const activity: OrdinaryRunActivity = {
      activityId: idFactory("ordinary-activity"),
      runId,
      sequence: stream.nextSequence++,
      recordedAt: now(),
      type: "model.request",
      durability: "live_only",
      reason,
    };
    stream.activities.push(activity);
    activeModelRequestIds.set(runId, activity.activityId);
    emit(activity);
  }

  function recordToolRequested(runId: string, request: ToolCallRequest): void {
    if (released || documents.get(runId)?.state.status.kind !== "running") return;
    const stream = streamFor(runId);
    const activityId = liveToolActivityId(request);
    if (stream.activities.some((activity) => activity.activityId === activityId)) return;
    if (hasTerminalToolFact(runId, request)) return;
    const activity: OrdinaryRunActivity = {
      activityId,
      runId,
      sequence: stream.nextSequence++,
      recordedAt: now(),
      type: "tool.requested",
      durability: "live_only",
      request: clone(request),
    };
    stream.activities.push(activity);
    emit(activity);
  }

  function recordToolProgress(runId: string, update: ToolCallProgress): void {
    if (released || documents.get(runId)?.state.status.kind !== "running") return;
    const stream = streamFor(runId);
    const activityId = liveToolActivityId(update);
    const existingIndex = stream.activities.findIndex((activity) => activity.activityId === activityId);
    const existing = stream.activities[existingIndex];
    if (existing === undefined || (existing.type !== "tool.requested" && existing.type !== "tool.progress")) return;
    if (existing.request.toolName !== update.toolName || hasTerminalToolFact(runId, update)) return;
    const activity: OrdinaryRunActivity = {
      activityId,
      runId,
      sequence: stream.nextSequence++,
      recordedAt: existing.recordedAt,
      type: "tool.progress",
      durability: "live_only",
      request: existing.request,
      progress: clone(update.progress),
    };
    stream.activities[existingIndex] = activity;
    emit(activity);
  }

  function hasTerminalToolFact(
    runId: string,
    identity: Pick<ToolCallRequest, "callId" | "factId">,
  ): boolean {
    const factId = toolCallFactId(identity);
    return documents.get(runId)?.state.toolCalls.some((result) =>
      toolCallFactId(result) === factId && result.status !== "approval_required") === true;
  }

  function rememberToolResults(runId: string, results: readonly ToolCallResult[]): void {
    const accepted = acceptedToolResults.get(runId) ?? new Map<string, ToolCallResult>();
    for (const result of results) {
      const factId = toolCallFactId(result);
      const existing = accepted.get(factId);
      if (existing !== undefined && existing.status !== "approval_required" &&
          JSON.stringify(existing) !== JSON.stringify(result)) {
        throw new OrdinaryFeatureError(
          "ordinary_tool_result_conflict",
          `Ordinary run ${runId} observed different results for tool fact ${factId}`,
        );
      }
      accepted.set(factId, clone(result));
    }
    if (accepted.size > 0) acceptedToolResults.set(runId, accepted);
  }

  function forgetPersistedToolResults(runId: string, results: readonly ToolCallResult[]): void {
    const accepted = acceptedToolResults.get(runId);
    const state = documents.get(runId)?.state;
    if (accepted === undefined || state === undefined) return;
    for (const result of results) {
      const factId = toolCallFactId(result);
      const persisted = state.toolCalls.find((item) => toolCallFactId(item) === factId);
      if (persisted !== undefined && JSON.stringify(persisted) === JSON.stringify(result)) {
        accepted.delete(factId);
      }
    }
    if (accepted.size === 0) acceptedToolResults.delete(runId);
  }

  function forgetReconciledApprovalResults(runId: string): void {
    const accepted = acceptedToolResults.get(runId);
    const state = documents.get(runId)?.state;
    if (accepted === undefined || state === undefined) return;
    for (const [factId, result] of accepted) {
      if (result.status === "approval_required" &&
          state.toolCalls.some((persisted) => toolCallFactId(persisted) === factId &&
            persisted.status !== "approval_required")) {
        accepted.delete(factId);
      }
    }
    if (accepted.size === 0) acceptedToolResults.delete(runId);
  }

  async function persistToolResult(runId: string, result: ToolCallResult): Promise<void> {
    await enqueue(runId, async () => {
      const current = await load(runId);
      if (current === undefined) return;
      const key = ordinaryToolResultKey(result);
      const factId = toolCallFactId(result);
      // Cancellation commits promptly, but an already executing tool may finish after
      // abort. Once accepted, the fact remains feature-owned after the controller
      // is released so terminal settlement can finish its durable write.
      if (current.state.status.kind !== "running" && !controllers.has(runId) &&
          !acceptedToolResults.get(runId)?.has(factId)) return;
      const existing = current.state.toolCalls.find((item) => toolCallFactId(item) === factId);
      if (existing !== undefined) {
        if (existing.status !== "approval_required") {
          if (ordinaryToolResultKey(existing) === key && JSON.stringify(existing) === JSON.stringify(result)) {
            const reconciled = recordOrdinaryToolResult({ state: current.state, result, recordedAt: current.state.timestamps.updatedAt });
            if (reconciled === current.state) return;
            const saved = await input.repository.save(reconciled, current.revision);
            documents.set(runId, saved);
            return;
          }
          throw new OrdinaryFeatureError(
            "ordinary_tool_result_conflict",
            `Ordinary run ${runId} already recorded a different result for tool fact ${factId}`,
          );
        }
      }
      const recordedAt = current.state.toolResultRecordedAt[key] ?? now();
      const state = recordOrdinaryToolResult({ state: current.state, result, recordedAt });
      if (state === current.state) return;
      const saved = await input.repository.save(state, current.revision);
      documents.set(runId, saved);
      if (result.status !== "approval_required") {
        recordDurableToolResult(runId, result, recordedAt);
      }
    });
  }

  async function persistNestedToolRequests(
    runId: string,
    requests: readonly ToolCallRequest[],
  ): Promise<void> {
    if (requests.length === 0) return;
    await enqueue(runId, async () => {
      const current = await load(runId);
      if (current === undefined) {
        throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${runId} was not found`);
      }
      const state = recordOrdinaryNestedToolRequests({
        state: current.state,
        requests,
        recordedAt: now(),
      });
      if (state === current.state) return;
      const saved = await input.repository.save(state, current.revision);
      documents.set(runId, saved);
    });
  }

  async function reconcilePendingToolRound(
    runId: string,
    options: { readonly persistState?: boolean } = {},
  ): Promise<OrdinaryRunState | undefined> {
    const persistState = options.persistState ?? true;
    return enqueue(runId, async () => {
      const current = await load(runId);
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
          document = await input.repository.save(state, current.revision);
          documents.set(runId, document);
          syncDurableToolResults(state);
        }
        return clone(state);
      }
      const orderedToolCalls = await input.sessionRepository.readToolCalls({
        sessionRef: state.sessionRef,
        assistantEntryRef: pending.assistantEntryRef,
      });
      state = reconcileInterruptedOrdinaryToolRound({ state, orderedToolCalls, recordedAt });
      if (persistState && state !== current.state) {
        document = await input.repository.save(state, current.revision);
        documents.set(runId, document);
        syncDurableToolResults(state);
      }
      const rootResults = pending.toolCallIds.map((callId) =>
        state.toolCalls.find((result) => toolCallFactId(result) === callId && result.parentToolCallFactId === undefined));
      if (rootResults.some((result) => result === undefined)) {
        throw new OrdinaryFeatureError(
          "ordinary_run_state_conflict",
          `Ordinary run ${runId} cannot reconcile a Session tool round without every root result`,
        );
      }
      const toolRoundLeafRef = await input.sessionRepository.reconcileToolResultEntries({
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
            toolCallIds: pending.toolCallIds,
          },
        },
        recordedAt: now(),
        eventId: idFactory("ordinary-event"),
      });
      if (persistState) {
        document = await input.repository.save(state, document.revision);
        documents.set(runId, document);
      }
      return clone(state);
    });
  }

  async function reconcileLostApprovalResults(runId: string): Promise<OrdinaryRunState | undefined> {
    return enqueue(runId, async () => {
      const current = await load(runId);
      if (current === undefined) return undefined;
      const closed = closeLostApprovalFacts(current.state);
      if (closed.toolCalls.length === 0) return clone(current.state);
      const recordedAt = now();
      let state = current.state;
      for (const result of closed.toolCalls) {
        state = recordOrdinaryToolResult({ state, result, recordedAt });
      }
      const saved = await input.repository.save(state, current.revision);
      documents.set(runId, saved);
      syncDurableToolResults(state);
      return clone(state);
    });
  }

  async function blockLostApproval(
    runId: string,
    reason: { readonly code: string; readonly message: string },
  ): Promise<OrdinaryRunState> {
    const reconciled = await reconcilePendingToolRound(runId, { persistState: false });
    const blocked = await enqueue(runId, async () => {
      const current = await load(runId);
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
      const saved = await input.repository.save(state, current.revision);
      documents.set(runId, saved);
      syncDurableToolResults(state);
      recordTransition(state.timeline.at(-1)!);
      return clone(state);
    });
    if (blocked.pendingToolRound === undefined && blocked.pendingNestedToolCalls === undefined) return blocked;
    return await reconcilePendingToolRound(runId) ?? blocked;
  }

  function recordDurableToolResult(runId: string, result: ToolCallResult, recordedAt: string): void {
    const stream = streamFor(runId);
    const activityId = toolActivityId(result);
    const existingIndex = stream.activities.findIndex((activity) => activity.activityId === activityId);
    const existing = stream.activities[existingIndex];
    if (existing?.type === "tool.result" && existing.durability === "durable") return;
    if (existing?.type === "tool.result") {
      stream.activities[existingIndex] = { ...existing, durability: "durable" };
      return;
    }
    const activity: OrdinaryRunActivity = {
      activityId,
      runId,
      sequence: stream.nextSequence++,
      recordedAt,
      type: "tool.result",
      durability: "durable",
      result: clone(result),
    };
    stream.activities.push(activity);
    emit(activity);
  }

  function syncDurableToolResults(state: OrdinaryRunState): void {
    for (const result of state.toolCalls) {
      if (result.status === "approval_required") continue;
      const recordedAt = state.toolResultRecordedAt[ordinaryToolResultKey(result)];
      if (recordedAt !== undefined) recordDurableToolResult(state.runId, result, recordedAt);
    }
  }

  async function applyOutcome(runId: string, outcome: OrdinaryExecutionOutcome): Promise<void> {
    if (outcome.status === "approval_required") {
      let registered = false;
      try {
        registered = await enqueue(runId, async () => {
          const current = await load(runId);
          if (current === undefined || isTerminal(current.state)) return false;
          if (current.state.status.kind !== "running" || continuations.has(runId)) {
            throw new OrdinaryFeatureError(
              "ordinary_run_state_conflict",
              `Ordinary run ${runId} cannot register a second live approval continuation`,
            );
          }
          const state = await commitTransition(runId, {
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
          continuations.set(runId, outcome.continuation);
          return true;
        });
      } catch (error) {
        await outcome.continuation.release().catch(() => undefined);
        throw error;
      }
      if (!registered) await outcome.continuation.release().catch(() => undefined);
      return;
    }
    const document = await load(runId);
    if (document === undefined || isTerminal(document.state)) return;
    if (outcome.status === "completed") {
      let state: OrdinaryRunState;
      try {
        state = await mutate(runId, { type: "complete", session: outcome.session, toolCalls: outcome.toolCalls, usage: outcome.usage, toolMetrics: outcome.toolMetrics, capabilityResolution: outcome.capabilityResolution });
      } catch (error) {
        throw new OrdinaryFeatureError(
          "ordinary_completion_commit_failed",
          "Model execution completed, but the terminal Ordinary snapshot could not be committed.",
          { cause: error },
        );
      }
      await finalizeExecutionSession(runId, state, false);
      return;
    }
    if (outcome.status === "cancelled") {
      const state = await mutate(runId, { type: "cancel", reason: outcome.reason, session: outcome.session, toolCalls: outcome.toolCalls, usage: outcome.usage, toolMetrics: outcome.toolMetrics, capabilityResolution: outcome.capabilityResolution });
      await finalizeExecutionSession(runId, state, true);
      return;
    }
    const state = await mutate(runId, { type: "fail", error: outcome.error, session: outcome.session, toolCalls: outcome.toolCalls, usage: outcome.usage, toolMetrics: outcome.toolMetrics, capabilityResolution: outcome.capabilityResolution });
    await finalizeExecutionSession(runId, state, true);
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
    let latest = await load(runId);
    try {
      const persisted = await input.repository.get(runId);
      if (persisted !== undefined && (latest === undefined || persisted.revision > latest.revision)) {
        documents.set(runId, persisted);
        syncDurableToolResults(persisted.state);
        const terminalEvent = persisted.state.timeline.at(-1);
        if (terminalEvent !== undefined && isTerminalEvent(terminalEvent)) recordTransition(terminalEvent);
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
        await finalizeExecutionSession(runId, latest.state, false).catch(() => undefined);
      }
      clearCompletedCommitRetry(runId);
      if (latest !== undefined) {
        await activateSuccessor(runId);
        notifyStableTerminal(runId);
      }
      return true;
    }
    try {
      const acceptedCompletedSession = outcome.session.latestLeafRef === null
        ? outcome.session
        : { ...outcome.session, safeLeafRef: outcome.session.latestLeafRef };
      const blocked = await mutate(runId, {
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
      await finalizeExecutionSession(runId, blocked, false).catch(() => undefined);
      clearCompletedCommitRetry(runId);
      await activateSuccessor(runId);
    } catch (blockError) {
      emitDiagnostic({ kind: "completion_commit_failed", runId, error: blockError });
      scheduleCompletedCommitRetry(runId, outcome, blockError);
    }
    return true;
  }

  function scheduleCompletedCommitRetry(
    runId: string,
    outcome: OrdinaryExecutionOutcome,
    error: unknown,
  ): void {
    if (released || completionCommitRetryTimers.has(runId)) return;
    const retryError = error instanceof OrdinaryFeatureError &&
      error.code === "ordinary_completion_commit_failed"
      ? error
      : new OrdinaryFeatureError(
          "ordinary_completion_commit_failed",
          "Model execution completed, but the terminal Ordinary snapshot could not be committed.",
          { cause: error },
        );
    const attempt = (completionCommitRetryCounts.get(runId) ?? 0) + 1;
    completionCommitRetryCounts.set(runId, attempt);
    const delayMs = Math.min(30_000, 250 * (2 ** Math.min(attempt - 1, 7)));
    const timer = setTimeout(() => {
      completionCommitRetryTimers.delete(runId);
      const retry = handleCompletedCommitFailure(runId, outcome, retryError);
      trackPostExecutionTask(retry.then(() => undefined, () => undefined));
    }, delayMs);
    timer.unref?.();
    completionCommitRetryTimers.set(runId, timer);
  }

  function clearCompletedCommitRetry(runId: string): void {
    const timer = completionCommitRetryTimers.get(runId);
    if (timer !== undefined) clearTimeout(timer);
    completionCommitRetryTimers.delete(runId);
    completionCommitRetryCounts.delete(runId);
  }

  async function finalizeExecutionSession(
    runId: string,
    state: OrdinaryRunState,
    restoreSafeLeaf: boolean,
  ): Promise<void> {
    const finalize = input.execution.finalizeSession;
    if (finalize === undefined) return;
    sessionFinalizationPending.add(runId);
    const target = restoreSafeLeaf
      ? rollbackLeafRef(state)
      : undefined;
    let firstFailure: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await finalize(runId, target);
        sessionsAwaitingFinalization.delete(runId);
        sessionFinalizationPending.delete(runId);
        sessionFinalizationFailures.delete(runId);
        return;
      } catch (error) {
        if (state.session.phase === "not_started" && errorMessage(error).includes("has no active Session control")) {
          sessionsAwaitingFinalization.delete(runId);
          sessionFinalizationPending.delete(runId);
          sessionFinalizationFailures.delete(runId);
          return;
        }
        firstFailure ??= error;
      }
    }
    sessionFinalizationFailures.set(runId, firstFailure);
    // The run itself is already terminal; a stuck finalization pauses the
    // conversation queue, so the operator must be able to see why.
    emitDiagnostic({ kind: "session_finalization_failed", runId, error: firstFailure });
    throw firstFailure;
  }

  function emitDiagnostic(diagnostic: OrdinaryFeatureDiagnostic): void {
    try {
      input.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics never affect committed facts or control flow.
    }
  }

  async function runExecution(runId: string): Promise<void> {
    const document = await load(runId);
    if (document === undefined || document.state.status.kind !== "running") return;
    const sessionRef = document.state.sessionRef;
    const controller = new AbortController();
    controllers.set(runId, controller);
    if (input.execution.finalizeSession !== undefined) sessionsAwaitingFinalization.add(runId);
    let outcome: OrdinaryExecutionOutcome | undefined;
    try {
      recordModelRequest(runId, "initial");
      outcome = await input.execution.execute({
        runId,
        conversationId: document.state.turn.conversationId,
        sessionRef,
        birth: document.state.birth,
        runInput: document.state.input,
        abortSignal: controller.signal,
        onTextDelta: (delta) => recordOutputDelta(runId, delta),
        onReasoningDelta: (delta) => recordReasoningDelta(runId, delta),
        onReasoningCompleted: (content) => completeReasoning(runId, content),
        onToolRequested: (request) => recordToolRequested(runId, request),
        onNestedToolRequestsAccepted: (requests) => persistNestedToolRequests(runId, requests),
        onToolProgress: (progress) => recordToolProgress(runId, progress),
        onSessionWriteCheckpoint: async (checkpoint) => {
          let assistantText: string | undefined;
          if (checkpoint.kind === "assistant_tool_call_entry_committed" ||
              checkpoint.kind === "assistant_response_entry_committed") {
            const entry = (await input.sessionRepository.readAssistantEntries({
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
          await mutate(runId, {
            type: "record_session_checkpoint",
            checkpoint,
            modelRequestId: activeModelRequestIds.get(runId),
            assistantText,
          });
        },
        onToolResult: async (result) => {
          rememberToolResults(runId, [result]);
          await persistToolResult(runId, result);
          forgetPersistedToolResults(runId, [result]);
          if (result.status !== "approval_required" && result.parentToolCallFactId === undefined) {
            recordModelRequest(runId, "after_tool");
          }
        },
      });
      await completeReasoning(runId);
      rememberToolResults(runId, outcome.toolCalls);
      await applyOutcome(runId, outcome);
      forgetPersistedToolResults(runId, outcome.toolCalls);
    } catch (error) {
      if (await handleCompletedCommitFailure(runId, outcome, error)) return;
      let failure = error;
      try {
        await completeReasoning(runId);
      } catch (reasoningError) {
        failure = reasoningError;
      }
      const latest = await load(runId);
      if (latest !== undefined && !isTerminal(latest.state)) {
        const terminal = await mutate(runId, {
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
        await finalizeExecutionSession(runId, terminal, true);
      }
    } finally {
      try {
        await settleExecution(runId);
      } finally {
        // A live approval continuation resumes the same Pi harness. Keep its
        // original controller so cancellation and late tool facts remain tied
        // to the run until that harness actually reaches a terminal outcome.
        if (outcome?.status !== "approval_required" && controllers.get(runId) === controller) {
          controllers.delete(runId);
        }
      }
    }
  }

  async function settleExecution(runId: string): Promise<void> {
    let resultPersistenceFailure: unknown;
    for (const result of [...(acceptedToolResults.get(runId)?.values() ?? [])]) {
      try {
        await persistToolResult(runId, result);
        forgetPersistedToolResults(runId, [result]);
      } catch (error) {
        resultPersistenceFailure ??= error;
      }
    }
    let current = await load(runId);
    if (current === undefined) return;
    if (current.state.status.kind === "awaiting_approval") {
      if (resultPersistenceFailure !== undefined) throw resultPersistenceFailure;
      return;
    }
    if (current.state.pendingToolRound !== undefined ||
        current.state.pendingNestedToolCalls !== undefined) {
      try {
        await reconcilePendingToolRound(runId);
      } catch (error) {
        throw resultPersistenceFailure === undefined
          ? error
          : new AggregateError(
              [resultPersistenceFailure, error],
              `Ordinary run ${runId} could not reconcile its terminal tool round`,
            );
      }
      current = await load(runId) ?? current;
      // The durable reconciliation now owns every call in the closed round.
      // Buffered results that failed its identity contract must not block the successor.
      if (current.state.pendingToolRound === undefined &&
          current.state.pendingNestedToolCalls === undefined) acceptedToolResults.delete(runId);
      resultPersistenceFailure = undefined;
    }
    if (isTerminal(current.state) && current.state.toolCalls.some((result) => result.status === "approval_required")) {
      await reconcileLostApprovalResults(runId);
      current = await load(runId) ?? current;
      forgetReconciledApprovalResults(runId);
    }
    if (resultPersistenceFailure !== undefined) throw resultPersistenceFailure;
  }

  /**
   * Terminal facts are stable only after every accepted tool result reached a
   * durable final fact and the live execution fully settled. Cancellation is
   * deliberately stricter here than for scheduling: memory consumers must not
   * observe a cancelled run whose abort-ignoring harness may still append facts.
   */
  function isStableTerminalState(state: OrdinaryRunState): boolean {
    return isTerminal(state) &&
      state.pendingToolRound === undefined &&
      state.pendingNestedToolCalls === undefined &&
      !state.toolCalls.some((result) => result.status === "approval_required") &&
      !acceptedToolResults.has(state.runId) &&
      !approvalReservations.has(state.runId) &&
      !continuations.has(state.runId) &&
      !cancellationCleanupContinuations.has(state.runId) &&
      !controllers.has(state.runId) &&
      !executions.has(state.runId);
  }

  function notifyStableTerminal(runId: string): void {
    const document = documents.get(runId);
    if (document === undefined || isHiddenRun(document.state) || !isStableTerminalState(document.state)) return;
    for (const listener of [...stableTerminalListeners]) {
      try {
        listener(runId);
      } catch {
        // A memory or audit consumer cannot roll back committed Ordinary facts.
      }
    }
    maybeReleaseTerminalStream(runId);
    // 标题生成与用户消息展示无关，失败时列表继续使用首条消息截断回退。
    trackPostExecutionTask(requestAutoConversationTitleIfMissing(runId));
  }

  /**
   * Drops the in-memory activity stream of a settled terminal run once nobody
   * is subscribed. The stream duplicates the persisted timeline (every durable
   * activity wraps a cloned run event), so keeping it alive for finished runs
   * doubles the memory footprint of the whole run history for the process
   * lifetime. Replay rebuilds the stream on demand from the persisted state;
   * the fresh streamId then invalidates old cursors through the existing
   * `reset` protocol, which panel consumers already handle.
   */
  function maybeReleaseTerminalStream(runId: string): void {
    if ((listeners.get(runId)?.size ?? 0) > 0) return;
    const document = documents.get(runId);
    if (document === undefined || isHiddenRun(document.state) || !isStableTerminalState(document.state)) return;
    activityStreams.delete(runId);
  }

  /**
   * 首轮 run 稳定终态后，用第一条用户消息请求一次模型标题（Host 端口）。
   * 每次会话只有一次生成机会：失败不重试、用户重命名后让位、落盘前二次
   * 检查防覆盖；任何失败都保持首条消息截断回退，不阻塞对话。
   */
  async function requestAutoConversationTitleIfMissing(runId: string): Promise<void> {
    const generator = input.generateConversationTitle;
    if (generator === undefined) return;
    const document = documents.get(runId);
    if (document === undefined || isHiddenRun(document.state) || !isStableTerminalState(document.state)) return;
    // 只在首轮触发；旧会话不会批量回填。
    if (document.state.turn.predecessorRunId !== undefined) return;
    const conversationId = document.state.turn.conversationId;
    if (autoTitleAttemptedConversationIds.has(conversationId)) return;
    autoTitleAttemptedConversationIds.add(conversationId);
    const control = conversationDocuments.get(conversationId);
    if (control === undefined || control.state.deletedAt !== undefined ||
        control.state.titleOverride !== undefined || control.state.autoTitle !== undefined) {
      return;
    }
    try {
      const generated = await generator({
        conversationId,
        userMessage: document.state.input.userMessage,
        birth: document.state.birth,
      });
      if (generated === undefined || generated.trim().length === 0) return;
      const normalized = normalizeOrdinaryConversationTitle(generated);
      await enqueue(`conversation:${conversationId}`, async () => {
        await settlePendingUncommittedConversationCleanup(conversationId);
        const current = await loadConversationControl(conversationId);
        if (current === undefined || current.state.deletedAt !== undefined) return;
        // 落盘前防覆盖：用户手动重命名或已有自动标题时让位。
        if (current.state.titleOverride !== undefined || current.state.autoTitle !== undefined) return;
        const changedAt = now();
        const saved = await input.conversationRepository.save(
          { ...current.state, autoTitle: normalized, autoTitleAt: changedAt },
          current.revision,
          changedAt,
        );
        conversationDocuments.set(conversationId, saved);
      });
    } catch (error) {
      emitDiagnostic({ kind: "conversation_title_generation_failed", conversationId, error });
    }
  }

  function projectStableTerminalRunFacts(
    document: OrdinaryRunSnapshotDocument,
  ): OrdinaryStableTerminalRunFacts {
    const state = document.state;
    const status = state.status;
    if (status.kind !== "completed" && status.kind !== "failed" &&
        status.kind !== "cancelled" && status.kind !== "blocked") {
      throw new OrdinaryFeatureError(
        "ordinary_run_state_conflict",
        `Ordinary run ${state.runId} is not terminal`,
      );
    }
    return clone({
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
          toolFactId: toolCallFactId(result),
          ...(result.parentToolCallFactId === undefined ? {} : { parentToolFactId: result.parentToolCallFactId }),
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

  function isSchedulingBarrierCleared(state: OrdinaryRunState): boolean {
    if (!isTerminal(state) || state.pendingToolRound !== undefined ||
        state.pendingNestedToolCalls !== undefined ||
        approvalReservations.has(state.runId) || continuations.has(state.runId) ||
        cancellationCleanupContinuations.has(state.runId) || acceptedToolResults.has(state.runId) ||
        sessionFinalizationPending.has(state.runId)) {
      return false;
    }
    // Cancellation stops admission before it commits. A pure model call that
    // ignores abort cannot hold the conversation queue; an accepted tool round
    // above still keeps the barrier closed until its outcome is reconciled.
    return state.status.kind === "cancelled" ||
      (!controllers.has(state.runId) && !executions.has(state.runId));
  }

  function track(runId: string, operation: Promise<void>): void {
    executions.set(runId, operation);
    const postExecution = operation.then(() => undefined, () => undefined).then(async () => {
      if (executions.get(runId) === operation) executions.delete(runId);
      await activateSuccessor(runId);
      notifyStableTerminal(runId);
    });
    trackPostExecutionTask(postExecution);
  }

  function trackPostExecutionTask(task: Promise<void>): void {
    postExecutionTasks.add(task);
    void task.then(
      () => { postExecutionTasks.delete(task); },
      () => { postExecutionTasks.delete(task); },
    );
  }

  /**
   * A terminal run whose Session finalize failed keeps the scheduling barrier
   * closed. Retrying at every scheduling event turns a transient finalize
   * failure into a short pause instead of a silent, permanent queue deadlock.
   */
  async function retryFailedSessionFinalization(runId: string): Promise<void> {
    if (!sessionFinalizationPending.has(runId) || !sessionFinalizationFailures.has(runId)) return;
    const existing = sessionFinalizationRetries.get(runId);
    if (existing !== undefined) {
      await existing;
      return;
    }
    const attempt = (async () => {
      const document = await load(runId);
      if (document === undefined || !isTerminal(document.state)) return;
      await finalizeExecutionSession(runId, document.state, document.state.status.kind !== "completed");
    })().catch(() => undefined);
    sessionFinalizationRetries.set(runId, attempt);
    try {
      await attempt;
    } finally {
      if (sessionFinalizationRetries.get(runId) === attempt) sessionFinalizationRetries.delete(runId);
    }
  }

  async function activateSuccessor(predecessorRunId: string): Promise<void> {
    if (released) return;
    const predecessor = await load(predecessorRunId);
    if (predecessor === undefined) return;
    await requestConversationActivation(predecessor.state.turn.conversationId, predecessorRunId);
  }

  async function requestConversationActivation(conversationId: string, diagnosticRunId: string): Promise<void> {
    if (released) return;
    const pump = successorActivationPumps.get(conversationId) ?? { diagnosticRunId, consecutiveFailures: 0 };
    pump.diagnosticRunId = diagnosticRunId;
    successorActivationPumps.set(conversationId, pump);
    if (pump.retryTimer !== undefined) {
      clearTimeout(pump.retryTimer);
      pump.retryTimer = undefined;
    }
    if (pump.inFlight !== undefined) {
      await pump.inFlight;
      return;
    }
    let activationFailure: { readonly error: unknown } | undefined;
    const attempt = (async () => {
      try {
        await activateConversationOnce(conversationId, pump);
      } catch (error) {
        activationFailure = { error };
      }
    })();
    pump.inFlight = attempt;
    try {
      await attempt;
    } finally {
      if (pump.inFlight === attempt) pump.inFlight = undefined;
    }
    if (activationFailure === undefined) {
      pump.consecutiveFailures = 0;
      if (successorActivationPumps.get(conversationId) === pump &&
          pump.retryTimer === undefined && pump.inFlight === undefined) {
        successorActivationPumps.delete(conversationId);
      }
      return;
    }
    if (released || successorActivationPumps.get(conversationId) !== pump) return;
    pump.consecutiveFailures += 1;
    const retryDelayMs = successorActivationRetryDelayMs(pump.consecutiveFailures);
    emitDiagnostic({
      kind: "successor_activation_failed",
      conversationId,
      predecessorRunId: pump.diagnosticRunId,
      consecutiveFailures: pump.consecutiveFailures,
      retryDelayMs,
      error: activationFailure.error,
    });
    const retryTimer = setTimeout(() => {
      if (pump.retryTimer !== retryTimer) return;
      pump.retryTimer = undefined;
      const retry = requestConversationActivation(conversationId, pump.diagnosticRunId);
      trackPostExecutionTask(retry);
    }, retryDelayMs);
    retryTimer.unref?.();
    pump.retryTimer = retryTimer;
  }

  async function activateConversationOnce(
    conversationId: string,
    pump: { diagnosticRunId: string },
  ): Promise<void> {
    const control = await loadConversationControl(conversationId);
    if (control?.state.deletedAt !== undefined) return;
    let runs = await schedulingRuns(conversationId, control);
    let candidate = nextEligibleQueuedRun(runs);
    if (candidate === undefined) {
      const settlementBlocker = runs.find((run) =>
        isTerminal(run) && run.status.kind !== "cancelled" &&
        acceptedToolResults.has(run.runId) &&
        !executions.has(run.runId) && !controllers.has(run.runId));
      if (settlementBlocker !== undefined) {
        pump.diagnosticRunId = settlementBlocker.runId;
        await settleExecution(settlementBlocker.runId);
        notifyStableTerminal(settlementBlocker.runId);
        runs = await schedulingRuns(conversationId, await loadConversationControl(conversationId));
        candidate = nextEligibleQueuedRun(runs);
      }
    }
    if (candidate === undefined) {
      const finalizationBlocker = runs.find((run) =>
        isTerminal(run) && !isSchedulingBarrierCleared(run) &&
        sessionFinalizationPending.has(run.runId) && sessionFinalizationFailures.has(run.runId));
      if (finalizationBlocker === undefined) return;
      pump.diagnosticRunId = finalizationBlocker.runId;
      await retryFailedSessionFinalization(finalizationBlocker.runId);
      if (sessionFinalizationPending.has(finalizationBlocker.runId) && sessionFinalizationFailures.has(finalizationBlocker.runId)) {
        throw sessionFinalizationFailures.get(finalizationBlocker.runId);
      }
      runs = await schedulingRuns(conversationId, await loadConversationControl(conversationId));
      candidate = nextEligibleQueuedRun(runs);
    }
    if (candidate === undefined) return;
    const predecessorRunId = candidate.turn.predecessorRunId;
    if (predecessorRunId !== undefined) {
      const predecessor = runs.find((run) => run.runId === predecessorRunId);
      if (predecessor === undefined || !isSchedulingBarrierCleared(predecessor)) return;
      pump.diagnosticRunId = predecessorRunId;
    } else {
      pump.diagnosticRunId = candidate.runId;
    }
    const activated = await enqueue(candidate.runId, async () => {
      if (released) return undefined;
      const current = await load(candidate.runId);
      if (current === undefined || current.state.status.kind !== "queued") return undefined;
      const latestControl = await loadConversationControl(current.state.turn.conversationId);
      if (latestControl?.state.deletedAt !== undefined) return undefined;
      const latestRuns = await schedulingRuns(current.state.turn.conversationId, latestControl);
      const latestCandidate = nextEligibleQueuedRun(latestRuns);
      if (released || latestCandidate?.runId !== current.state.runId) return undefined;
      if (current.state.turn.predecessorRunId !== undefined) {
        const latestPredecessor = latestRuns.find((run) => run.runId === current.state.turn.predecessorRunId);
        if (latestPredecessor === undefined || !isSchedulingBarrierCleared(latestPredecessor)) return undefined;
      }
      return commitTransition(current.state.runId, { type: "start" });
    });
    if (activated?.status.kind === "running") track(activated.runId, runExecution(activated.runId));
  }

  async function schedulingRuns(
    conversationId: string,
    control: OrdinaryConversationControlDocument | undefined,
  ): Promise<readonly OrdinaryRunState[]> {
    if (unavailableConversationIds.has(conversationId)) return [];
    if (control !== undefined) return visibleRuns(control);
    return [...documents.values()]
      .map((document) => document.state)
      .filter((run) => run.turn.conversationId === conversationId)
      .sort((left, right) => left.turn.ordinal - right.turn.ordinal);
  }

  function nextEligibleQueuedRun(runs: readonly OrdinaryRunState[]): OrdinaryRunState | undefined {
    for (const run of runs) {
      if (run.status.kind === "queued") return run;
      if (!isSchedulingBarrierCleared(run)) return undefined;
    }
    return undefined;
  }

  async function activateRootQueued(runId: string): Promise<void> {
    if (released) return;
    const queued = await load(runId);
    if (queued === undefined || queued.state.status.kind !== "queued" || queued.state.turn.predecessorRunId !== undefined) return;
    await requestConversationActivation(queued.state.turn.conversationId, runId);
  }

  async function claimRunManagedAttachments(
    runInput: OrdinaryRunInput,
    conversationId: string,
    runId: string,
  ): Promise<{
    readonly runInput: OrdinaryRunInput;
    readonly newlyClaimedAttachmentIds: readonly string[];
    readonly claimReservations: readonly ManagedAttachmentClaimReservation[];
  }> {
    const attachmentIds = managedAttachmentIds(runInput);
    if (attachmentIds.length === 0) return { runInput, newlyClaimedAttachmentIds: [], claimReservations: [] };
    const claimReservations = reserveManagedAttachmentClaimRollbacks(conversationId, runId, attachmentIds);
    try {
      const claimed = await requireManagedAttachmentRepository().claimForConversation({
        attachmentIds,
        instanceId: input.managedAttachmentInstanceId!,
        conversationId,
        claimedAt: now(),
      });
      return {
        runInput: canonicalManagedAttachmentInput(runInput, claimed.records),
        newlyClaimedAttachmentIds: claimed.newlyClaimedAttachmentIds,
        claimReservations,
      };
    } catch (error) {
      releaseManagedAttachmentClaimReservations(claimReservations, runId);
      if (error instanceof OrdinaryManagedAttachmentRepositoryError && error.partialClaim !== undefined) {
        await releaseRunManagedAttachmentClaims(runId, conversationId, error.partialClaim.attachmentIds);
      }
      if (error instanceof OrdinaryManagedAttachmentRepositoryError && (
        error.code === "ordinary_managed_attachment_not_found" ||
        error.code === "ordinary_managed_attachment_ownership_conflict" ||
        error.code === "ordinary_managed_attachment_invalid_id" ||
        error.code === "ordinary_managed_attachment_invalid_input"
      )) {
        throw new OrdinaryFeatureError(
          "ordinary_managed_attachment_unavailable",
          "One or more uploaded attachments are unavailable or owned by another conversation.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  function reserveManagedAttachmentClaimRollbacks(
    conversationId: string,
    runId: string,
    attachmentIds: readonly string[],
  ): readonly ManagedAttachmentClaimReservation[] {
    // A failed birth can leave a conversation-owned claim awaiting rollback.
    // Protect overlapping claims until this birth either persists or fails;
    // retries and the rollback itself are serialized by the same conversation key.
    const requested = new Set(attachmentIds);
    const reservations: ManagedAttachmentClaimReservation[] = [];
    for (const rollback of managedAttachmentClaimRollbacks.values()) {
      if (rollback.conversationId !== conversationId || rollback.protectedByRunId !== undefined) continue;
      const protectedAttachmentIds = rollback.attachmentIds.filter((attachmentId) => requested.has(attachmentId));
      if (protectedAttachmentIds.length === 0) continue;
      managedAttachmentClaimRollbacks.set(rollback.runId, { ...rollback, protectedByRunId: runId });
      reservations.push({ rollbackRunId: rollback.runId, protectedAttachmentIds });
    }
    return reservations;
  }

  function releaseManagedAttachmentClaimReservations(
    reservations: readonly ManagedAttachmentClaimReservation[],
    runId: string,
  ): void {
    for (const reservation of reservations) {
      const rollback = managedAttachmentClaimRollbacks.get(reservation.rollbackRunId);
      if (rollback?.protectedByRunId !== runId) continue;
      managedAttachmentClaimRollbacks.set(rollback.runId, { ...rollback, protectedByRunId: undefined });
    }
  }

  function commitManagedAttachmentClaimReservations(
    reservations: readonly ManagedAttachmentClaimReservation[],
    runId: string,
  ): void {
    for (const reservation of reservations) {
      const rollback = managedAttachmentClaimRollbacks.get(reservation.rollbackRunId);
      if (rollback?.protectedByRunId !== runId) continue;
      const protectedIds = new Set(reservation.protectedAttachmentIds);
      const remainingAttachmentIds = rollback.attachmentIds.filter((attachmentId) => !protectedIds.has(attachmentId));
      if (remainingAttachmentIds.length === 0) {
        managedAttachmentClaimRollbacks.delete(rollback.runId);
        const retryTimer = managedAttachmentClaimRollbackRetryTimers.get(rollback.runId);
        if (retryTimer !== undefined) clearTimeout(retryTimer);
        managedAttachmentClaimRollbackRetryTimers.delete(rollback.runId);
        managedAttachmentClaimRollbackFailureCounts.delete(rollback.runId);
      } else {
        managedAttachmentClaimRollbacks.set(rollback.runId, {
          ...rollback,
          attachmentIds: remainingAttachmentIds,
          protectedByRunId: undefined,
        });
      }
    }
  }

  async function releaseRunManagedAttachmentClaims(
    runId: string,
    conversationId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    if (attachmentIds.length === 0) return;
    const rollback = { runId, conversationId, attachmentIds: [...attachmentIds] } satisfies ManagedAttachmentClaimRollback;
    managedAttachmentClaimRollbacks.set(runId, rollback);
    const succeeded = await attemptManagedAttachmentClaimRollback(runId);
    if (!succeeded) {
      const current = managedAttachmentClaimRollbacks.get(runId);
      if (current !== undefined) scheduleManagedAttachmentClaimRollback(current);
    }
  }

  async function attemptManagedAttachmentClaimRollback(rollbackRunId: string): Promise<boolean> {
    const rollback = managedAttachmentClaimRollbacks.get(rollbackRunId);
    if (rollback === undefined || rollback.protectedByRunId !== undefined) return true;
    try {
      await requireManagedAttachmentRepository().releaseConversationClaim({
        attachmentIds: rollback.attachmentIds,
        instanceId: input.managedAttachmentInstanceId!,
        conversationId: rollback.conversationId,
        releasedAt: now(),
      });
      if (managedAttachmentClaimRollbacks.get(rollback.runId) === rollback) {
        managedAttachmentClaimRollbacks.delete(rollback.runId);
      }
      managedAttachmentClaimRollbackFailureCounts.delete(rollback.runId);
      return true;
    } catch (error) {
      emitDiagnostic({
        kind: "managed_attachment_claim_rollback_failed",
        runId: rollback.runId,
        conversationId: rollback.conversationId,
        attachmentIds: rollback.attachmentIds,
        error,
      });
      return false;
    }
  }

  function scheduleManagedAttachmentClaimRollback(rollback: ManagedAttachmentClaimRollback): void {
    const current = managedAttachmentClaimRollbacks.get(rollback.runId);
    if (current === undefined || current.protectedByRunId !== undefined || released ||
        managedAttachmentClaimRollbackTasks.has(rollback.runId) ||
        managedAttachmentClaimRollbackRetryTimers.has(rollback.runId)) return;
    const consecutiveFailures = (managedAttachmentClaimRollbackFailureCounts.get(rollback.runId) ?? 0) + 1;
    managedAttachmentClaimRollbackFailureCounts.set(rollback.runId, consecutiveFailures);
    const retryDelayMs = managedAttachmentClaimRollbackRetryDelayMs(consecutiveFailures);
    const retryTimer = setTimeout(() => {
      if (managedAttachmentClaimRollbackRetryTimers.get(rollback.runId) !== retryTimer) return;
      managedAttachmentClaimRollbackRetryTimers.delete(rollback.runId);
      let task!: Promise<void>;
      task = enqueue(`conversation:${rollback.conversationId}`, async () => {
        const succeeded = await attemptManagedAttachmentClaimRollback(rollback.runId);
        if (!succeeded) {
          if (managedAttachmentClaimRollbackTasks.get(rollback.runId) === task) {
            managedAttachmentClaimRollbackTasks.delete(rollback.runId);
          }
          const currentRollback = managedAttachmentClaimRollbacks.get(rollback.runId);
          if (currentRollback !== undefined) scheduleManagedAttachmentClaimRollback(currentRollback);
        }
      });
      managedAttachmentClaimRollbackTasks.set(rollback.runId, task);
      void task.then(
        () => {
          if (managedAttachmentClaimRollbackTasks.get(rollback.runId) === task) {
            managedAttachmentClaimRollbackTasks.delete(rollback.runId);
          }
        },
        () => {
          if (managedAttachmentClaimRollbackTasks.get(rollback.runId) === task) {
            managedAttachmentClaimRollbackTasks.delete(rollback.runId);
          }
        },
      );
    }, retryDelayMs);
    retryTimer.unref?.();
    managedAttachmentClaimRollbackRetryTimers.set(rollback.runId, retryTimer);
  }

  async function startWithinConversation(startInput: StartOrdinaryRunInput): Promise<OrdinaryRunState> {
    assertLive();
    await readyPromise;
    const conversationControl = await loadConversationControl(startInput.turn.conversationId);
    if (conversationControl?.state.deletedAt !== undefined) {
      throw new OrdinaryFeatureError(
        "ordinary_conversation_deleted",
        `Ordinary conversation ${startInput.turn.conversationId} was deleted`,
      );
    }
    if (await load(startInput.runId) !== undefined) {
      throw new OrdinaryFeatureError("ordinary_run_conflict", `Ordinary run ${startInput.runId} already exists`);
    }
    const predecessor = startInput.turn.predecessorRunId === undefined
      ? undefined
      : await load(startInput.turn.predecessorRunId);
    if (startInput.turn.predecessorRunId !== undefined && predecessor === undefined) {
      throw new OrdinaryFeatureError(
        "ordinary_run_not_found",
        `Ordinary predecessor run ${startInput.turn.predecessorRunId} was not found`,
      );
    }
    if (predecessor !== undefined && predecessor.state.turn.conversationId !== startInput.turn.conversationId) {
      throw new OrdinaryFeatureError("ordinary_run_conflict", "Ordinary predecessor must belong to the same conversation");
    }
    if (startInput.turn.ordinal !== (predecessor?.state.turn.ordinal ?? 0) + 1) {
      throw new OrdinaryFeatureError("ordinary_run_conflict", "Ordinary run ordinal must immediately follow its predecessor");
    }
    if (predecessor !== undefined && [...documents.values()].some((document) =>
      document.state.status.kind === "queued" && document.state.turn.predecessorRunId === predecessor.state.runId)) {
      throw new OrdinaryFeatureError(
        "ordinary_run_conflict",
        `Ordinary predecessor run ${predecessor.state.runId} already has a queued successor`,
      );
    }
    const claim = await claimRunManagedAttachments(
      startInput.input,
      startInput.turn.conversationId,
      startInput.runId,
    );
    const initial = createInitialOrdinaryRunState({
      runId: startInput.runId,
      sessionRef: startInput.sessionRef,
      turn: startInput.turn,
      runInput: claim.runInput,
      birth: startInput.birth,
      recordedAt: now(),
      eventId: idFactory("ordinary-event"),
    });
    let created: OrdinaryRunSnapshotDocument;
    try {
      created = await input.repository.save(initial, 0);
    } catch (error) {
      releaseManagedAttachmentClaimReservations(claim.claimReservations, startInput.runId);
      await releaseRunManagedAttachmentClaims(
        startInput.runId,
        startInput.turn.conversationId,
        claim.newlyClaimedAttachmentIds,
      );
      throw error;
    }
    commitManagedAttachmentClaimReservations(claim.claimReservations, startInput.runId);
    documents.set(initial.runId, created);
    recordTransition(initial.timeline[0]);
    if (predecessor === undefined) {
      try {
        const running = await mutate(initial.runId, { type: "start" });
        track(initial.runId, runExecution(initial.runId));
        return running;
      } catch (error) {
        const retry = requestConversationActivation(initial.turn.conversationId, initial.runId);
        trackPostExecutionTask(retry);
        throw error;
      }
    }

    // The predecessor may have committed its terminal state while this run's
    // birth snapshot was being written. Re-read after the successor exists so
    // either this path or the predecessor's terminal callback must activate it.
    const latestPredecessor = await load(predecessor.state.runId);
    if (latestPredecessor !== undefined && isTerminal(latestPredecessor.state)) {
      await activateSuccessor(latestPredecessor.state.runId);
    }
    const current = await load(initial.runId);
    if (current === undefined) {
      throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${initial.runId} was not found after creation`);
    }
    return clone(current.state);
  }

  async function start(startInput: StartOrdinaryRunInput): Promise<OrdinaryRunState> {
    return enqueue(`conversation:${startInput.turn.conversationId}`, async () => {
      await settlePendingUncommittedConversationCleanup(startInput.turn.conversationId);
      return startWithinConversation(startInput);
    });
  }

  async function submitTurn(submitInput: SubmitOrdinaryTurnInput): Promise<SubmitOrdinaryTurnResult> {
    assertLive();
    await readyPromise;
    if (submitInput.conversationId !== undefined && submitInput.newConversationId !== undefined) {
      throw new OrdinaryFeatureError(
        "ordinary_submission_conflict",
        "conversationId and newConversationId are mutually exclusive",
      );
    }
    const submissionId = normalizedSubmissionId(submitInput.submissionId);
    const submissionTurnId = submissionId === undefined ? undefined : `submission:${submissionId}`;
    const conversationId = submitInput.conversationId ?? submitInput.newConversationId ?? (
      submissionId === undefined ? idFactory("conversation") : `conversation:${submissionId}`
    );
    return enqueue(`conversation:${conversationId}`, async () => {
      await settlePendingUncommittedConversationCleanup(conversationId);
      let createdConversation = false;
      let createdConversationSession: AgentSessionRef | undefined;
      if (submissionTurnId !== undefined) {
        const existing = [...documents.values()].find((document) =>
          document.state.turn.userTurnId === submissionTurnId);
        if (existing !== undefined) {
          if (existing.state.turn.conversationId !== conversationId ||
            !sameSubmissionInput(existing.state.input, submitInput.input)) {
            throw new OrdinaryFeatureError(
              "ordinary_submission_conflict",
              `Ordinary submission ${submissionId} was already used for different input.`,
            );
          }
          const existingControl = await loadConversationControl(conversationId);
          if (existingControl === undefined) {
            throw new OrdinaryFeatureError(
              "ordinary_conversation_not_found",
              `Ordinary conversation ${conversationId} was not found`,
            );
          }
          assertConversationWritable(existingControl);
          const existingConversation = await conversationView(existingControl);
          if (existingConversation === undefined) {
            throw new OrdinaryFeatureError(
              "ordinary_conversation_not_found",
              `Ordinary conversation ${conversationId} has no visible submission`,
            );
          }
          return { conversation: existingConversation, run: clone(existing.state) };
        }
      }
      let control = await loadConversationControl(conversationId);
      if (control === undefined) {
        if (submitInput.conversationId !== undefined) {
          throw new OrdinaryFeatureError(
            "ordinary_conversation_not_found",
            `Ordinary conversation ${conversationId} was not found`,
          );
        }
        if (submitInput.owner === undefined) {
          throw new OrdinaryFeatureError(
            "ordinary_conversation_owner_required",
            "A conversation owner is required when creating an Ordinary conversation.",
          );
        }
        const createdAt = now();
        const sessionRef = await input.sessionRepository.create({
          sessionId: idFactory("agent-session"),
          sessionCwd: submitInput.birth.capabilitySnapshot.executionRoot,
        });
        createdConversationSession = sessionRef;
        const state: OrdinaryConversationControlState = {
          conversationId,
          createdAt,
          sessionRef,
          owner: submitInput.owner,
        };
        pendingUncommittedConversationBirths.set(conversationId, { sessionRef });
        try {
          control = await input.conversationRepository.save(state, 0, createdAt);
        } catch (error) {
          await reconcilePendingUncommittedConversationBirth(conversationId);
          throw error;
        }
        pendingUncommittedConversationBirths.delete(conversationId);
        conversationDocuments.set(conversationId, control);
        createdConversation = true;
      }
      assertConversationWritable(control);
      const runs = await visibleRuns(control);
      const predecessor = runs.at(-1);
      const runId = idFactory("ordinary-run");
      try {
        const run = await startWithinConversation({
          runId,
          sessionRef: control.state.sessionRef,
          turn: {
            conversationId,
            ordinal: (predecessor?.turn.ordinal ?? 0) + 1,
            userTurnId: submissionTurnId ?? idFactory("ordinary-user-turn"),
            assistantTurnId: idFactory("ordinary-assistant-turn"),
            ...(predecessor === undefined ? {} : { predecessorRunId: predecessor.runId }),
          },
          input: submitInput.input,
          birth: submitInput.birth,
        });
        const conversation = await conversationView(control);
        if (conversation === undefined) throw new Error(`Ordinary conversation ${conversationId} has no visible run after submission`);
        return { conversation, run };
      } catch (error) {
        if (createdConversation && createdConversationSession !== undefined) {
          await cleanupFailedInitialConversationBirth({
            conversationId,
            sessionRef: createdConversationSession,
            runId,
          });
        }
        throw error;
      }
    });
  }

  async function reconcilePendingUncommittedConversationBirth(conversationId: string): Promise<void> {
    const pending = pendingUncommittedConversationBirths.get(conversationId);
    if (pending === undefined) return;
    let control: OrdinaryConversationControlDocument | undefined;
    try {
      control = await input.conversationRepository.get(conversationId);
    } catch (error) {
      emitDiagnostic({
        kind: "conversation_cleanup_failed",
        conversationId,
        phase: "conversation_control",
        error,
      });
      return;
    }
    if (control === undefined) {
      try {
        await input.sessionRepository.delete(pending.sessionRef);
        pendingUncommittedConversationBirths.delete(conversationId);
      } catch (error) {
        emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "session", error });
      }
      return;
    }
    if (control.state.deletedAt !== undefined ||
        control.state.sessionRef.sessionId !== pending.sessionRef.sessionId) {
      emitDiagnostic({
        kind: "conversation_cleanup_failed",
        conversationId,
        phase: "conversation_control",
        error: new Error("Persisted conversation control does not match the unresolved birth."),
      });
      return;
    }
    let runIds: readonly string[];
    try {
      runIds = (await input.repository.list(Number.MAX_SAFE_INTEGER))
        .filter((summary) => summary.conversationId === conversationId)
        .map((summary) => summary.runId);
    } catch (error) {
      emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "run_enumeration", error });
      return;
    }
    conversationDocuments.set(conversationId, control);
    pendingUncommittedConversationBirths.delete(conversationId);
    await scheduleConversationCleanup(conversationId, control, runIds, "delete_uncommitted");
  }

  async function settlePendingUncommittedConversationCleanup(conversationId: string): Promise<void> {
    if (pendingUncommittedConversationBirths.has(conversationId)) {
      await reconcilePendingUncommittedConversationBirth(conversationId);
      if (pendingUncommittedConversationBirths.has(conversationId)) {
        throw new OrdinaryFeatureError(
          "ordinary_conversation_cleanup_pending",
          `Ordinary conversation ${conversationId} has an unresolved birth; retry this operation.`,
        );
      }
    }
    const pending = pendingUncommittedConversationCleanups.get(conversationId);
    if (pending === undefined) return;
    await scheduleConversationCleanup(
      conversationId,
      pending.control,
      pending.runIds,
      "delete_uncommitted",
    );
    if (pendingUncommittedConversationCleanups.has(conversationId)) {
      throw new OrdinaryFeatureError(
        "ordinary_conversation_cleanup_pending",
        `Ordinary conversation ${conversationId} is still being cleaned up; retry this operation.`,
      );
    }
  }

  async function cleanupFailedInitialConversationBirth(inputValue: {
    readonly conversationId: string;
    readonly sessionRef: AgentSessionRef;
    readonly runId: string;
  }): Promise<void> {
    // A save can fail after the snapshot reached durable storage. Read the
    // repository directly so startup enumeration failures cannot mistake an
    // unknown run for an uncommitted birth.
    let persistedRun: OrdinaryRunSnapshotDocument | undefined;
    let runLookupFailed = false;
    try {
      persistedRun = await input.repository.get(inputValue.runId);
    } catch (error) {
      runLookupFailed = true;
      emitDiagnostic({
        kind: "conversation_cleanup_failed",
        conversationId: inputValue.conversationId,
        phase: "run_snapshot",
        runId: inputValue.runId,
        error,
      });
    }
    if (persistedRun !== undefined && documents.has(inputValue.runId)) return;

    const control = conversationDocuments.get(inputValue.conversationId);
    if (control === undefined || control.state.deletedAt !== undefined ||
        control.state.sessionRef.sessionId !== inputValue.sessionRef.sessionId) return;
    await scheduleConversationCleanup(
      inputValue.conversationId,
      control,
      runLookupFailed || persistedRun !== undefined ? [inputValue.runId] : [],
      "delete_uncommitted",
    );
  }

  async function mutateConversation(
    conversationId: string,
    update: (state: OrdinaryConversationControlState, changedAt: string) => OrdinaryConversationControlState,
  ): Promise<OrdinaryConversationControlDocument> {
    assertLive();
    await readyPromise;
    return enqueue(`conversation:${conversationId}`, async () => {
      await settlePendingUncommittedConversationCleanup(conversationId);
      const current = await loadConversationControl(conversationId);
      if (current === undefined) {
        throw new OrdinaryFeatureError(
          "ordinary_conversation_not_found",
          `Ordinary conversation ${conversationId} was not found`,
        );
      }
      assertConversationWritable(current);
      const changedAt = now();
      const saved = await input.conversationRepository.save(update(clone(current.state), changedAt), current.revision, changedAt);
      conversationDocuments.set(conversationId, saved);
      return saved;
    });
  }

  async function renameConversation(conversationId: string, title: string): Promise<OrdinaryConversationReadModel> {
    const normalized = normalizeOrdinaryConversationTitle(title);
    const control = await mutateConversation(conversationId, (state, changedAt) => ({
      ...state, titleOverride: normalized, titleEditedAt: changedAt,
    }));
    return requireConversationView(control);
  }

  async function setConversationPinned(conversationId: string, pinned: boolean): Promise<OrdinaryConversationReadModel> {
    const control = await mutateConversation(conversationId, (state, changedAt) => ({
      ...state, pinnedAt: pinned ? state.pinnedAt ?? changedAt : undefined,
    }));
    return requireConversationView(control);
  }

  async function rollbackConversation(rollback: {
    readonly conversationId: string;
    readonly targetRunId?: string;
    readonly stepsBack?: number;
  }): Promise<OrdinaryConversationReadModel> {
    const control = await enqueue(`conversation:${rollback.conversationId}`, async () => {
      await settlePendingUncommittedConversationCleanup(rollback.conversationId);
      const current = await loadConversationControl(rollback.conversationId);
      if (current === undefined) {
        throw new OrdinaryFeatureError("ordinary_conversation_not_found", `Ordinary conversation ${rollback.conversationId} was not found`);
      }
      assertConversationWritable(current);
      const runs = await visibleRuns(current);
      if (runs.some((run) => !isTerminal(run))) {
        throw new OrdinaryFeatureError("ordinary_conversation_busy", "Cannot roll back a busy Ordinary conversation");
      }
      const completed = runs.filter((run) => run.status.kind === "completed");
      const target = rollback.targetRunId === undefined
        ? completed[Math.max(0, completed.length - Math.max(1, Math.floor(rollback.stepsBack ?? 1)) - 1)]
        : completed.find((run) => run.runId === rollback.targetRunId);
      if (target === undefined || target.session.phase !== "rollbackable") {
        throw new OrdinaryFeatureError("ordinary_rollback_target_not_found", "Ordinary rollback target was not found in completed visible runs");
      }
      const targetIndex = runs.findIndex((run) => run.runId === target.runId);
      const unretiredPreSessionTurns = runs.slice(targetIndex + 1).filter((run) =>
        run.session.phase === "not_started" && isTerminal(run));
      if (unretiredPreSessionTurns.length > 0) {
        throw new OrdinaryFeatureError(
          "ordinary_run_state_conflict",
          "Cannot roll back across terminal turns that never entered the Session until those turns have a durable retirement fact",
        );
      }
      await input.sessionRepository.moveActiveLeaf(current.state.sessionRef, target.session.endLeafRef);
      return current;
    });
    return requireConversationView(control);
  }

  async function deleteConversation(conversationId: string): Promise<void> {
    assertLive();
    await readyPromise;
    let cleanup: {
      readonly tombstone: OrdinaryConversationControlDocument;
      readonly runIds: readonly string[];
    } | undefined;
    await enqueue(`conversation:${conversationId}`, async () => {
      await settlePendingUncommittedConversationCleanup(conversationId);
      const current = await loadConversationControl(conversationId);
      if (current === undefined) return;
      let tombstone = current;
      if (current.state.deletedAt === undefined) {
        const deletedAt = now();
        tombstone = await input.conversationRepository.save({ ...current.state, deletedAt }, current.revision, deletedAt);
        conversationDocuments.set(conversationId, tombstone);
      }
      const owned = [...documents.values()].filter((document) => document.state.turn.conversationId === conversationId);
      for (const document of owned) {
        if (!isTerminal(document.state)) await cancel(document.state.runId, "conversation_deleted");
      }
      cleanup = {
        tombstone,
        runIds: [...new Set(owned.map((document) => document.state.runId))],
      };
    });
    if (cleanup !== undefined) {
      void scheduleConversationCleanup(conversationId, cleanup.tombstone, cleanup.runIds);
    }
  }

  function scheduleConversationCleanup(
    conversationId: string,
    control: OrdinaryConversationControlDocument,
    runIds: readonly string[],
    controlDisposition: "retain_tombstone" | "delete_uncommitted" = "retain_tombstone",
  ): Promise<void> | undefined {
    if (released) return undefined;
    let cleanupControl = control;
    let scheduledRunIds = runIds;
    let pendingState: {
      readonly control: OrdinaryConversationControlDocument;
      readonly runIds: readonly string[];
    } | undefined;
    if (controlDisposition === "delete_uncommitted") {
      const existing = pendingUncommittedConversationCleanups.get(conversationId);
      pendingState = {
        control: existing === undefined || control.revision >= existing.control.revision
          ? control
          : existing.control,
        runIds: [...new Set([...(existing?.runIds ?? []), ...runIds])],
      };
      pendingUncommittedConversationCleanups.set(conversationId, pendingState);
      cleanupControl = pendingState.control;
      scheduledRunIds = pendingState.runIds;
    }
    const pendingRetry = conversationCleanupRetryTimers.get(conversationId);
    if (pendingRetry !== undefined) {
      clearTimeout(pendingRetry);
      conversationCleanupRetryTimers.delete(conversationId);
    }
    const activeCleanup = conversationCleanupTasks.get(conversationId);
    if (activeCleanup !== undefined) return activeCleanup;
    let retryNeeded = false;
    const cleanup = (async () => {
      const cleanupRunIds = new Set(scheduledRunIds);
      if (controlDisposition === "retain_tombstone") {
        try {
          const persisted = await input.repository.list(Number.MAX_SAFE_INTEGER);
          for (const summary of persisted) {
            if (summary.conversationId === conversationId) cleanupRunIds.add(summary.runId);
          }
        } catch (error) {
          retryNeeded = true;
          emitDiagnostic({
            kind: "conversation_cleanup_failed",
            conversationId,
            phase: "run_enumeration",
            error,
          });
        }
      }
      for (const runId of cleanupRunIds) {
        const execution = executions.get(runId);
        if (execution !== undefined) await execution.catch(() => undefined);
        const cancellationCleanup = cancellationCleanupTasks.get(runId);
        if (cancellationCleanup !== undefined) await cancellationCleanup.catch(() => undefined);
        try {
          await settleExecution(runId);
        } catch (error) {
          retryNeeded = true;
          emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "terminal_settlement", runId, error });
          continue;
        }
        if (input.releaseToolEvidenceOwner !== undefined) {
          try {
            await input.releaseToolEvidenceOwner(runId);
          } catch (error) {
            retryNeeded = true;
            emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "tool_evidence", runId, error });
            continue;
          }
        }
        try {
          await memoryFactRepository.deleteByRunIds([runId]);
        } catch (error) {
          retryNeeded = true;
          emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "memory_facts", runId, error });
          continue;
        }
        try {
          await input.repository.delete(runId);
        } catch (error) {
          retryNeeded = true;
          emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "run_snapshot", runId, error });
          continue;
        }
        documents.delete(runId);
        acceptedToolResults.delete(runId);
        activityStreams.delete(runId);
        listeners.delete(runId);
      }
      if ((controlDisposition === "retain_tombstone" || (!retryNeeded && cleanupRunIds.size > 0)) &&
          input.managedAttachmentRepository !== undefined) {
        try {
          await input.managedAttachmentRepository.deleteConversation(conversationId);
        } catch (error) {
          retryNeeded = true;
          emitDiagnostic({ kind: "managed_attachment_cleanup_failed", conversationId, error });
        }
      }
      if (controlDisposition === "retain_tombstone" || !retryNeeded) {
        try {
          await input.sessionRepository.delete(cleanupControl.state.sessionRef);
        } catch (error) {
          retryNeeded = true;
          emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "session", error });
        }
      }
      if (!retryNeeded && controlDisposition === "delete_uncommitted") {
        try {
          await input.conversationRepository.delete(conversationId, cleanupControl.revision);
          conversationDocuments.delete(conversationId);
          unavailableConversationIds.delete(conversationId);
        } catch (error) {
          retryNeeded = true;
          emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "conversation_control", error });
        }
      }
    })();
    const tracked = cleanup.finally(() => {
      if (conversationCleanupTasks.get(conversationId) === tracked) conversationCleanupTasks.delete(conversationId);
      if (!retryNeeded) {
        if (controlDisposition === "delete_uncommitted" &&
            pendingUncommittedConversationCleanups.get(conversationId) === pendingState) {
          pendingUncommittedConversationCleanups.delete(conversationId);
        }
        conversationCleanupFailureCounts.delete(conversationId);
        return;
      }
      if (released) return;
      const consecutiveFailures = (conversationCleanupFailureCounts.get(conversationId) ?? 0) + 1;
      conversationCleanupFailureCounts.set(conversationId, consecutiveFailures);
      const retryDelayMs = conversationCleanupRetryDelayMs(consecutiveFailures);
      const retryTimer = setTimeout(() => {
        if (conversationCleanupRetryTimers.get(conversationId) !== retryTimer) return;
        conversationCleanupRetryTimers.delete(conversationId);
        void scheduleConversationCleanup(conversationId, cleanupControl, scheduledRunIds, controlDisposition);
      }, retryDelayMs);
      retryTimer.unref?.();
      conversationCleanupRetryTimers.set(conversationId, retryTimer);
    });
    conversationCleanupTasks.set(conversationId, tracked);
    return tracked;
  }

  async function createManagedAttachmentDraft(draftInput: {
    readonly originalName: string;
    readonly mimeType?: string;
    readonly content: Uint8Array;
    readonly uploadRequestId?: string;
    readonly uploadFileIndex?: number;
  }) {
    assertLive();
    await readyPromise;
    const repository = requireManagedAttachmentRepository();
    const attachmentId = managedAttachmentDraftId(
      draftInput.uploadRequestId,
      draftInput.uploadFileIndex,
      idFactory,
    );
    try {
      return await repository.createDraft({
        attachmentId,
        instanceId: input.managedAttachmentInstanceId!,
        originalName: draftInput.originalName,
        ...(draftInput.mimeType === undefined ? {} : { mimeType: draftInput.mimeType }),
        content: draftInput.content,
        createdAt: now(),
      });
    } catch (error) {
      if (error instanceof OrdinaryManagedAttachmentRepositoryError && (
        error.code === "ordinary_managed_attachment_ownership_conflict" ||
        error.code === "ordinary_managed_attachment_invalid_id" ||
        error.code === "ordinary_managed_attachment_invalid_input"
      )) {
        throw new OrdinaryFeatureError(
          "ordinary_managed_attachment_unavailable",
          error.message,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async function discardManagedAttachmentDraft(attachmentId: string): Promise<void> {
    assertLive();
    await readyPromise;
    try {
      await requireManagedAttachmentRepository().discardDraft({
        attachmentId,
        instanceId: input.managedAttachmentInstanceId!,
      });
    } catch (error) {
      if (error instanceof OrdinaryManagedAttachmentRepositoryError && (
        error.code === "ordinary_managed_attachment_ownership_conflict" ||
        error.code === "ordinary_managed_attachment_invalid_id" ||
        error.code === "ordinary_managed_attachment_invalid_input"
      )) {
        throw new OrdinaryFeatureError(
          "ordinary_managed_attachment_unavailable",
          error.message,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async function visibleRuns(control: OrdinaryConversationControlDocument): Promise<readonly OrdinaryRunState[]> {
    const runs = [...documents.values()].map((document) => document.state);
    const activeBranch = await input.sessionRepository.getActiveBranchEntryRefs(control.state.sessionRef);
    return visibleOrdinaryConversationRuns(control, runs, activeBranch);
  }

  async function conversationView(control: OrdinaryConversationControlDocument): Promise<OrdinaryConversationReadModel | undefined> {
    if (control.state.deletedAt !== undefined) return undefined;
    const runs = await visibleRuns(control);
    const completedAnswers = runs.flatMap((run) =>
      run.status.kind === "completed" && run.session.phase === "rollbackable"
        ? [{ runId: run.runId, entryRef: run.session.endLeafRef }]
        : []);
    const assistantEntries = completedAnswers.length === 0
      ? []
      : await input.sessionRepository.readAssistantEntries({
          sessionRef: control.state.sessionRef,
          entryRefs: completedAnswers.map((answer) => answer.entryRef),
        });
    const assistantTextByEntryRef = new Map(assistantEntries.map((entry) =>
      [sessionEntryKey(entry.entryRef), entry.text] as const));
    return projectOrdinaryConversation({
      control,
      runs,
      completedAssistantTextByRunId: new Map(completedAnswers.flatMap((answer) => {
        const text = assistantTextByEntryRef.get(sessionEntryKey(answer.entryRef));
        return text === undefined ? [] : [[answer.runId, text] as const];
      })),
    });
  }

  async function requireConversationView(control: OrdinaryConversationControlDocument): Promise<OrdinaryConversationReadModel> {
    const view = await conversationView(control);
    if (view === undefined) throw new Error(`Ordinary conversation ${control.state.conversationId} has no visible turns`);
    return view;
  }

  async function cancel(runId: string, reason = "cancelled_by_user"): Promise<OrdinaryRunState> {
    assertLive();
    await readyPromise;
    const cancellation = await enqueue(runId, async () => {
      const current = await load(runId);
      if (current === undefined) {
        throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${runId} was not found`);
      }
      const wasTerminal = isTerminal(current.state);
      // Persisting the terminal fact is the cancellation linearization point.
      // A failed save must leave both the durable run and live execution active.
      const state = wasTerminal
        ? clone(current.state)
        : await commitTransition(runId, { type: "cancel", reason }, { keepTerminal: true });
      controllers.get(runId)?.abort(reason);
      const continuation = continuations.get(runId);
      continuations.delete(runId);
      return {
        state,
        continuation,
        finalizeSession: !wasTerminal || sessionFinalizationPending.has(runId),
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
    if (continuation !== undefined) cancellationCleanupContinuations.set(runId, continuation);
    if (released) return;
    const pendingRetry = cancellationCleanupRetryTimers.get(runId);
    if (pendingRetry !== undefined) {
      clearTimeout(pendingRetry);
      cancellationCleanupRetryTimers.delete(runId);
    }
    if (cancellationCleanupTasks.has(runId)) return;
    let retryNeeded = false;
    const cleanup = (async () => {
      const pendingContinuation = cancellationCleanupContinuations.get(runId);
      if (pendingContinuation !== undefined) {
        try {
          await pendingContinuation.release();
        } catch (error) {
          retryNeeded = true;
          emitDiagnostic({ kind: "cancellation_cleanup_failed", runId, phase: "continuation_release", error });
          return;
        }
        if (cancellationCleanupContinuations.get(runId) === pendingContinuation) {
          cancellationCleanupContinuations.delete(runId);
        }
      }
      if (!executions.has(runId) && !approvalReservations.has(runId) && !continuations.has(runId)) {
        controllers.delete(runId);
      }
      if (finalizeSession) {
        try {
          await finalizeExecutionSession(runId, state, state.status.kind !== "completed");
        } catch {
          // Keep owning the post-commit cleanup even when no new scheduling
          // event arrives to trigger the Session finalization retry path.
          retryNeeded = true;
          return;
        }
      }
      const stillHasLiveExecution = executions.has(runId) || approvalReservations.has(runId) ||
        controllers.has(runId);
      if (!stillHasLiveExecution) {
        try {
          await settleExecution(runId);
        } catch (error) {
          retryNeeded = true;
          emitDiagnostic({ kind: "cancellation_cleanup_failed", runId, phase: "terminal_settlement", error });
          return;
        }
      }
      await activateSuccessor(runId);
      notifyStableTerminal(runId);
    })();
    const tracked = cleanup.finally(() => {
      if (cancellationCleanupTasks.get(runId) === tracked) cancellationCleanupTasks.delete(runId);
      if (!retryNeeded) {
        cancellationCleanupFailureCounts.delete(runId);
        return;
      }
      if (released) return;
      const consecutiveFailures = (cancellationCleanupFailureCounts.get(runId) ?? 0) + 1;
      cancellationCleanupFailureCounts.set(runId, consecutiveFailures);
      const retryDelayMs = cancellationCleanupRetryDelayMs(consecutiveFailures);
      const retryTimer = setTimeout(() => {
        if (cancellationCleanupRetryTimers.get(runId) !== retryTimer) return;
        cancellationCleanupRetryTimers.delete(runId);
        scheduleCancellationCleanup(runId, state, finalizeSession, undefined);
      }, retryDelayMs);
      retryTimer.unref?.();
      cancellationCleanupRetryTimers.set(runId, retryTimer);
    });
    cancellationCleanupTasks.set(runId, tracked);
    trackPostExecutionTask(tracked);
  }

  async function decideApproval(input: DecideOrdinaryApprovalInput): Promise<OrdinaryRunState> {
    assertLive();
    await readyPromise;
    const ownerRunId = input.ownerRunId;
    const decision: ConfirmationDecision = {
      confirmationId: input.confirmationId,
      decision: input.decision,
      decidedAt: input.decidedAt,
      ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
    };
    let controller: AbortController | undefined;
    let createdController = false;
    let continuation: OrdinaryExecutionContinuation | undefined;
    const reserved = await enqueue(ownerRunId, async () => {
      if (approvalReservations.has(ownerRunId)) {
        throw new OrdinaryFeatureError(
          "ordinary_confirmation_in_progress",
          `A confirmation decision is already in progress for Ordinary run ${ownerRunId}`,
        );
      }
      const document = await load(ownerRunId);
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
      continuation = continuations.get(ownerRunId);
      if (continuation === undefined) {
        return clone(document.state);
      }
      controller = controllers.get(ownerRunId);
      if (controller === undefined) {
        // A live-only continuation normally retains the original run
        // controller. This fallback keeps older in-process continuations
        // cancellable without claiming they are durable across restart.
        controller = new AbortController();
        controllers.set(ownerRunId, controller);
        createdController = true;
      }
      approvalReservations.set(ownerRunId, decision.confirmationId);
      continuations.delete(ownerRunId);
      try {
        return await commitTransition(ownerRunId, { type: "approval_decided", decision });
      } catch (error) {
        approvalReservations.delete(ownerRunId);
        if (createdController && controllers.get(ownerRunId) === controller) controllers.delete(ownerRunId);
        continuations.set(ownerRunId, continuation);
        throw error;
      }
    });
    if (continuation === undefined) {
      const blocked = await blockLostApproval(ownerRunId, {
          code: "confirmation_continuation_lost",
          message: "The live confirmation continuation is no longer available.",
      });
      await activateSuccessor(ownerRunId);
      notifyStableTerminal(ownerRunId);
      return blocked;
    }
    const operation = (async () => {
      let outcome: OrdinaryExecutionOutcome | undefined;
      try {
        recordModelRequest(ownerRunId, "after_approval");
        outcome = await continuation!.decide({ decision, abortSignal: controller!.signal });
        await completeReasoning(ownerRunId);
        rememberToolResults(ownerRunId, outcome.toolCalls);
        await applyOutcome(ownerRunId, outcome);
        forgetPersistedToolResults(ownerRunId, outcome.toolCalls);
      } catch (error) {
        if (await handleCompletedCommitFailure(ownerRunId, outcome, error)) return;
        let failure = error;
        try {
          await completeReasoning(ownerRunId);
        } catch (reasoningError) {
          failure = reasoningError;
        }
        const latest = await load(ownerRunId);
        if (latest !== undefined && !isTerminal(latest.state)) {
          const terminal = await mutate(ownerRunId, {
            type: controller!.signal.aborted ? "cancel" : "fail",
            ...(controller!.signal.aborted
              ? { reason: cancellationReason(controller!.signal.reason) }
              : { error: ordinaryExecutionFailureFacts(failure) }),
            ...(outcome === undefined
              ? {}
              : {
                  toolCalls: outcome.toolCalls,
                  usage: outcome.usage,
                  toolMetrics: outcome.toolMetrics,
                  capabilityResolution: outcome.capabilityResolution,
                }),
          } as OrdinaryRunTransition, { keepTerminal: controller!.signal.aborted });
          await finalizeExecutionSession(ownerRunId, terminal, true);
        }
      } finally {
        try {
          await settleExecution(ownerRunId);
        } finally {
          if (outcome?.status !== "approval_required" && controllers.get(ownerRunId) === controller) {
            controllers.delete(ownerRunId);
          }
          if (approvalReservations.get(ownerRunId) === decision.confirmationId) {
            approvalReservations.delete(ownerRunId);
          }
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

  function assertLive(): void {

    if (released) {
      throw new OrdinaryFeatureError("ordinary_feature_released", "Ordinary Agent is shutting down");
    }
  }

  function isDeletedConversation(conversationId: string): boolean {
    return conversationDocuments.get(conversationId)?.state.deletedAt !== undefined;
  }

  function isHiddenConversation(conversationId: string): boolean {
    return isDeletedConversation(conversationId) || unavailableConversationIds.has(conversationId);
  }

  function isHiddenRun(state: OrdinaryRunState): boolean {
    return isHiddenConversation(state.turn.conversationId);
  }

  function requireManagedAttachmentRepository(): OrdinaryManagedAttachmentRepository {
    if (input.managedAttachmentRepository === undefined || input.managedAttachmentInstanceId === undefined) {
      throw new OrdinaryFeatureError(
        "ordinary_managed_attachment_unavailable",
        "Ordinary managed attachment storage is unavailable.",
      );
    }
    return input.managedAttachmentRepository;
  }

  async function recordMemoryRead(
    factInput: Omit<OrdinaryMemoryFact, "kind" | "memoryKind" | "recordedAt" | "conversationId">,
  ): Promise<void> {
    await readyPromise;
    await enqueue(factInput.runId, async () => {
      const document = await load(factInput.runId);
      if (document === undefined || isHiddenRun(document.state)) {
        throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${factInput.runId} was not found.`);
      }
      assertMemoryFactOwnerAllowed(document.state, factInput.owner);
      await memoryFactRepository.append({
        ...factInput,
        conversationId: document.state.turn.conversationId,
        kind: "read",
        memoryKind: "path_dependency",
        recordedAt: now(),
      });
    });
  }

  async function recordMemoryReference(
    factInput: Omit<OrdinaryMemoryFact, "kind" | "memoryKind" | "recordedAt" | "conversationId">,
  ): Promise<"recorded" | "already_recorded" | "not_read"> {
    await readyPromise;
    return enqueue(factInput.runId, async () => {
      const document = await load(factInput.runId);
      if (document === undefined || isHiddenRun(document.state)) {
        throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${factInput.runId} was not found.`);
      }
      assertMemoryFactOwnerAllowed(document.state, factInput.owner);
      const facts = await memoryFactRepository.list({ runId: factInput.runId, memoryId: factInput.memoryId });
      const read = facts.some((fact) =>
        fact.kind === "read" &&
        fact.memoryKind === "path_dependency" &&
        fact.revision === factInput.revision &&
        fact.title === factInput.title &&
        memoryOwnerKey(fact.owner) === memoryOwnerKey(factInput.owner));
      if (!read) return "not_read";
      return memoryFactRepository.append({
        ...factInput,
        conversationId: document.state.turn.conversationId,
        kind: "applied",
        memoryKind: "path_dependency",
        recordedAt: now(),
      });
    });
  }

  function assertMemoryFactOwnerAllowed(run: OrdinaryRunState, owner: OrdinaryMemoryFact["owner"]): void {
    const runOwner = run.birth.memoryOwner;
    if (!memoryOwnersForConversation(runOwner)
      .some((candidate) => memoryOwnerKey(candidate) === memoryOwnerKey(owner))) {
      throw new OrdinaryFeatureError(
        "ordinary_memory_scope_unavailable",
        `Memory owner ${memoryOwnerKey(owner)} is outside the frozen scope of Ordinary run ${run.runId}.`,
      );
    }
  }

  return {
    commands: {
      start,
      submitTurn,
      renameConversation,
      setConversationPinned,
      rollbackConversation,
      deleteConversation,
      createManagedAttachmentDraft,
      discardManagedAttachmentDraft,
      cancel,
      decideApproval,
      recordMemoryRead,
      recordMemoryReference,
    },
    queries: {
      async getRun(runId) {
        await readyPromise;
        const document = await load(runId);
        return document === undefined || isHiddenRun(document.state) ? undefined : clone(document.state);
      },
      async listRuns(limit) {
        await readyPromise;
        const summaries = await input.repository.list(Number.MAX_SAFE_INTEGER);
        const visible = summaries.filter((summary) =>
          (!startupRunEnumerationFailed || documents.has(summary.runId)) && !isHiddenConversation(summary.conversationId));
        return limit === undefined ? visible : visible.slice(0, Math.max(0, Math.floor(limit)));
      },
      async getConversation(conversationId) {
        await readyPromise;
        const control = await loadConversationControl(conversationId);
        return control === undefined ? undefined : clone(await conversationView(control));
      },
      async getConversationOwner(conversationId) {
        await readyPromise;
        const control = await loadConversationControl(conversationId);
        return control === undefined ? undefined : control.state.owner;
      },
      async listConversationsByOwner(owner) {
        await readyPromise;
        const projected = await Promise.all([...conversationDocuments.values()].map((control) =>
          control.state.owner !== undefined &&
          control.state.owner.kind === owner.kind &&
          control.state.owner.id === owner.id
            ? conversationView(control)
            : Promise.resolve(undefined)));
        return clone(projected.filter((view): view is OrdinaryConversationReadModel => view !== undefined));
      },
      async listConversations(limit = 50) {
        await readyPromise;
        const projected = await Promise.all([...conversationDocuments.values()].map((control) => conversationView(control)));
        const views = projected.filter((view): view is OrdinaryConversationReadModel => view !== undefined).sort((left, right) => {
          const pinned = (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "");
          return pinned === 0 ? right.updatedAt.localeCompare(left.updatedAt) : pinned;
        });
        return clone(views.slice(0, Math.max(0, Math.floor(limit))));
      },
      async getManagedAttachment(attachmentId) {
        await readyPromise;
        try {
          return clone(await requireManagedAttachmentRepository().get(attachmentId));
        } catch (error) {
          if (isManagedAttachmentNotFound(error)) return undefined;
          throw error;
        }
      },
      async listMemoryFacts(query) {
        await readyPromise;
        return structuredClone(await memoryFactRepository.list(query));
      },
      async getStableTerminalRunFacts(runId) {
        // Startup reconciliation must finish first so recovered runs already
        // closed their lost continuations, pending tool rounds and approvals.
        await readyPromise;
        const document = await load(runId);
        if (document === undefined || isHiddenRun(document.state) || !isStableTerminalState(document.state)) return undefined;
        return projectStableTerminalRunFacts(document);
      },
    },
    events: {
      async replay(runId, cursor) {
        await readyPromise;
        const document = await load(runId);
        if (document === undefined || isHiddenRun(document.state)) return undefined;
        // Live runs use the cached mutable stream. Settled terminal runs whose
        // stream was already released rebuild an ephemeral projection instead of
        // re-pinning it: the stream is a pure function of the persisted document,
        // so a deterministic streamId keeps concurrent and repeated replays
        // cursor-stable without holding the duplicate timeline in memory.
        const stream = activityStreams.get(runId) ?? (
          needsLiveActivityStream(document.state)
            ? await restorePersistedActivityStream(document.state)
            : await terminalReplayStream(document)
        );
        const reset = cursor !== undefined && (
          cursor.streamId !== stream.streamId || cursor.sequence < 0 || cursor.sequence >= stream.nextSequence
        );
        const afterSequence = cursor === undefined || reset ? 0 : cursor.sequence;
        return {
          cursor: activityCursor(stream),
          reset,
          activities: clone(stream.activities
            .filter((activity) => activity.sequence > afterSequence)
            .sort((left, right) => left.sequence - right.sequence)),
        };
      },
      subscribe(runId, listener) {
        assertLive();
        const runListeners = listeners.get(runId) ?? new Set();
        runListeners.add(listener);
        listeners.set(runId, runListeners);
        return () => {
          runListeners.delete(listener);
          if (runListeners.size === 0) {
            listeners.delete(runId);
            // The last live consumer left; a settled terminal run no longer
            // needs its in-memory stream (replay rebuilds it on demand).
            maybeReleaseTerminalStream(runId);
          }
        };
      },
      subscribeStableTerminalRuns(listener) {
        assertLive();
        stableTerminalListeners.add(listener);
        return () => {
          stableTerminalListeners.delete(listener);
        };
      },
    },
    async release() {
      if (releasePromise !== undefined) return releasePromise;
      released = true;
      const attempt = releaseFeatureResources();
      releasePromise = attempt;
      try {
        await attempt;
      } catch (error) {
        // The feature remains quiesced, but a later release call may retry a
        // failed Session finalization against the same sticky safe leaf.
        releasePromise = undefined;
        throw error;
      }
    },
  };

  async function releaseFeatureResources(): Promise<void> {
    await readyPromise.catch(() => undefined);
    for (const timer of visibleAssistantCheckpointTimers.values()) clearTimeout(timer);
    visibleAssistantCheckpointTimers.clear();
    for (const pump of successorActivationPumps.values()) {
      if (pump.retryTimer !== undefined) clearTimeout(pump.retryTimer);
    }
    successorActivationPumps.clear();
    for (const timer of conversationCleanupRetryTimers.values()) clearTimeout(timer);
    conversationCleanupRetryTimers.clear();
    conversationCleanupFailureCounts.clear();
    pendingUncommittedConversationCleanups.clear();
    pendingUncommittedConversationBirths.clear();
    for (const timer of cancellationCleanupRetryTimers.values()) clearTimeout(timer);
    cancellationCleanupRetryTimers.clear();
    cancellationCleanupFailureCounts.clear();
    for (const timer of managedAttachmentClaimRollbackRetryTimers.values()) clearTimeout(timer);
    managedAttachmentClaimRollbackRetryTimers.clear();
    for (const timer of completionCommitRetryTimers.values()) clearTimeout(timer);
    completionCommitRetryTimers.clear();
    completionCommitRetryCounts.clear();
    await Promise.allSettled([...visibleAssistantBuffers.keys()].map(persistVisibleAssistantCheckpoint));
    for (const controller of controllers.values()) controller.abort("ordinary_feature_released");
    await releaseContinuations();
    await Promise.allSettled(executions.values());
    await Promise.allSettled(conversationCleanupTasks.values());
    await Promise.allSettled(postExecutionTasks);
    await Promise.allSettled(mutationQueues.values());
    await Promise.allSettled(managedAttachmentClaimRollbackTasks.values());
    await Promise.allSettled([...managedAttachmentClaimRollbacks.values()].map(async (rollback) => {
      await attemptManagedAttachmentClaimRollback(rollback.runId);
    }));
    // An abort-ignoring execution may have returned an approval while release awaited it.
    await releaseContinuations();
    await finalizeRemainingSessions();
    if (input.managedAttachmentRepository !== undefined && input.managedAttachmentInstanceId !== undefined) {
      await input.managedAttachmentRepository.removeDraftsOwnedBy(input.managedAttachmentInstanceId);
    }
    listeners.clear();
    stableTerminalListeners.clear();
    activityStreams.clear();
    activeModelRequestIds.clear();
    reasoningBuffers.clear();
    sessionsAwaitingFinalization.clear();
    sessionFinalizationPending.clear();
    sessionFinalizationFailures.clear();
    sessionFinalizationRetries.clear();
    cancellationCleanupTasks.clear();
    cancellationCleanupContinuations.clear();
    conversationCleanupTasks.clear();
    managedAttachmentClaimRollbackTasks.clear();
    managedAttachmentClaimRollbacks.clear();
    managedAttachmentClaimRollbackFailureCounts.clear();
    visibleAssistantBuffers.clear();
    visibleAssistantCheckpointTimers.clear();
    approvalReservations.clear();
    acceptedToolResults.clear();
    documents.clear();
    conversationDocuments.clear();
  }

  async function releaseContinuations(): Promise<void> {
    const failures: unknown[] = [];
    for (const [runId, continuation] of continuations) {
      try {
        await continuation.release();
        if (continuations.get(runId) === continuation) continuations.delete(runId);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const [runId, continuation] of cancellationCleanupContinuations) {
      try {
        await continuation.release();
        if (cancellationCleanupContinuations.get(runId) === continuation) {
          cancellationCleanupContinuations.delete(runId);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to release one or more Ordinary live continuations.");
    }
  }

  async function finalizeRemainingSessions(): Promise<void> {
    const failures: unknown[] = [];
    for (const runId of [...sessionsAwaitingFinalization]) {
      const document = await load(runId);
      if (document === undefined) continue;
      try {
        await finalizeExecutionSession(
          runId,
          document.state,
          document.state.status.kind !== "completed",
        );
      } catch (error) {
        failures.push(sessionFinalizationFailures.get(runId) ?? error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to finalize one or more Ordinary Agent Sessions.");
    }
  }

  function activityCursor(stream: { readonly streamId: string; readonly nextSequence: number }): OrdinaryRunActivityCursor {
    return { streamId: stream.streamId, sequence: stream.nextSequence - 1 };
  }
}

function durableActivities(
  runId: string,
  events: readonly OrdinaryRunEvent[],
  toolResults: readonly ToolCallResult[],
  toolResultRecordedAt: Readonly<Record<string, string>>,
  assistantTextByEntryId: ReadonlyMap<string, string>,
): OrdinaryRunActivity[] {
  const pending: Array<{
    readonly recordedAt: string;
    readonly priority: number;
    readonly insertion: number;
    readonly activity: OrdinaryRunActivity;
  }> = [];
  for (const [insertion, event] of events.entries()) {
    if (event.type === "model.output.completed") {
      const content = assistantTextByEntryId.get(sessionEntryKey(event.assistantEntryRef));
      if (content === undefined) continue;
      pending.push({
        recordedAt: event.recordedAt,
        priority: 1,
        insertion,
        activity: {
          activityId: `transition:${event.eventId}`,
          runId,
          sequence: 0,
          recordedAt: event.recordedAt,
          type: "model.output.completed",
          durability: "durable",
          modelRequestId: event.modelRequestId,
          assistantEntryRef: clone(event.assistantEntryRef),
          content,
        },
      });
      continue;
    }
    pending.push({
      recordedAt: event.recordedAt,
      priority: 1,
      insertion,
      activity: {
      activityId: `transition:${event.eventId}`,
      runId,
      sequence: 0,
      recordedAt: event.recordedAt,
      type: "run.transition",
      durability: "durable",
      event: clone(event),
      },
    });
  }
  for (const [insertion, result] of toolResults.entries()) {
    if (result.status === "approval_required") continue;
    const recordedAt = toolResultRecordedAt[ordinaryToolResultKey(result)];
    if (recordedAt === undefined) continue;
    pending.push({
      recordedAt,
      priority: 0,
      insertion,
      activity: {
        activityId: toolActivityId(result),
        runId,
        sequence: 0,
        recordedAt,
        type: "tool.result",
        durability: "durable",
        result: clone(result),
      },
    });
  }

  // A reasoning/output pair is one semantic unit for replay. Anchoring both
  // activities to the earlier timestamp makes the precedence deterministic
  // even when persistence records the pair out of time order.
  const messageStartAtByRequest = new Map<string, string>();
  for (const item of pending) {
    if (durableMessagePhase(item.activity) === undefined) continue;
    const requestId = durableModelRequestId(item.activity);
    if (requestId === undefined) continue;
    const current = messageStartAtByRequest.get(requestId);
    if (current === undefined || item.recordedAt.localeCompare(current) < 0) {
      messageStartAtByRequest.set(requestId, item.recordedAt);
    }
  }

  return pending
    .map((item) => {
      const phase = durableMessagePhase(item.activity);
      const requestId = durableModelRequestId(item.activity);
      return {
        item,
        sortAt: phase === undefined || requestId === undefined
          ? item.recordedAt
          : messageStartAtByRequest.get(requestId) ?? item.recordedAt,
        phase: phase ?? 0,
      };
    })
    .sort((left, right) => left.sortAt.localeCompare(right.sortAt) ||
      left.phase - right.phase ||
      left.item.priority - right.item.priority ||
      left.item.insertion - right.item.insertion)
    .map(({ item }, index) => ({ ...item.activity, sequence: index + 1 }));
}

/** Returns the semantic phase within one model request's replay unit. */
function durableMessagePhase(activity: OrdinaryRunActivity): 0 | 1 | undefined {
  if (durableReasoningCompletedActivity(activity)) return 0;
  if (durableOutputCompletedActivity(activity)) return 1;
  return undefined;
}

function durableModelRequestId(activity: OrdinaryRunActivity): string | undefined {
  if (activity.type === "run.transition") {
    return "modelRequestId" in activity.event ? activity.event.modelRequestId : undefined;
  }
  return "modelRequestId" in activity ? activity.modelRequestId : undefined;
}

function durableReasoningCompletedActivity(activity: OrdinaryRunActivity): boolean {
  return activity.type === "run.transition" &&
    activity.event.type === "model.reasoning.completed";
}

function durableOutputCompletedActivity(activity: OrdinaryRunActivity): boolean {
  return activity.type === "model.output.completed";
}

export function durableOrdinaryRunReplayFromState(
  run: OrdinaryRunState,
  assistantEntries: readonly import("../model-runtime/agent-session.js").AgentSessionAssistantEntry[],
): OrdinaryRunActivityReplay {
  const assistantTextByEntryId = new Map(assistantEntries.map((entry) =>
    [sessionEntryKey(entry.entryRef), entry.text] as const));
  const activities = durableActivities(
    run.runId,
    run.timeline,
    run.toolCalls,
    run.toolResultRecordedAt,
    assistantTextByEntryId,
  );
  const lastEventId = run.timeline.at(-1)?.eventId ?? "initial";
  return {
    cursor: {
      // Command responses are durable snapshots, not subscriptions to the live stream generation.
      streamId: `ordinary-command-response:${run.runId}:${lastEventId}`,
      sequence: activities.length,
    },
    reset: false,
    activities,
  };
}

function sessionEntryKey(ref: import("../model-runtime/agent-session.js").AgentSessionEntryRef): string {
  return `${ref.sessionId}\u0000${ref.entryId}`;
}

function toolCallIds(event: OrdinaryRunEvent): readonly string[] {
  return "toolCallIds" in event ? event.toolCallIds : [];
}

function toolActivityId(result: ToolCallResult): string {
  return `tool:${ordinaryToolResultKey(result)}`;
}

function liveToolActivityId(identity: Pick<ToolCallRequest, "callId" | "factId">): string {
  return `tool-live:${toolCallFactId(identity)}`;
}

function isTerminal(state: OrdinaryRunState): boolean {
  return state.status.kind === "completed" || state.status.kind === "failed" ||
    state.status.kind === "cancelled" || state.status.kind === "blocked";
}
function isTerminalEvent(event: OrdinaryRunEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed" ||
    event.type === "run.cancelled" || event.type === "run.blocked";
}
function assertConversationWritable(document: OrdinaryConversationControlDocument): void {
  if (document.state.deletedAt !== undefined) {
    throw new OrdinaryFeatureError(
      "ordinary_conversation_deleted",
      `Ordinary conversation ${document.state.conversationId} was deleted`,
    );
  }
}

function rollbackLeafRef(state: OrdinaryRunState): AgentSessionEntryRef | null {
  switch (state.session.phase) {
    case "not_started": return null;
    case "started": return state.session.startLeafRef;
    case "rollbackable": return state.session.endLeafRef;
    case "completion_candidate": return state.session.rollbackLeafRef;
  }
}
function recoveredSessionLeaf(
  runs: readonly OrdinaryRunState[],
  activeBranch: readonly AgentSessionEntryRef[],
  conversationId: string,
): AgentSessionEntryRef | null {
  const branchIndex = new Map(activeBranch.map((entry, index) => [sessionEntryKey(entry), index]));
  const durableLeaves = runs
    .map(rollbackLeafRef)
    .filter((entry): entry is AgentSessionEntryRef => entry !== null);
  let target: { readonly entry: AgentSessionEntryRef; readonly index: number } | undefined;
  for (const entry of durableLeaves) {
    const index = branchIndex.get(sessionEntryKey(entry));
    if (index !== undefined && (target === undefined || index > target.index)) target = { entry, index };
  }
  if (target !== undefined) return target.entry;
  if (durableLeaves.length > 0) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      `Ordinary conversation ${conversationId} has no persisted safe leaf on its active Session branch`,
    );
  }
  return null;
}
function sameSessionEntryRef(left: AgentSessionEntryRef | null, right: AgentSessionEntryRef | null): boolean {
  return left === null || right === null
    ? left === right
    : left.sessionId === right.sessionId && left.entryId === right.entryId;
}
type ManagedAttachmentClaimRollback = {
  readonly runId: string;
  readonly conversationId: string;
  readonly attachmentIds: readonly string[];
  readonly protectedByRunId?: string;
};
type ManagedAttachmentClaimReservation = {
  readonly rollbackRunId: string;
  readonly protectedAttachmentIds: readonly string[];
};
function conversationCleanupRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(30_000, 250 * (2 ** Math.min(7, Math.max(0, consecutiveFailures - 1))));
}
function cancellationCleanupRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(30_000, 250 * (2 ** Math.min(7, Math.max(0, consecutiveFailures - 1))));
}
function managedAttachmentClaimRollbackRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(30_000, 250 * (2 ** Math.min(7, Math.max(0, consecutiveFailures - 1))));
}
function cancellationReason(value: unknown): string { return typeof value === "string" ? value : "cancelled"; }
function successorActivationRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(2_000, 25 * (2 ** Math.min(6, Math.max(0, consecutiveFailures - 1))));
}
function ordinaryExecutionFailureFacts(value: unknown): { readonly code: string; readonly message: string } {
  const explicit = executionErrorFacts(value);
  if (explicit !== undefined) return explicit;
  if (value instanceof OrdinaryFeatureError) return { code: value.code, message: value.message };
  return { code: "ordinary_execution_failed", message: errorMessage(value) };
}
function isManagedAttachmentNotFound(value: unknown): boolean {
  return value instanceof OrdinaryManagedAttachmentRepositoryError &&
    value.code === "ordinary_managed_attachment_not_found";
}
function managedAttachmentIds(input: OrdinaryRunInput): readonly string[] {
  return [...new Set((input.context?.contextRefs ?? []).flatMap((ref) => {
    const attachmentId = managedUploadAttachmentId(ref.ref);
    return ref.kind === "file" && attachmentId !== undefined ? [attachmentId] : [];
  }))];
}
function canonicalManagedAttachmentInput(
  input: OrdinaryRunInput,
  records: readonly OrdinaryManagedAttachmentRecord[],
): OrdinaryRunInput {
  if (input.context === undefined || records.length === 0) return input;
  const byId = new Map(records.map((record) => [record.attachmentId, record] as const));
  const contextRefs = (input.context.contextRefs ?? []).map((ref) => {
    const attachmentId = managedUploadAttachmentId(ref.ref);
    if (attachmentId === undefined) return ref;
    const record = byId.get(attachmentId);
    if (record === undefined) {
      throw new OrdinaryFeatureError(
        "ordinary_managed_attachment_unavailable",
        `Managed attachment ${attachmentId} was not claimed for this run.`,
      );
    }
    return {
      attachmentId: record.attachmentId,
      ref: managedUploadAttachmentRef(record.attachmentId),
      kind: "file" as const,
      title: record.originalName,
      summary: `上传附件：${record.originalName} · ${record.byteLength} bytes`,
      metadata: {
        byteLength: record.byteLength,
        ...(record.mimeType === undefined ? {} : { mimeType: record.mimeType }),
        available: true,
        truncated: false,
      },
    };
  });
  const permissionBoundaryRefs = [
    ...(input.context.permissionBoundaryRefs ?? []).filter((ref) =>
      !ref.startsWith("read:uploaded-attachment:")),
    ...records.map((record) => `read:uploaded-attachment:${record.attachmentId}`),
  ];
  return {
    ...input,
    context: {
      ...input.context,
      contextRefs,
      permissionBoundaryRefs: [...new Set(permissionBoundaryRefs)],
    },
  };
}
function normalizedSubmissionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0 || value.length > 200 || value.includes("\0")) {
    throw new OrdinaryFeatureError("ordinary_submission_conflict", "Ordinary submission id is invalid.");
  }
  return value;
}
function managedAttachmentDraftId(
  uploadRequestId: string | undefined,
  uploadFileIndex: number | undefined,
  idFactory: IdFactory,
): string {
  if (uploadRequestId === undefined && uploadFileIndex === undefined) {
    return idFactory("ordinary-managed-attachment");
  }
  if (uploadRequestId === undefined || uploadFileIndex === undefined ||
    uploadRequestId.trim().length === 0 || uploadRequestId.length > 200 || uploadRequestId.includes("\0") ||
    !Number.isSafeInteger(uploadFileIndex) || uploadFileIndex < 0 || uploadFileIndex > 10_000) {
    throw new OrdinaryFeatureError(
      "ordinary_managed_attachment_unavailable",
      "Managed attachment upload identity is invalid.",
    );
  }
  const digest = createHash("sha256")
    .update("ordinary-managed-upload/v1\0")
    .update(uploadRequestId)
    .update("\0")
    .update(String(uploadFileIndex))
    .digest("base64url")
    .slice(0, 32);
  return `ordinary-managed-attachment-${digest}`;
}
function sameSubmissionInput(left: OrdinaryRunInput, right: OrdinaryRunInput): boolean {
  const identity = (value: OrdinaryRunInput) => ({
    userMessage: value.userMessage,
    contextRefs: (value.context?.contextRefs ?? []).map((ref) => ({
      attachmentId: ref.attachmentId,
      ref: ref.ref,
      kind: ref.kind,
    })),
  });
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function clone<T>(value: T): T { return globalThis.structuredClone(value); }
