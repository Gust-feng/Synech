import type { ConfirmationDecision } from "../../domain/confirmation/index.js";
import { memoryOwnerKey, memoryOwnersForConversation } from "../../domain/memory/index.js";
import {
  toolInvocationId,
  sameResultForIdempotency,
  type ToolCallRequest,
  type ToolCallResult,
} from "../../domain/tools/index.js";
import { createId, createStableInvocationId, nowIso, type IdFactory } from "../../kernel/id.js";
import type {
  DecideOrdinaryApprovalInput,
  OrdinaryAgentFeature,
  OrdinaryConversationControlDocument,
  OrdinaryConversationControlRepository,
  OrdinaryConversationControlState,
  OrdinaryConversationReadModel,
  OrdinaryExecutionContinuation,
  OrdinaryExecutionOutcome,
  OrdinaryExecutionPort,
  OrdinaryFeatureDiagnostic,
  OrdinaryRunRepository,
  OrdinaryRunRecoveryInventory,
  OrdinaryRunSnapshotDocument,
  OrdinaryRunState,
  OrdinaryRunInput,
  OrdinaryRunTurn,
  OrdinaryMemoryFact,
  OrdinaryMemoryFactRepository,
  OrdinaryConversationTitleGenerator,
  StartOrdinaryRunInput,
  SubmitOrdinaryTurnInput,
  SubmitOrdinaryTurnResult,
} from "./contracts.js";
import { OrdinaryFeatureError } from "./contracts.js";
import type { AgentSessionEntryRef, AgentSessionRef, AgentSessionRepository } from "../model-runtime/agent-session.js";
import type {
  AcceptedToolInvocation,
  ProviderToolCall,
} from "../model-runtime/agent-loop.js";
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
import type { OrdinaryManagedAttachmentRepository } from "./managed-attachment-repository.js";
import { createManagedAttachmentLifecycle, managedAttachmentIds } from "./attachment-lifecycle.js";
import { createInMemoryOrdinaryMemoryFactRepository } from "./memory-fact-repository.js";
import {
  ordinaryRunActivityCursor,
} from "./activity-replay.js";
import {
  isSchedulingBarrierCleared,
  nextEligibleQueuedRun,
  orderedConversationRuns,
  type OrdinaryRunSchedulingFacts,
} from "./conversation-scheduler.js";
import {
  conversationCleanupJobIsIdle,
  createConversationCleanupJob,
  prepareConversationCleanup,
  recordConversationCleanupSuccess,
  type ConversationCleanupDisposition,
  type ConversationCleanupJob,
} from "./conversation-cleanup.js";
import { createTerminalSettlement, projectStableTerminalRunFacts } from "./terminal-settlement.js";
import {
  recoveredSessionLeaf,
  sameSessionEntryRef,
  sessionEntryKey,
} from "./session-branch-recovery.js";
import {
  cancellationReason,
  isTerminal,
  isTerminalEvent,
  ordinaryExecutionFailureFacts,
} from "./run-lifecycle-policy.js";
import {
  assertConversationWritable,
  normalizedSubmissionId,
  sameSubmissionInput,
} from "./conversation-submission-policy.js";
import { createOrdinaryRunActivityHub, type OrdinaryRunActivityHub } from "./run-activity-hub.js";
import { createOrdinaryRunStore } from "./feature/run-store.js";
import {
  createOrdinaryExecutionCoordinator,
} from "./feature/execution-coordinator.js";
import { createOrdinaryExecutionOperations } from "./feature/execution-operations.js";
import {
  createOrdinaryConversationCoordinator,
  type OrdinaryConversationCoordinator,
} from "./feature/conversation-coordinator.js";

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
  const managedAttachments = createManagedAttachmentLifecycle({
    repository: input.managedAttachmentRepository,
    instanceId: input.managedAttachmentInstanceId,
    now,
    idFactory,
    onRecoveryIssue(identity, error) {
      emitDiagnostic({
        kind: "managed_attachment_recovery_issue",
        ...(identity === undefined ? {} : { identity }),
        error,
      });
    },
    onRollbackFailure(rollback, error) {
      emitDiagnostic({ kind: "managed_attachment_claim_rollback_failed", ...rollback, error });
    },
  });
  const executionState = createOrdinaryExecutionCoordinator();
  let released = false;
  let releasePromise: Promise<void> | undefined;
  /**
   * Distinguishes terminal replay streams across feature instances. Cursors are
   * process-lifetime handles: a restarted process must answer an old cursor with
   * the reset protocol, exactly like the mutable streams whose random streamIds
   * never repeat across restarts.
   */
  const streamEpoch = idFactory("ordinary-activity-stream");
  let activityHub: OrdinaryRunActivityHub;
  const runStore = createOrdinaryRunStore({
    repository: input.repository,
    now,
    idFactory,
    visibleAssistantText: (runId) => activityHub.visibleAssistantText(runId),
    onLoaded: async (state) => {
      if (activityHub.needsLiveStream(state)) await activityHub.restorePersistedStream(state);
    },
    onSaved: (state) => activityHub.syncDurableToolResults(state),
    onTransition: (event, assistantText) => activityHub.recordTransition(event, assistantText),
  });
  activityHub = createOrdinaryRunActivityHub({
    streamEpoch,
    checkpointIntervalMs: visibleAssistantCheckpointIntervalMs,
    idFactory,
    now,
    sessionRepository: input.sessionRepository,
    isReleased: () => released,
    getCachedRun: runStore.cached,
    loadRun: runStore.load,
    persistVisibleAssistantText: async (runId, visibleAssistantText) => {
      await runStore.withExclusiveRun(runId, async () => {
        const current = await runStore.load(runId);
        if (current === undefined || current.state.status.kind !== "running" ||
            current.state.visibleAssistantText === visibleAssistantText) return;
        await runStore.savePublished({
          ...current.state,
          visibleAssistantText,
        }, current.revision);
      });
    },
    recordReasoning: async ({ runId, modelRequestId, contentIndex, content }) => {
      await runStore.mutate(runId, { type: "record_reasoning", modelRequestId, contentIndex, content });
    },
    trackBackgroundTask: executionState.trackPostExecutionTask,
    onLastSubscriberRemoved: (runId) => terminalSettlement.releaseStableResources(runId),
  });
  let executionCoordinator!: ReturnType<typeof createOrdinaryExecutionOperations>;
  let conversationCoordinator!: OrdinaryConversationCoordinator;
  const terminalSettlement = createTerminalSettlement({
    finalizeSession: input.execution.finalizeSession,
    loadRun: runStore.load,
    cachedRun: runStore.cached,
    persistToolResult: (runId, result) => executionCoordinator.persistToolResult(runId, result),
    reconcilePendingToolRound: (runId) => executionCoordinator.reconcilePendingToolRound(runId),
    reconcileLostApprovalResults: (runId) => executionCoordinator.reconcileLostApprovalResults(runId),
    externalSettlementCleared: executionState.externalSettlementCleared,
    isHiddenRun: (state) => conversationCoordinator.isHiddenRun(state),
    hasActivitySubscribers: activityHub.hasSubscribers,
    releaseActivityStream: activityHub.releaseStream,
    emitDiagnostic,
    onStable() {},
  });
  executionCoordinator = createOrdinaryExecutionOperations({
    state: executionState,
    runStore,
    activityHub,
    terminalSettlement,
    execution: input.execution,
    sessionRepository: input.sessionRepository,
    now,
    idFactory,
    isReleased: () => released,
    emitDiagnostic,
    activateSuccessor: (runId) => conversationCoordinator.activateSuccessor(runId),
  });
  conversationCoordinator = createOrdinaryConversationCoordinator({
    conversationRepository: input.conversationRepository,
    runStore,
    sessionRepository: input.sessionRepository,
    managedAttachments,
    memoryFactRepository,
    releaseToolEvidenceOwner: input.releaseToolEvidenceOwner,
    activity: activityHub,
    execution: {
      start: executionCoordinator.start,
      cancel: executionCoordinator.cancel,
      schedulingFacts: executionState.schedulingFacts,
      trackPostTask: executionState.trackPostExecutionTask,
      waitForRunExecution: executionState.waitForRunExecution,
      waitForCancellationCleanup: executionState.waitForCancellationCleanup,
    },
    settlement: terminalSettlement,
    generateConversationTitle: input.generateConversationTitle,
    now,
    idFactory,
    isReleased: () => released,
    emitDiagnostic,
  });

  const readyPromise = recoverFeatureState();
  // Observe eager recovery immediately; public calls still await the original rejected promise.
  void readyPromise.catch(() => undefined);

  async function recoverFeatureState(): Promise<void> {
    await recoverPersistedRuns();
  }

  async function recoverPersistedRuns(): Promise<void> {
    let conversationEnumerationFailed = false;
    let conversationSummaries: readonly Awaited<ReturnType<OrdinaryConversationControlRepository["list"]>>[number][] = [];
    try {
      conversationSummaries = await input.conversationRepository.list(Number.MAX_SAFE_INTEGER);
    } catch (error) {
      conversationEnumerationFailed = true;
      emitDiagnostic({ kind: "startup_recovery_failed", source: "conversation_repository", error });
    }
    for (const summary of conversationSummaries) {
      try {
        const document = await input.conversationRepository.get(summary.conversationId);
        if (document !== undefined) conversationCoordinator.adoptControl(document);
      } catch (error) {
        conversationCoordinator.markUnavailable(summary.conversationId, error);
      }
    }
    let runSummaries: OrdinaryRunRecoveryInventory["summaries"] = [];
    try {
      const inventory = await runStore.inspectRecoveryInventory();
      runSummaries = inventory.summaries;
      if (inventory.issues.length > 0) {
        runStore.markEnumerationFailed();
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
      runStore.markEnumerationFailed();
      emitDiagnostic({ kind: "startup_recovery_failed", source: "run_repository", error });
    }
    if (!conversationEnumerationFailed) {
      for (const summary of runSummaries) {
        if (conversationCoordinator.hasControl(summary.conversationId)) continue;
        conversationCoordinator.markUnavailable(
          summary.conversationId,
          new Error("Conversation control document is missing; the run was isolated from recovery."),
        );
      }
    }
    if (!runStore.enumerationFailed() && !conversationEnumerationFailed) {
      for (const control of conversationCoordinator.controls()) {
        const conversationId = control.state.conversationId;
        if (control.state.deletedAt !== undefined ||
            runSummaries.some((summary) => summary.conversationId === conversationId)) continue;
        await conversationCoordinator.scheduleConversationCleanup(conversationId, control, [], "delete_uncommitted");
      }
    }
    const deletedConversationIds = new Set<string>();
    for (const control of conversationCoordinator.controls()) {
      if (control.state.deletedAt === undefined) continue;
      deletedConversationIds.add(control.state.conversationId);
      const runIds = runSummaries
        .filter((summary) => summary.conversationId === control.state.conversationId)
        .map((summary) => summary.runId);
      await conversationCoordinator.scheduleConversationCleanup(control.state.conversationId, control, runIds);
    }

    for (const summary of runSummaries) {
      if (conversationCoordinator.unavailable(summary.conversationId)) continue;
      if (deletedConversationIds.has(summary.conversationId)) continue;
      try {
        let document = await runStore.inspectPersisted(summary.runId);
        if (document === undefined) continue;
        // Cache the durable run before Session recovery so an unavailable transcript
        // cannot force unrelated conversations to reopen this run during startup.
        await runStore.adoptPersisted(document);
        // Settled terminal runs receive no further activities; their streams are
        // pure projections of the persisted timeline and are rebuilt on demand by
        // replay (which passes the rebuild inputs). Materializing them here would
        // duplicate every historical run's timeline in memory for the whole
        // process lifetime. Runs that still need recovery below (pending tool
        // rounds, lost approvals) keep an eager stream because those paths append
        // activities through bare streamFor(runId), which must not start empty.
        if (document.state.status.kind === "awaiting_approval") {
          await executionCoordinator.blockLostApproval(summary.runId, {
            code: "confirmation_continuation_lost",
            message: "The live confirmation continuation was lost when the process restarted.",
          });
          continue;
        }
        if (document.state.pendingToolRound !== undefined ||
            document.state.pendingNestedToolCalls !== undefined) {
          await executionCoordinator.reconcilePendingToolRound(summary.runId);
          document = await runStore.load(summary.runId);
          if (document === undefined) continue;
        }
        if (document.state.toolCalls.some((result) => result.status === "approval_required")) {
          await executionCoordinator.reconcileLostApprovalResults(summary.runId);
          document = await runStore.load(summary.runId);
          if (document === undefined) continue;
        }
        if (document.state.status.kind === "running") {
          const unknownToolOutcome = document.state.toolCalls.some((result) =>
            result.errorFacts?.code === "tool_execution_outcome_unknown");
          await runStore.mutate(summary.runId, {
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
        conversationCoordinator.markUnavailable(summary.conversationId, error);
      }
    }
    await reconcileRecoveredSessionBranches();
    await recoverManagedAttachments();
    for (const control of conversationCoordinator.controls()) {
      const conversationId = control.state.conversationId;
      if (control.state.deletedAt !== undefined) continue;
      try {
        if (await conversationCoordinator.conversationView(control) === undefined) {
          conversationCoordinator.markUnavailable(conversationId);
        }
      } catch (error) {
        // Unsupported or incomplete Session branches remain on disk for diagnosis, but
        // cannot make unrelated conversations or new tasks unavailable.
        conversationCoordinator.markUnavailable(conversationId, error);
      }
    }
    for (const document of runStore.cachedDocuments()) {
      if (document.state.status.kind !== "queued") continue;
      const conversationId = document.state.turn.conversationId;
      if (conversationCoordinator.unavailable(conversationId)) continue;
      try {
        if (document.state.turn.predecessorRunId === undefined) {
          await conversationCoordinator.activateRootQueued(document.state.runId);
          continue;
        }
        const predecessor = runStore.cached(document.state.turn.predecessorRunId);
        if (predecessor === undefined) {
          await runStore.mutate(document.state.runId, {
            type: "block",
            reason: {
              code: "predecessor_run_unavailable",
              message: "The predecessor run is unavailable or incompatible. This queued run was not started.",
            },
            continueBy: "new_turn",
          });
        } else if (isTerminal(predecessor.state)) {
          await conversationCoordinator.activateSuccessor(predecessor.state.runId);
        }
      } catch (error) {
        conversationCoordinator.markUnavailable(conversationId, error);
      }
    }
  }

  async function reconcileRecoveredSessionBranches(): Promise<void> {
    for (const control of conversationCoordinator.controls()) {
      const conversationId = control.state.conversationId;
      if (control.state.deletedAt !== undefined || conversationCoordinator.unavailable(conversationId)) continue;
      const runs = runStore.cachedDocuments()
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
        conversationCoordinator.markUnavailable(conversationId, error);
      }
    }
  }

  async function recoverManagedAttachments(): Promise<void> {
    const attachmentIdsByConversation = new Map<string, Set<string>>();
    const preserveConversationIds = new Set(conversationCoordinator.unavailableIds());
    if (runStore.enumerationFailed()) {
      for (const control of conversationCoordinator.controls()) preserveConversationIds.add(control.state.conversationId);
    }
    for (const document of runStore.cachedDocuments()) {
      const conversationId = document.state.turn.conversationId;
      const control = conversationCoordinator.cachedControl(conversationId);
      if (control === undefined) {
        preserveConversationIds.add(conversationId);
        continue;
      }
      if (control.state.deletedAt !== undefined) continue;
      const ids = attachmentIdsByConversation.get(conversationId) ?? new Set<string>();
      for (const attachmentId of managedAttachmentIds(document.state.input)) ids.add(attachmentId);
      attachmentIdsByConversation.set(conversationId, ids);
    }
    await managedAttachments.recover({
      durableClaims: [...attachmentIdsByConversation].map(([conversationId, attachmentIds]) => ({
        conversationId,
        attachmentIds: [...attachmentIds],
      })),
      preserveConversationIds: [...preserveConversationIds],
    });
  }

  async function cancel(runId: string, reason = "cancelled_by_user"): Promise<OrdinaryRunState> {
    assertLive();
    await readyPromise;
    return executionCoordinator.cancel(runId, reason);
  }

  async function decideApproval(decision: DecideOrdinaryApprovalInput): Promise<OrdinaryRunState> {
    assertLive();
    await readyPromise;
    return executionCoordinator.decideApproval(decision);
  }

  async function start(startInput: StartOrdinaryRunInput): Promise<OrdinaryRunState> {
    assertLive();
    await readyPromise;
    return conversationCoordinator.start(startInput);
  }

  async function submitTurn(submission: SubmitOrdinaryTurnInput): Promise<SubmitOrdinaryTurnResult> {
    assertLive();
    await readyPromise;
    return conversationCoordinator.submitTurn(submission);
  }

  async function renameConversation(conversationId: string, title: string): Promise<OrdinaryConversationReadModel> {
    assertLive();
    await readyPromise;
    return conversationCoordinator.renameConversation(conversationId, title);
  }

  async function setConversationPinned(conversationId: string, pinned: boolean): Promise<OrdinaryConversationReadModel> {
    assertLive();
    await readyPromise;
    return conversationCoordinator.setConversationPinned(conversationId, pinned);
  }

  async function rollbackConversation(inputValue: {
    readonly conversationId: string;
    readonly targetRunId?: string;
    readonly stepsBack?: number;
  }): Promise<OrdinaryConversationReadModel> {
    assertLive();
    await readyPromise;
    return conversationCoordinator.rollbackConversation(inputValue);
  }

  async function deleteConversation(conversationId: string): Promise<void> {
    assertLive();
    await readyPromise;
    await conversationCoordinator.deleteConversation(conversationId);
  }

  async function createManagedAttachmentDraft(
    draftInput: Parameters<OrdinaryConversationCoordinator["createManagedAttachmentDraft"]>[0],
  ) {
    assertLive();
    await readyPromise;
    return conversationCoordinator.createManagedAttachmentDraft(draftInput);
  }

  async function discardManagedAttachmentDraft(attachmentId: string): Promise<void> {
    assertLive();
    await readyPromise;
    await conversationCoordinator.discardManagedAttachmentDraft(attachmentId);
  }

  function emitDiagnostic(diagnostic: OrdinaryFeatureDiagnostic): void {
    try {
      input.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics never affect committed facts or control flow.
    }
  }

  function assertLive(): void {

    if (released) {
      throw new OrdinaryFeatureError("ordinary_feature_released", "Agent is shutting down");
    }
  }

  function isHiddenConversation(conversationId: string): boolean {
    return conversationCoordinator.isHiddenConversation(conversationId);
  }

  function isHiddenRun(state: OrdinaryRunState): boolean {
    return conversationCoordinator.isHiddenRun(state);
  }

  async function recordMemoryRead(
    factInput: Omit<OrdinaryMemoryFact, "kind" | "memoryKind" | "recordedAt" | "conversationId">,
  ): Promise<void> {
    await readyPromise;
    await runStore.withExclusiveRun(factInput.runId, async () => {
      const document = await runStore.load(factInput.runId);
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
    return runStore.withExclusiveRun(factInput.runId, async () => {
      const document = await runStore.load(factInput.runId);
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
        const document = await runStore.load(runId);
        return document === undefined || isHiddenRun(document.state) ? undefined : clone(document.state);
      },
      async listRuns(limit) {
        await readyPromise;
        const summaries = await runStore.listSummaries(Number.MAX_SAFE_INTEGER);
        const visible = summaries.filter((summary) =>
          (!runStore.enumerationFailed() || runStore.has(summary.runId)) && !isHiddenConversation(summary.conversationId));
        return limit === undefined ? visible : visible.slice(0, Math.max(0, Math.floor(limit)));
      },
      async getConversation(conversationId) {
        await readyPromise;
        return conversationCoordinator.getConversation(conversationId);
      },
      async getConversationOwner(conversationId) {
        await readyPromise;
        const control = await conversationCoordinator.loadControl(conversationId);
        return control === undefined ? undefined : control.state.owner;
      },
      async listConversationsByOwner(owner) {
        await readyPromise;
        return conversationCoordinator.listConversationsByOwner(owner);
      },
      async listConversations(limit = 50) {
        await readyPromise;
        return conversationCoordinator.listConversations(limit);
      },
      async getManagedAttachment(attachmentId) {
        await readyPromise;
        const record = await managedAttachments.get(attachmentId);
        return record === undefined ? undefined : clone(record);
      },
      async listMemoryFacts(query) {
        await readyPromise;
        return memoryFactRepository.list(query);
      },
      async releaseTerminalRunCaches(runIds) {
        await readyPromise;
        for (const runId of runIds) runStore.evictCachedTerminal(runId);
      },
      async getStableTerminalRunFacts(runId) {
        // Startup reconciliation must finish first so recovered runs already
        // closed their lost continuations, pending tool rounds and approvals.
        await readyPromise;
        const document = await runStore.load(runId);
        if (document === undefined || isHiddenRun(document.state) || !terminalSettlement.isStable(document.state)) return undefined;
        return projectStableTerminalRunFacts(document);
      },
    },
    events: {
      async replay(runId, cursor) {
        await readyPromise;
        const document = await runStore.load(runId);
        if (document === undefined || isHiddenRun(document.state)) return undefined;
        // Live runs use the cached mutable stream. Settled terminal runs whose
        // stream was already released rebuild an ephemeral projection instead of
        // re-pinning it: the stream is a pure function of the persisted document,
        // so a deterministic streamId keeps concurrent and repeated replays
        // cursor-stable without holding the duplicate timeline in memory.
        const stream = await activityHub.replayStream(document);
        const reset = cursor !== undefined && (
          cursor.streamId !== stream.streamId || cursor.sequence < 0 || cursor.sequence >= stream.nextSequence
        );
        const afterSequence = cursor === undefined || reset ? 0 : cursor.sequence;
        return {
          cursor: ordinaryRunActivityCursor(stream),
          reset,
          activities: clone(stream.activities
            .filter((activity) => activity.sequence > afterSequence)
            .sort((left, right) => left.sequence - right.sequence)),
        };
      },
      subscribe(runId, listener) {
        assertLive();
        return activityHub.subscribe(runId, listener);
      },
      subscribeStableTerminalRuns(listener) {
        assertLive();
        return terminalSettlement.subscribeStable(listener);
      },
      subscribeConversationTitleChanges(listener) {
        assertLive();
        return conversationCoordinator.subscribeConversationTitleChanges(listener);
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
    await activityHub.prepareRelease();
    conversationCoordinator.prepareRelease();
    executionState.prepareRelease("ordinary_feature_released");
    await executionState.releaseContinuations();
    await executionState.awaitExecutionTasks();
    await conversationCoordinator.awaitOwnedTasks();
    await executionState.awaitPostExecutionTasks();
    await runStore.awaitIdle();
    // An abort-ignoring execution may have returned an approval while release awaited it.
    await executionState.releaseContinuations();
    await terminalSettlement.release();
    await managedAttachments.release();
    activityHub.release();
    executionState.clear();
    conversationCoordinator.clear();
    runStore.clear();
  }

}

function clone<T>(value: T): T {
  return globalThis.structuredClone(value);
}
