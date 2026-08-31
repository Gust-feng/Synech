import type { IdFactory } from "../../../kernel/id.js";
import type { AgentSessionRef, AgentSessionRepository } from "../../model-runtime/agent-session.js";
import {
  OrdinaryFeatureError,
  type OrdinaryConversationControlDocument,
  type OrdinaryConversationControlRepository,
  type OrdinaryConversationControlState,
  type OrdinaryConversationReadModel,
  type OrdinaryConversationTitleGenerator,
  type OrdinaryFeatureDiagnostic,
  type OrdinaryMemoryFactRepository,
  type OrdinaryRunSnapshotDocument,
  type OrdinaryRunState,
  type StartOrdinaryRunInput,
  type SubmitOrdinaryTurnInput,
  type SubmitOrdinaryTurnResult,
} from "../contracts.js";
import { createInitialOrdinaryRunState } from "../state.js";
import { normalizeOrdinaryConversationTitle, projectOrdinaryConversation, visibleOrdinaryConversationRuns } from "../conversation-projection.js";
import { isSchedulingBarrierCleared, nextEligibleQueuedRun, orderedConversationRuns, type OrdinaryRunSchedulingFacts } from "../conversation-scheduler.js";
import { conversationCleanupJobIsIdle, createConversationCleanupJob, prepareConversationCleanup, recordConversationCleanupSuccess, type ConversationCleanupDisposition, type ConversationCleanupJob } from "../conversation-cleanup.js";
import { assertConversationWritable, normalizedSubmissionId, sameSubmissionInput } from "../conversation-submission-policy.js";
import { isTerminal } from "../run-lifecycle-policy.js";
import { sessionEntryKey } from "../session-branch-recovery.js";
import type { ManagedAttachmentLifecycle } from "../attachment-lifecycle.js";
import type { OrdinaryRunActivityHub } from "../run-activity-hub.js";
import type { createTerminalSettlement } from "../terminal-settlement.js";
import type { OrdinaryRunStore } from "./run-store.js";

type OrdinaryTerminalSettlement = ReturnType<typeof createTerminalSettlement>;
const AUTO_TITLE_RETRY_DELAYS_MS = [0, 1_000, 2_000] as const;
type ConversationRunStore = Pick<
  OrdinaryRunStore,
  "cached" | "cachedDocuments" | "delete" | "has" | "inspectPersisted" |
  "listSummaries" | "load" | "mutate" | "mutateLocked" | "persistUnpublished" |
  "publishBirth" | "withExclusiveRun"
>;
type ConversationSessionStore = Pick<
  AgentSessionRepository,
  "create" | "delete" | "getActiveBranchEntryRefs" | "moveActiveLeaf" | "readAssistantEntries"
>;
type ConversationManagedAttachments = Pick<
  ManagedAttachmentLifecycle,
  "claimForRun" | "createDraft" | "deleteConversation" | "discardDraft"
>;
type ConversationActivity = Pick<OrdinaryRunActivityHub, "recordTransition" | "releaseRun">;
type ConversationSettlement = Pick<
  OrdinaryTerminalSettlement,
  "clearAcceptedToolResults" | "finalizationFailure" | "hasAcceptedToolResults" |
  "isFinalizationPending" | "isStable" | "notifyStable" | "retryFinalization" | "settleExecution"
>;
type ConversationExecutionPort = {
  readonly start: (runId: string) => void;
  readonly cancel: (runId: string, reason: string) => Promise<OrdinaryRunState>;
  readonly schedulingFacts: (runId: string) => Pick<OrdinaryRunSchedulingFacts, "unsettledToolWork" | "executionActive">;
  readonly trackPostTask: (task: Promise<void>) => void;
  readonly waitForRunExecution: (runId: string) => Promise<void>;
  readonly waitForCancellationCleanup: (runId: string) => Promise<void>;
};

export type OrdinaryConversationCoordinator = ReturnType<typeof createOrdinaryConversationCoordinator>;

export function createOrdinaryConversationCoordinator(options: {
  readonly conversationRepository: Pick<OrdinaryConversationControlRepository, "delete" | "get" | "save">;
  readonly runStore: ConversationRunStore;
  readonly sessionRepository: ConversationSessionStore;
  readonly managedAttachments: ConversationManagedAttachments;
  readonly memoryFactRepository: Pick<OrdinaryMemoryFactRepository, "deleteByRunIds">;
  readonly releaseToolEvidenceOwner?: (ownerId: string) => void | Promise<void>;
  readonly activity: ConversationActivity;
  readonly execution: ConversationExecutionPort;
  readonly settlement: ConversationSettlement;
  readonly generateConversationTitle?: OrdinaryConversationTitleGenerator;
  readonly now: () => string;
  readonly idFactory: IdFactory;
  readonly isReleased: () => boolean;
  readonly emitDiagnostic: (diagnostic: OrdinaryFeatureDiagnostic) => void;
}) {
  const conversationDocuments = new Map<string, OrdinaryConversationControlDocument>();
  const unavailableConversationIds = new Set<string>();
  const successorActivationTasks = new Map<string, Promise<void>>();
  const conversationCleanupJobs = new Map<string, ConversationCleanupJob>();
  const pendingUncommittedConversationBirths = new Map<string, { readonly sessionRef: AgentSessionRef }>();
  const autoTitleGenerationTasks = new Map<string, Promise<void>>();
  const conversationTitleListeners = new Set<(conversationId: string) => void>();
  const mutationQueues = new Map<string, Promise<void>>();
  const runStore = options.runStore;
  const managedAttachments = options.managedAttachments;
  const activityHub = options.activity;
  const executionState = options.execution;
  const executionCoordinator = options.execution;
  const terminalSettlement = options.settlement;
  const memoryFactRepository = options.memoryFactRepository;
  const now = options.now;
  const idFactory = options.idFactory;

  async function withConversationLock<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(conversationId) ?? Promise.resolve();
    let resolveCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
    const tail = previous.then(() => current, () => current);
    mutationQueues.set(conversationId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      resolveCurrent();
      if (mutationQueues.get(conversationId) === tail) mutationQueues.delete(conversationId);
    }
  }

  function emitDiagnostic(diagnostic: OrdinaryFeatureDiagnostic): void {
    options.emitDiagnostic(diagnostic);
  }

  function assertLive(): void {
    if (options.isReleased()) throw new OrdinaryFeatureError("ordinary_feature_released", "Agent is shutting down");
  }

  async function loadControl(conversationId: string): Promise<OrdinaryConversationControlDocument | undefined> {
    if (unavailableConversationIds.has(conversationId)) return undefined;
    const cached = conversationDocuments.get(conversationId);
    if (cached !== undefined) return cached;
    const document = await options.conversationRepository.get(conversationId);
    if (document !== undefined) conversationDocuments.set(conversationId, document);
    return document;
  }

  function markUnavailable(conversationId: string, error?: unknown): void {
    conversationDocuments.delete(conversationId);
    if (unavailableConversationIds.has(conversationId)) return;
    unavailableConversationIds.add(conversationId);
    emitDiagnostic({ kind: "conversation_unavailable", conversationId, ...(error === undefined ? {} : { error }) });
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
  async function requestAutoConversationTitleIfMissing(runId: string): Promise<void> {
    const generator = options.generateConversationTitle;
    if (generator === undefined) return;
    const document = runStore.cached(runId);
    if (document === undefined || isHiddenRun(document.state)) return;
    // 只在首轮触发；标题只依赖已持久化的第一条用户消息。
    if (document.state.turn.predecessorRunId !== undefined) return;
    const conversationId = document.state.turn.conversationId;
    const existing = autoTitleGenerationTasks.get(conversationId);
    if (existing !== undefined) return existing;
    const task = generateAutoConversationTitle({ conversationId, document, generator });
    autoTitleGenerationTasks.set(conversationId, task);
    try {
      await task;
    } finally {
      if (autoTitleGenerationTasks.get(conversationId) === task) {
        autoTitleGenerationTasks.delete(conversationId);
      }
    }
  }

  async function generateAutoConversationTitle(input: {
    readonly conversationId: string;
    readonly document: OrdinaryRunSnapshotDocument;
    readonly generator: OrdinaryConversationTitleGenerator;
  }): Promise<void> {
    let lastError: unknown;
    for (const delayMs of AUTO_TITLE_RETRY_DELAYS_MS) {
      if (delayMs > 0) await delay(delayMs);
      if (options.isReleased()) return;
      const control = await loadControl(input.conversationId);
      if (control === undefined || control.state.deletedAt !== undefined ||
          control.state.titleOverride !== undefined || control.state.autoTitle !== undefined) {
        return;
      }
      try {
        const generated = await input.generator({
          conversationId: input.conversationId,
          userMessage: input.document.state.input.userMessage,
          birth: input.document.state.birth,
        });
        if (generated === undefined || generated.trim().length === 0) continue;
        const normalized = normalizeOrdinaryConversationTitle(generated);
        let savedTitle = false;
        await withConversationLock(input.conversationId, async () => {
          await settlePendingUncommittedConversationCleanup(input.conversationId);
          const current = await loadControl(input.conversationId);
          if (current === undefined || current.state.deletedAt !== undefined) return;
          // 落盘前防覆盖：用户手动重命名或已有自动标题时让位。
          if (current.state.titleOverride !== undefined || current.state.autoTitle !== undefined) return;
          const changedAt = now();
          const saved = await options.conversationRepository.save(
            { ...current.state, autoTitle: normalized, autoTitleAt: changedAt },
            current.revision,
            changedAt,
          );
          conversationDocuments.set(input.conversationId, saved);
          savedTitle = true;
        });
        if (savedTitle) notifyConversationTitleChanged(input.conversationId);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError !== undefined) {
      emitDiagnostic({ kind: "conversation_title_generation_failed", conversationId: input.conversationId, error: lastError });
    }
  }

  function notifyConversationTitleChanged(conversationId: string): void {
    for (const listener of [...conversationTitleListeners]) {
      try {
        listener(conversationId);
      } catch {
        // Projection observers cannot affect the committed conversation title.
      }
    }
  }

function schedulingFacts(runId: string): OrdinaryRunSchedulingFacts {
    const execution = executionState.schedulingFacts(runId);
    return {
      unsettledToolWork: execution.unsettledToolWork ||
        terminalSettlement.hasAcceptedToolResults(runId),
      sessionFinalizationPending: terminalSettlement.isFinalizationPending(runId),
      executionActive: execution.executionActive,
    };
  }

  function schedulingBarrierCleared(state: OrdinaryRunState): boolean {
    return isSchedulingBarrierCleared(state, schedulingFacts(state.runId));
  }

  function nextQueuedRun(runs: readonly OrdinaryRunState[]): OrdinaryRunState | undefined {
    return nextEligibleQueuedRun(runs, schedulingFacts);
  }

  function trackPostExecutionTask(task: Promise<void>): void {
    executionState.trackPostTask(task);
  }

  async function activateSuccessor(predecessorRunId: string): Promise<void> {
    if (options.isReleased()) return;
    const predecessor = await runStore.load(predecessorRunId);
    if (predecessor === undefined) return;
    await requestConversationActivation(predecessor.state.turn.conversationId, predecessorRunId);
  }

  async function requestConversationActivation(conversationId: string, diagnosticRunId: string): Promise<void> {
    if (options.isReleased()) return;
    const active = successorActivationTasks.get(conversationId);
    if (active !== undefined) {
      await active;
      return;
    }
    const activation = { diagnosticRunId };
    const attempt = (async () => {
      try {
        await activateConversationOnce(conversationId, activation);
      } catch (error) {
        emitDiagnostic({
          kind: "successor_activation_failed",
          conversationId,
          predecessorRunId: activation.diagnosticRunId,
          error,
        });
      }
    })();
    successorActivationTasks.set(conversationId, attempt);
    try {
      await attempt;
    } finally {
      if (successorActivationTasks.get(conversationId) === attempt) {
        successorActivationTasks.delete(conversationId);
      }
    }
  }

  async function activateConversationOnce(
    conversationId: string,
    activation: { diagnosticRunId: string },
  ): Promise<void> {
    const control = await loadControl(conversationId);
    if (control?.state.deletedAt !== undefined) return;
    let runs = await schedulingRuns(conversationId, control);
    let candidate = nextQueuedRun(runs);
    if (candidate === undefined) {
      const settlementBlocker = runs.find((run) =>
        isTerminal(run) && run.status.kind !== "cancelled" &&
        terminalSettlement.hasAcceptedToolResults(run.runId) &&
        !executionState.schedulingFacts(run.runId).executionActive);
      if (settlementBlocker !== undefined) {
        activation.diagnosticRunId = settlementBlocker.runId;
        await terminalSettlement.settleExecution(settlementBlocker.runId);
        terminalSettlement.notifyStable(settlementBlocker.runId);
        runs = await schedulingRuns(conversationId, await loadControl(conversationId));
        candidate = nextQueuedRun(runs);
      }
    }
    if (candidate === undefined) {
      const finalizationBlocker = runs.find((run) =>
        isTerminal(run) && !schedulingBarrierCleared(run) &&
        terminalSettlement.isFinalizationPending(run.runId) &&
        terminalSettlement.finalizationFailure(run.runId) !== undefined);
      if (finalizationBlocker === undefined) return;
      activation.diagnosticRunId = finalizationBlocker.runId;
      await terminalSettlement.retryFinalization(finalizationBlocker.runId);
      if (terminalSettlement.isFinalizationPending(finalizationBlocker.runId) &&
          terminalSettlement.finalizationFailure(finalizationBlocker.runId) !== undefined) {
        throw terminalSettlement.finalizationFailure(finalizationBlocker.runId);
      }
      runs = await schedulingRuns(conversationId, await loadControl(conversationId));
      candidate = nextQueuedRun(runs);
    }
    if (candidate === undefined) return;
    const predecessorRunId = candidate.turn.predecessorRunId;
    if (predecessorRunId !== undefined) {
      const predecessor = runs.find((run) => run.runId === predecessorRunId);
      if (predecessor === undefined || !schedulingBarrierCleared(predecessor)) return;
      activation.diagnosticRunId = predecessorRunId;
    } else {
      activation.diagnosticRunId = candidate.runId;
    }
    const activated = await runStore.withExclusiveRun(candidate.runId, async () => {
      if (options.isReleased()) return undefined;
      const current = await runStore.load(candidate.runId);
      if (current === undefined || current.state.status.kind !== "queued") return undefined;
      const latestControl = await loadControl(current.state.turn.conversationId);
      if (latestControl?.state.deletedAt !== undefined) return undefined;
      const latestRuns = await schedulingRuns(current.state.turn.conversationId, latestControl);
      const latestCandidate = nextQueuedRun(latestRuns);
      if (options.isReleased() || latestCandidate?.runId !== current.state.runId) return undefined;
      if (current.state.turn.predecessorRunId !== undefined) {
        const latestPredecessor = latestRuns.find((run) => run.runId === current.state.turn.predecessorRunId);
        if (latestPredecessor === undefined || !schedulingBarrierCleared(latestPredecessor)) return undefined;
      }
      return runStore.mutateLocked(current.state.runId, { type: "start" });
    });
    if (activated?.status.kind === "running") executionCoordinator.start(activated.runId);
  }

  async function schedulingRuns(
    conversationId: string,
    control: OrdinaryConversationControlDocument | undefined,
  ): Promise<readonly OrdinaryRunState[]> {
    if (unavailableConversationIds.has(conversationId)) return [];
    if (control !== undefined) return visibleRuns(control);
    return orderedConversationRuns(
      conversationId,
      runStore.cachedDocuments().map((document) => document.state),
    );
  }

  async function activateRootQueued(runId: string): Promise<void> {
    if (options.isReleased()) return;
    const queued = await runStore.load(runId);
    if (queued === undefined || queued.state.status.kind !== "queued" || queued.state.turn.predecessorRunId !== undefined) return;
    await requestConversationActivation(queued.state.turn.conversationId, runId);
  }

  async function startWithinConversation(startInput: StartOrdinaryRunInput): Promise<OrdinaryRunState> {
    assertLive();
    const conversationControl = await loadControl(startInput.turn.conversationId);
    if (conversationControl?.state.deletedAt !== undefined) {
      throw new OrdinaryFeatureError(
        "ordinary_conversation_deleted",
        `Ordinary conversation ${startInput.turn.conversationId} was deleted`,
      );
    }
    if (await runStore.load(startInput.runId) !== undefined) {
      throw new OrdinaryFeatureError("ordinary_run_conflict", `Ordinary run ${startInput.runId} already exists`);
    }
    const predecessor = startInput.turn.predecessorRunId === undefined
      ? undefined
      : await runStore.load(startInput.turn.predecessorRunId);
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
    if (predecessor !== undefined && runStore.cachedDocuments().some((document) =>
      document.state.status.kind === "queued" && document.state.turn.predecessorRunId === predecessor.state.runId)) {
      throw new OrdinaryFeatureError(
        "ordinary_run_conflict",
        `Ordinary predecessor run ${predecessor.state.runId} already has a queued successor`,
      );
    }
    const claim = await managedAttachments.claimForRun({
      runInput: startInput.input,
      conversationId: startInput.turn.conversationId,
      runId: startInput.runId,
    });
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
      created = await runStore.persistUnpublished(initial, 0);
    } catch (error) {
      await claim.rollback();
      throw error;
    }
    await claim.commit();
    runStore.publishBirth(created);
    activityHub.recordTransition(initial.timeline[0]);
    if (predecessor === undefined) {
      trackPostExecutionTask(requestAutoConversationTitleIfMissing(initial.runId));
      try {
        const running = await runStore.mutate(initial.runId, { type: "start" });
        executionCoordinator.start(initial.runId);
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
    const latestPredecessor = await runStore.load(predecessor.state.runId);
    if (latestPredecessor !== undefined && isTerminal(latestPredecessor.state)) {
      await activateSuccessor(latestPredecessor.state.runId);
    }
    const current = await runStore.load(initial.runId);
    if (current === undefined) {
      throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${initial.runId} was not found after creation`);
    }
    return clone(current.state);
  }

  async function start(startInput: StartOrdinaryRunInput): Promise<OrdinaryRunState> {
    return withConversationLock(startInput.turn.conversationId, async () => {
      await settlePendingUncommittedConversationCleanup(startInput.turn.conversationId);
      return startWithinConversation(startInput);
    });
  }

  async function submitTurn(submitInput: SubmitOrdinaryTurnInput): Promise<SubmitOrdinaryTurnResult> {
    assertLive();
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
    return withConversationLock(conversationId, async () => {
      await settlePendingUncommittedConversationCleanup(conversationId);
      let createdConversation = false;
      let createdConversationSession: AgentSessionRef | undefined;
      if (submissionTurnId !== undefined) {
        const existing = runStore.cachedDocuments().find((document) =>
          document.state.turn.userTurnId === submissionTurnId);
        if (existing !== undefined) {
          if (existing.state.turn.conversationId !== conversationId ||
            !sameSubmissionInput(existing.state.input, submitInput.input)) {
            throw new OrdinaryFeatureError(
              "ordinary_submission_conflict",
              `Ordinary submission ${submissionId} was already used for different input.`,
            );
          }
          const existingControl = await loadControl(conversationId);
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
      let control = await loadControl(conversationId);
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
        const sessionRef = await options.sessionRepository.create({
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
          control = await options.conversationRepository.save(state, 0, createdAt);
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
      control = await options.conversationRepository.get(conversationId);
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
        await options.sessionRepository.delete(pending.sessionRef);
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
      runIds = (await runStore.listSummaries(Number.MAX_SAFE_INTEGER))
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
    const pending = conversationCleanupJobs.get(conversationId)?.pendingUncommitted;
    if (pending === undefined) return;
    await scheduleConversationCleanup(
      conversationId,
      pending.control,
      pending.runIds,
      "delete_uncommitted",
    );
    if (conversationCleanupJobs.get(conversationId)?.pendingUncommitted !== undefined) {
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
      persistedRun = await runStore.inspectPersisted(inputValue.runId);
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
    if (persistedRun !== undefined && runStore.has(inputValue.runId)) return;

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
    return withConversationLock(conversationId, async () => {
      await settlePendingUncommittedConversationCleanup(conversationId);
      const current = await loadControl(conversationId);
      if (current === undefined) {
        throw new OrdinaryFeatureError(
          "ordinary_conversation_not_found",
          `Ordinary conversation ${conversationId} was not found`,
        );
      }
      assertConversationWritable(current);
      const changedAt = now();
      const saved = await options.conversationRepository.save(update(clone(current.state), changedAt), current.revision, changedAt);
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
    const control = await withConversationLock(rollback.conversationId, async () => {
      await settlePendingUncommittedConversationCleanup(rollback.conversationId);
      const current = await loadControl(rollback.conversationId);
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
      await options.sessionRepository.moveActiveLeaf(current.state.sessionRef, target.session.endLeafRef);
      return current;
    });
    return requireConversationView(control);
  }

  async function deleteConversation(conversationId: string): Promise<void> {
    assertLive();
    let cleanup: {
      readonly tombstone: OrdinaryConversationControlDocument;
      readonly runIds: readonly string[];
    } | undefined;
    await withConversationLock(conversationId, async () => {
      await settlePendingUncommittedConversationCleanup(conversationId);
      const current = await loadControl(conversationId);
      if (current === undefined) return;
      let tombstone = current;
      if (current.state.deletedAt === undefined) {
        const deletedAt = now();
        tombstone = await options.conversationRepository.save({ ...current.state, deletedAt }, current.revision, deletedAt);
        conversationDocuments.set(conversationId, tombstone);
      }
      const owned = runStore.cachedDocuments().filter((document) => document.state.turn.conversationId === conversationId);
      for (const document of owned) {
        if (!isTerminal(document.state)) await executionCoordinator.cancel(document.state.runId, "conversation_deleted");
      }
      cleanup = {
        tombstone,
        runIds: [...new Set(owned.map((document) => document.state.runId))],
      };
    });
    if (cleanup !== undefined) {
      const cleaned = await scheduleConversationCleanup(conversationId, cleanup.tombstone, cleanup.runIds);
      if (!cleaned) {
        throw new OrdinaryFeatureError(
          "ordinary_conversation_cleanup_pending",
          `Ordinary conversation ${conversationId} cleanup failed; retry DELETE.`,
        );
      }
    }
  }

  async function scheduleConversationCleanup(
    conversationId: string,
    control: OrdinaryConversationControlDocument,
    runIds: readonly string[],
    disposition: ConversationCleanupDisposition = "retain_tombstone",
  ): Promise<boolean> {
    if (options.isReleased()) return false;
    const existingJob = conversationCleanupJobs.get(conversationId);
    const job = existingJob ?? createConversationCleanupJob();
    if (existingJob === undefined) conversationCleanupJobs.set(conversationId, job);
    const request = prepareConversationCleanup(job, control, runIds, disposition);
    if (job.activeTask !== undefined) return job.activeTask;
    let cleanupFailed = false;
    const cleanup = (async () => {
      const cleanupRunIds = new Set(request.runIds);
      if (request.disposition === "retain_tombstone") {
        try {
          const persisted = await runStore.listSummaries(Number.MAX_SAFE_INTEGER);
          for (const summary of persisted) {
            if (summary.conversationId === conversationId) cleanupRunIds.add(summary.runId);
          }
        } catch (error) {
          cleanupFailed = true;
          emitDiagnostic({
            kind: "conversation_cleanup_failed",
            conversationId,
            phase: "run_enumeration",
            error,
          });
        }
      }
      for (const runId of cleanupRunIds) {
        await executionState.waitForRunExecution(runId);
        await executionState.waitForCancellationCleanup(runId);
        try {
          await terminalSettlement.settleExecution(runId);
        } catch (error) {
          cleanupFailed = true;
          emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "terminal_settlement", runId, error });
          continue;
        }
        if (options.releaseToolEvidenceOwner !== undefined) {
          try {
            await options.releaseToolEvidenceOwner(runId);
          } catch (error) {
            cleanupFailed = true;
            emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "tool_evidence", runId, error });
            continue;
          }
        }
        try {
          await memoryFactRepository.deleteByRunIds([runId]);
        } catch (error) {
          cleanupFailed = true;
          emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "memory_facts", runId, error });
          continue;
        }
        try {
          await runStore.delete(runId);
        } catch (error) {
          cleanupFailed = true;
          emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "run_snapshot", runId, error });
          continue;
        }
        terminalSettlement.clearAcceptedToolResults(runId);
        activityHub.releaseRun(runId);
      }
      if (request.disposition === "retain_tombstone" || (!cleanupFailed && cleanupRunIds.size > 0)) {
        try {
          await managedAttachments.deleteConversation(conversationId);
        } catch (error) {
          cleanupFailed = true;
          emitDiagnostic({ kind: "managed_attachment_cleanup_failed", conversationId, error });
        }
      }
      if (request.disposition === "retain_tombstone" || !cleanupFailed) {
        try {
          await options.sessionRepository.delete(request.control.state.sessionRef);
        } catch (error) {
          cleanupFailed = true;
          emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "session", error });
        }
      }
      if (!cleanupFailed && request.disposition === "delete_uncommitted") {
        try {
          await options.conversationRepository.delete(conversationId, request.control.revision);
          conversationDocuments.delete(conversationId);
          unavailableConversationIds.delete(conversationId);
        } catch (error) {
          cleanupFailed = true;
          emitDiagnostic({ kind: "conversation_cleanup_failed", conversationId, phase: "conversation_control", error });
        }
      }
    })();
    const tracked = cleanup
      .then(() => {
        if (!cleanupFailed) recordConversationCleanupSuccess(job, request);
        return !cleanupFailed;
      })
      .finally(() => {
        if (job.activeTask === tracked) job.activeTask = undefined;
        if (conversationCleanupJobIsIdle(job)) conversationCleanupJobs.delete(conversationId);
      });
    job.activeTask = tracked;
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
    return managedAttachments.createDraft(draftInput);
  }

  async function discardManagedAttachmentDraft(attachmentId: string): Promise<void> {
    assertLive();
    await managedAttachments.discardDraft(attachmentId);
  }

  async function visibleRuns(control: OrdinaryConversationControlDocument): Promise<readonly OrdinaryRunState[]> {
    const runs = runStore.cachedDocuments().map((document) => document.state);
    const activeBranch = await options.sessionRepository.getActiveBranchEntryRefs(control.state.sessionRef);
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
      : await options.sessionRepository.readAssistantEntries({
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

  async function getConversation(conversationId: string): Promise<OrdinaryConversationReadModel | undefined> {
    const control = await loadControl(conversationId);
    return control === undefined ? undefined : clone(await conversationView(control));
  }

  async function listConversationsByOwner(
    owner: NonNullable<OrdinaryConversationControlState["owner"]>,
  ): Promise<readonly OrdinaryConversationReadModel[]> {
    const projected = await Promise.all([...conversationDocuments.values()].map((control) =>
      control.state.owner !== undefined &&
      control.state.owner.kind === owner.kind &&
      control.state.owner.id === owner.id
        ? conversationView(control)
        : Promise.resolve(undefined)));
    return clone(projected.filter((view): view is OrdinaryConversationReadModel => view !== undefined));
  }

  async function listConversations(limit = 50): Promise<readonly OrdinaryConversationReadModel[]> {
    const projected = await Promise.all([...conversationDocuments.values()].map(conversationView));
    const views = projected.filter((view): view is OrdinaryConversationReadModel => view !== undefined).sort((left, right) => {
      const pinned = (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "");
      return pinned === 0 ? right.updatedAt.localeCompare(left.updatedAt) : pinned;
    });
    return clone(views.slice(0, Math.max(0, Math.floor(limit))));
  }

  return {
    requestAutoConversationTitleIfMissing,
    subscribeConversationTitleChanges(listener: (conversationId: string) => void) {
      conversationTitleListeners.add(listener);
      return () => conversationTitleListeners.delete(listener);
    },
    activateSuccessor,
    activateRootQueued,
    start,
    submitTurn,
    reconcilePendingUncommittedConversationBirth,
    settlePendingUncommittedConversationCleanup,
    renameConversation,
    setConversationPinned,
    rollbackConversation,
    deleteConversation,
    scheduleConversationCleanup,
    createManagedAttachmentDraft,
    discardManagedAttachmentDraft,
    visibleRuns,
    conversationView,
    requireConversationView,
    getConversation,
    listConversationsByOwner,
    listConversations,
    loadControl,
    markUnavailable,
    isHiddenConversation,
    isHiddenRun,
    controls: () => [...conversationDocuments.values()],
    unavailable: (conversationId: string) => unavailableConversationIds.has(conversationId),
    unavailableIds: () => [...unavailableConversationIds],
    cachedControl: (conversationId: string) => conversationDocuments.get(conversationId),
    adoptControl(document: OrdinaryConversationControlDocument) {
      conversationDocuments.set(document.state.conversationId, document);
    },
    hasControl: (conversationId: string) => conversationDocuments.has(conversationId),
    prepareRelease() {
      for (const job of conversationCleanupJobs.values()) job.pendingUncommitted = undefined;
      pendingUncommittedConversationBirths.clear();
    },
    async awaitOwnedTasks() {
      await Promise.allSettled(successorActivationTasks.values());
      await Promise.allSettled([...conversationCleanupJobs.values()].flatMap((job) =>
        job.activeTask === undefined ? [] : [job.activeTask]));
      await Promise.allSettled(mutationQueues.values());
    },
    clear() {
      successorActivationTasks.clear();
      conversationCleanupJobs.clear();
      conversationDocuments.clear();
      unavailableConversationIds.clear();
      autoTitleGenerationTasks.clear();
      conversationTitleListeners.clear();
      mutationQueues.clear();
    },
  };
}

function clone<T>(value: T): T {
  return globalThis.structuredClone(value);
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
