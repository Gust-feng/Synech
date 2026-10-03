import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outputRoot = path.resolve(process.env.SYNECH_TEST_DIST ?? "dist");
const ordinaryModule = (name) => import(pathToFileURL(path.join(outputRoot, "app/ordinary-agent", `${name}.js`)));
const { isTerminalStatus } = await ordinaryModule("run-lifecycle-policy");
const {
  createInitialOrdinaryRunState,
  transitionOrdinaryRun,
} = await ordinaryModule("state");
const { createOrdinaryAgentLoopExecutionPort } = await ordinaryModule("agent-loop-execution");
const { createTerminalSettlement } = await ordinaryModule("terminal-settlement");
const { createOrdinaryRunStore } = await ordinaryModule("feature/run-store");
const { createOrdinaryExecutionCoordinator } = await ordinaryModule("feature/execution-coordinator");
const { createOrdinaryExecutionOperations } = await ordinaryModule("feature/execution-operations");
const { createOrdinaryConversationCoordinator } = await ordinaryModule("feature/conversation-coordinator");
const { createOrdinaryAgentFeature } = await ordinaryModule("ordinary-agent-feature");
const { visibleOrdinaryConversationRuns, isPreSessionTerminalRun } = await ordinaryModule("conversation-projection");
const { createPanelUsageStatistics } = await import(pathToFileURL(path.join(outputRoot, "app/panel-server/workbench/panel-usage-statistics.js")));

test("Ordinary terminal policy distinguishes completed, failed, cancelled and blocked", () => {
  for (const kind of ["completed", "failed", "cancelled", "blocked"]) {
    assert.equal(isTerminalStatus({ kind }), true);
  }
  for (const kind of ["queued", "running", "awaiting_approval"]) {
    assert.equal(isTerminalStatus({ kind }), false);
  }
});

test("cancellation before the first Session entry remains visible and shared positions keep turn order", async () => {
  const recordedAt = "2026-10-01T00:00:00.000Z";
  const sessionRef = { sessionId: "pre-entry-session", storageKey: "pre-entry-session", sessionCwd: process.cwd(), createdAt: recordedAt };
  const control = { state: { conversationId: "pre-entry", sessionRef } };
  const first = createInitialOrdinaryRunState({ runId: "first", sessionRef,
    turn: { conversationId: "pre-entry", ordinal: 1, userTurnId: "user", assistantTurnId: "assistant" },
    runInput: { userMessage: "Hello" }, birth: {}, recordedAt, eventId: "created" });
  const transition = (state, transition) => transitionOrdinaryRun({ state, transition, recordedAt, eventId: transition.type });
  const captured = transition(transition(first, { type: "start" }), {
    type: "record_session_checkpoint", checkpoint: { sessionId: sessionRef.sessionId, kind: "start_leaf_captured", checkpoint: null },
  });
  const cancelled = transition(captured, { type: "cancel", reason: "cancelled_by_user" });
  assert.equal(isPreSessionTerminalRun(cancelled), true);
  assert.deepEqual(await visibleOrdinaryConversationRuns({ async locateSessionCheckpoints() { return []; } }, control, [cancelled]), [cancelled]);

  const checkpoint = { sessionId: sessionRef.sessionId, checkpointId: "prefix", kind: "input_committed" };
  const prior = transition(captured, { type: "record_session_checkpoint",
    checkpoint: { sessionId: sessionRef.sessionId, kind: "input_entry_committed", checkpoint } });
  const stoppedPrior = transition(prior, { type: "cancel", reason: "cancelled_by_user" });
  const nextInitial = createInitialOrdinaryRunState({ runId: "next", sessionRef,
    turn: { conversationId: "pre-entry", ordinal: 2, predecessorRunId: "first", userTurnId: "next-user", assistantTurnId: "next-assistant" },
    runInput: { userMessage: "Continue" }, birth: {}, recordedAt, eventId: "next-created" });
  const next = transition(transition(transition(nextInitial, { type: "start" }), {
    type: "record_session_checkpoint", checkpoint: { sessionId: sessionRef.sessionId, kind: "start_leaf_captured", checkpoint },
  }), { type: "cancel", reason: "cancelled_by_user" });
  const store = { async locateSessionCheckpoints() { return [{ checkpoint, position: 0 }]; } };
  assert.deepEqual((await visibleOrdinaryConversationRuns(store, control, [next, stoppedPrior])).map((run) => run.runId), ["first", "next"]);

  // A later turn can commit its first entry after its predecessor was cancelled before input.
  const committedNext = transition(transition(transition(nextInitial, { type: "start" }), {
    type: "record_session_checkpoint", checkpoint: { sessionId: sessionRef.sessionId, kind: "start_leaf_captured", checkpoint: null },
  }), { type: "record_session_checkpoint", checkpoint: { sessionId: sessionRef.sessionId, kind: "input_entry_committed", checkpoint } });
  const stoppedNext = transition(committedNext, { type: "cancel", reason: "cancelled_by_user" });
  assert.deepEqual((await visibleOrdinaryConversationRuns(store, control, [stoppedNext, cancelled])).map((run) => run.runId), ["first", "next"]);

  // Following the selected branch must not restore turns retired by message editing or version selection.
  const retiredCheckpoint = { ...checkpoint, checkpointId: "retired-prefix" };
  const retired = { ...stoppedNext, runId: "retired", session: { ...stoppedNext.session, endCheckpoint: retiredCheckpoint } };
  assert.deepEqual((await visibleOrdinaryConversationRuns(store, control, [retired, stoppedNext, cancelled])).map((run) => run.runId), ["first", "next"]);
});

test("startup recovery preserves a live conversation attachment claim without a Run snapshot", async () => {
  const recordedAt = "2026-10-01T00:00:00.000Z";
  const sessionRef = { sessionId: "attachment-recovery-session", storageKey: "attachment-recovery-session", sessionCwd: process.cwd(), createdAt: recordedAt };
  const owner = { kind: "workspace", id: "project" };
  const run = transitionOrdinaryRun({
    state: createInitialOrdinaryRunState({ runId: "attachment-run", sessionRef,
      turn: { conversationId: "attachment-conversation", ordinal: 1, userTurnId: "u", assistantTurnId: "a" },
      runInput: { userMessage: "Inspect upload" }, birth: {}, recordedAt, eventId: "created" }),
    transition: { type: "cancel", reason: "cancelled_by_user" }, recordedAt, eventId: "cancelled",
  });
  const documents = new Map([[run.runId, { state: run, revision: 1 }]]);
  let deletedAttachment = false;
  let control = { revision: 1, savedAt: recordedAt, state: { conversationId: "attachment-conversation", createdAt: recordedAt, sessionRef, owner } };
  const attachmentRepository = {
    async list() { return [{ schemaVersion: "ordinary-managed-attachment/v1", attachmentId: "upload-1", owner: { kind: "conversation", conversationId: control.state.conversationId }, originalName: "image.png", byteLength: 3, sha256: "hash", createdAt: recordedAt, updatedAt: recordedAt }]; },
    async delete() { deletedAttachment = true; },
    async createDraft() { throw new Error("not used"); }, async get() { throw new Error("not used"); },
    async resolveContentPath() { throw new Error("not used"); }, async claimForConversation() { throw new Error("not used"); },
    async releaseConversationClaim() { throw new Error("not used"); },
  };
  const feature = createOrdinaryAgentFeature({
    repository: {
      async get(id) { return documents.get(id); },
      async list() { return [...documents.values()].map(({ state }) => ({ runId: state.runId, conversationId: state.turn.conversationId, userTurnId: state.turn.userTurnId, assistantTurnId: state.turn.assistantTurnId, status: state.status.kind, createdAt: state.timestamps.createdAt, updatedAt: state.timestamps.updatedAt })); },
      async inspectRecoveryInventory() { return { summaries: await this.list(), issues: [] }; },
      async save(state, revision) { const document = { state: structuredClone(state), revision: revision + 1 }; documents.set(state.runId, document); return document; },
      async delete(id) { documents.delete(id); },
    },
    conversationRepository: {
      async get() { return control; }, async list() { return [{ conversationId: control.state.conversationId }]; },
      async save(state, revision, savedAt) { return control = { state, revision: revision + 1, savedAt }; },
    },
    execution: { async execute() { throw new Error("not used"); } },
    sessionRepository: { async locateSessionCheckpoints() { return []; } },
    managedAttachmentRepository: attachmentRepository,
    managedAttachmentInstanceId: "new-instance",
    now: () => recordedAt, idFactory: (kind) => `${kind}:id`,
  });
  try {
    await feature.queries.getConversation(control.state.conversationId);
    assert.equal(deletedAttachment, false);
  } finally { await feature.release(); }
});
test("statistics and memory reads preserve conversation history and successor identity", async () => {
  const recordedAt = "2026-10-01T00:00:00.000Z";
  const sessionRef = { sessionId: "history-session", storageKey: "history-session", sessionCwd: process.cwd(), createdAt: recordedAt };
  const owner = { kind: "workspace", id: "project" };
  const birth = { memoryOwner: owner, config: { profileId: "test", model: "text", defaultAiMode: "none" },
    aiMode: "none", instructions: "", capabilitySnapshot: { executionRoot: process.cwd() } };
  const initial = createInitialOrdinaryRunState({ runId: "history-run", sessionRef,
    turn: { conversationId: "history", ordinal: 1, userTurnId: "first-user", assistantTurnId: "first-assistant" },
    runInput: { userMessage: "First turn" }, birth, recordedAt, eventId: "created" });
  const state = transitionOrdinaryRun({ state: initial, transition: { type: "cancel", reason: "cancelled_by_user" },
    recordedAt, eventId: "cancelled" });
  const documents = new Map([[state.runId, { state, revision: 1 }]]);
  const summary = (state) => ({ runId: state.runId, conversationId: state.turn.conversationId,
    userTurnId: state.turn.userTurnId, assistantTurnId: state.turn.assistantTurnId,
    status: state.status.kind, createdAt: state.timestamps.createdAt, updatedAt: state.timestamps.updatedAt });
  let control = { revision: 1, savedAt: recordedAt, state: { conversationId: "history", createdAt: recordedAt, sessionRef, owner } };
  let nextId = 0;
  const feature = createOrdinaryAgentFeature({
    repository: {
      async get(id) { return documents.get(id); },
      async list() { return [...documents.values()].map(({ state }) => summary(state)); },
      async inspectRecoveryInventory() { return { summaries: await this.list(), issues: [] }; },
      async save(state, revision) {
        const document = { state: structuredClone(state), revision: revision + 1 };
        documents.set(state.runId, document);
        return document;
      },
      async delete(id) { documents.delete(id); },
    },
    conversationRepository: {
      async get() { return control; },
      async list() { return [{ conversationId: "history" }]; },
      async save(state, revision, savedAt) { return control = { state, revision: revision + 1, savedAt }; },
    },
    sessionRepository: { async locateSessionCheckpoints() { return []; } },
    execution: { async execute() { return { status: "failed", error: { code: "test_stopped" }, toolCalls: [], usage: {} }; } },
    now: () => recordedAt, idFactory: (kind) => `${kind}:${++nextId}`,
  });
  try {
    assert.equal((await feature.queries.getConversation("history")).latestRunId, state.runId);
    await createPanelUsageStatistics({ ordinaryAgentFeature: feature, generatedAt: recordedAt });
    await feature.queries.listStableEvidenceRuns("history", { fromOrdinal: 1, throughOrdinal: 1 });
    await feature.queries.listConversationMemoryHighWaters();
    assert.equal((await feature.queries.getConversation("history")).latestRunId, state.runId);
    assert.equal((await feature.queries.listConversations()).length, 1);
    const next = await feature.commands.submitTurn({ conversationId: "history", input: { userMessage: "Next turn" }, birth });
    assert.equal(next.run.turn.ordinal, 2);
    assert.equal(next.run.turn.predecessorRunId, state.runId);
  } finally { await feature.release(); }
});

test("conversation deletion retains failed finalization evidence until DELETE retry succeeds", async () => {
  const now = () => "2026-10-01T00:00:00.000Z";
  let nextId = 0;
  const idFactory = (kind) => `${kind}:${++nextId}`;
  const runId = "run-delete-retry";
  const conversationId = "conversation-delete-retry";
  const sessionRef = { sessionId: "session-delete-retry", storageKey: "session-delete-retry", sessionCwd: process.cwd(), createdAt: now() };
  const checkpoint = (checkpointId, kind) => ({ sessionId: sessionRef.sessionId, checkpointId, kind });
  const unwoundCheckpoint = checkpoint("input", "input_committed");
  const lateCheckpoint = checkpoint("late-compaction", "compaction_committed");
  const persistedRuns = new Map();
  const retained = new Set(["attachment", "session", "tool-evidence"]);
  const removalOrder = [];
  const remove = (kind) => { retained.delete(kind); removalOrder.push(kind); };
  const diagnostics = [];
  const emitDiagnostic = (event) => diagnostics.push(event);
  const runStore = createOrdinaryRunStore({
    repository: {
      async get(id) { return persistedRuns.get(id); },
      async save(state, revision) {
        assert.equal(persistedRuns.get(state.runId)?.revision ?? 0, revision);
        const document = { state: structuredClone(state), revision: revision + 1 };
        persistedRuns.set(state.runId, document);
        return document;
      },
      async list() { return [...persistedRuns.values()].map(({ state }) => ({ runId: state.runId, conversationId: state.turn.conversationId })); },
      async delete(id) { persistedRuns.delete(id); removalOrder.push("run"); },
    },
    now, idFactory, visibleAssistantText: () => undefined,
    onLoaded() {}, onSaved() {}, onTransition() {},
  });
  await runStore.savePublished(createInitialOrdinaryRunState({
    runId, sessionRef,
    turn: { conversationId, ordinal: 1, userTurnId: "user", assistantTurnId: "assistant" },
    runInput: { userMessage: "hello" }, birth: {}, recordedAt: now(), eventId: idFactory("created"),
  }), 0);
  await runStore.mutate(runId, { type: "start" });
  await runStore.mutate(runId, {
    type: "record_session_checkpoint",
    checkpoint: { sessionId: sessionRef.sessionId, kind: "start_leaf_captured", checkpoint: null },
  });

  let releaseFails = true;
  let executing;
  const started = new Promise((resolve) => { executing = resolve; });
  const restoredTargets = [];
  const execution = createOrdinaryAgentLoopExecutionPort({
    resources: { async acquire() {
      return {
        resolvedMessages: [], tools: {},
        loop: { async execute({ abortSignal }) {
          executing();
          await new Promise((resolve) => abortSignal.addEventListener("abort", resolve, { once: true }));
          // Cancellation commits first; Pi's unwind can still publish its final checkpoint.
          await runStore.mutate(runId, {
            type: "record_session_checkpoint",
            checkpoint: { sessionId: sessionRef.sessionId, kind: "input_entry_committed", checkpoint: unwoundCheckpoint },
          });
          return { status: "cancelled", toolResults: [], usage: {} };
        } },
        async release() { if (releaseFails) throw new Error("run resource release failed"); },
        async revokeSessionTo(target) { restoredTargets.push(target); },
        async releaseSession() { removalOrder.push("writer-finalized"); },
      };
    } },
  });
  const executionState = createOrdinaryExecutionCoordinator();
  const controller = executionState.beginExecution(runId);
  const settlement = createTerminalSettlement({
    finalizeSession: execution.finalizeSession,
    loadRun: runStore.load, cachedRun: runStore.cached,
    async persistToolResult() {}, async reconcilePendingToolRound() {}, async reconcileLostApprovalResults() {},
    externalSettlementCleared: executionState.externalSettlementCleared,
    isHiddenRun: () => false, hasActivitySubscribers: () => false,
    releaseActivityStream() {}, emitDiagnostic, onStable() {},
  });
  settlement.markSessionAwaitingFinalization(runId);
  executionState.startExecutionTask(runId, execution.execute({
    runId, birth: {}, abortSignal: controller.signal,
  }).then(() => undefined));
  await started;
  const cancellation = createOrdinaryExecutionOperations({
    state: executionState, runStore, activityHub: {}, terminalSettlement: settlement,
    execution, sessionRepository: {}, now, idFactory, isReleased: () => false,
    emitDiagnostic, async activateSuccessor() {},
  });
  let control = { revision: 1, state: { conversationId, sessionRef, owner: { kind: "space", id: "space" } } };
  const coordinator = createOrdinaryConversationCoordinator({
    conversationRepository: {
      async get() { return control; },
      async save(state, revision) { control = { state, revision: revision + 1 }; return control; },
    },
    runStore,
    sessionRepository: { async delete() { remove("session"); } },
    managedAttachments: { async deleteConversation() { remove("attachment"); } },
    releaseToolEvidenceOwner: async () => remove("tool-evidence"),
    activity: { recordTransition() {}, releaseRun() {} },
    execution: {
      start: cancellation.start,
      cancel: cancellation.cancel,
      schedulingFacts: executionState.schedulingFacts,
      trackPostTask: executionState.trackPostExecutionTask,
      waitForRunExecution: executionState.waitForRunExecution,
      waitForCancellationCleanup: executionState.waitForCancellationCleanup,
    },
    settlement, now, idFactory, isReleased: () => false, emitDiagnostic,
  });

  await assert.rejects(coordinator.deleteConversation(conversationId), { code: "ordinary_conversation_cleanup_pending" });
  assert.equal(persistedRuns.get(runId).state.status.kind, "cancelled");
  assert.deepEqual(persistedRuns.get(runId).state.session.endCheckpoint, unwoundCheckpoint);
  assert.ok(control.state.deletedAt, "the tombstone keeps new turns out while DELETE is retryable");
  assert.deepEqual([...retained], ["attachment", "session", "tool-evidence"]);
  assert.deepEqual(removalOrder, []);
  assert.equal(executionState.hasCancellationCleanup(runId), false, "task completion does not imply finalization success");
  assert.equal(settlement.isFinalizationPending(runId), true);
  assert.ok(diagnostics.some((event) => event.kind === "conversation_cleanup_failed" && event.phase === "terminal_settlement"));

  // Durable checkpoint facts can advance after failure; retry must keep the first target.
  await runStore.mutate(runId, {
    type: "record_session_checkpoint",
    checkpoint: { sessionId: sessionRef.sessionId, kind: "compaction_entry_committed", checkpoint: lateCheckpoint },
  });
  assert.deepEqual(persistedRuns.get(runId).state.session.endCheckpoint, lateCheckpoint);
  releaseFails = false;
  await coordinator.deleteConversation(conversationId);
  assert.deepEqual(restoredTargets, [unwoundCheckpoint]);
  assert.equal(settlement.isFinalizationPending(runId), false);
  assert.equal(persistedRuns.has(runId), false);
  assert.equal(runStore.has(runId), false);
  assert.equal(retained.size, 0);
  assert.deepEqual(removalOrder, ["writer-finalized", "tool-evidence", "run", "attachment", "session"]);
  assert.deepEqual(await execution.finalizeSession(runId, lateCheckpoint), { status: "no_session" });
  await coordinator.deleteConversation(conversationId);
  assert.deepEqual(restoredTargets, [unwoundCheckpoint], "repeated DELETE cannot rewind a finalized writer");
  await coordinator.awaitOwnedTasks();
  await executionState.awaitPostExecutionTasks();
  await settlement.release();
});

test("Ordinary state rejects an assistant checkpoint without a model request identity", () => {
  const sessionRef = {
    sessionId: "session-request-identity",
    storageKey: "session-request-identity",
    sessionCwd: process.cwd(),
    createdAt: "2026-09-30T00:00:00.000Z",
  };
  const checkpoint = (checkpointId, kind) => ({
    sessionId: sessionRef.sessionId,
    checkpointId,
    kind,
  });
  const base = createInitialOrdinaryRunState({
    runId: "run-request-identity",
    sessionRef,
    turn: {
      conversationId: "conversation-request-identity",
      ordinal: 1,
      userTurnId: "user-request-identity",
      assistantTurnId: "assistant-request-identity",
    },
    runInput: { userMessage: "hello" },
    birth: {},
    recordedAt: "2026-09-30T00:00:00.000Z",
    eventId: "event-created",
  });
  const started = transitionOrdinaryRun({
    state: base,
    transition: { type: "start" },
    recordedAt: "2026-09-30T00:00:01.000Z",
    eventId: "event-started",
  });
  const withStart = transitionOrdinaryRun({
    state: started,
    transition: {
      type: "record_session_checkpoint",
      checkpoint: {
        sessionId: sessionRef.sessionId,
        kind: "start_leaf_captured",
        checkpoint: null,
      },
    },
    recordedAt: "2026-09-30T00:00:02.000Z",
    eventId: "event-start-checkpoint",
  });
  const withInput = transitionOrdinaryRun({
    state: withStart,
    transition: {
      type: "record_session_checkpoint",
      checkpoint: {
        sessionId: sessionRef.sessionId,
        kind: "input_entry_committed",
        checkpoint: checkpoint("input#1", "input_committed"),
      },
    },
    recordedAt: "2026-09-30T00:00:03.000Z",
    eventId: "event-input-checkpoint",
  });

  assert.throws(
    () => transitionOrdinaryRun({
      state: withInput,
      transition: {
        type: "record_session_checkpoint",
        checkpoint: {
          sessionId: sessionRef.sessionId,
          kind: "assistant_response_entry_committed",
          checkpoint: checkpoint("answer#1", "assistant_response_committed"),
          assistantText: "answer",
        },
      },
      recordedAt: "2026-09-30T00:00:04.000Z",
      eventId: "event-answer-checkpoint",
    }),
    (error) => error?.code === "ordinary_run_state_conflict" &&
      /model request identity/u.test(error.message),
  );
});


// Branch commands protect immutable turns, single-writer selection and restart convergence.
function conversationBranchHarness() {
  const owner = { kind: "workspace", id: "branch-project" };
  const recordedAt = "2026-10-02T00:00:00.000Z";
  const sessionRef = { sessionId: "branch-session", storageKey: "branch-session", sessionCwd: process.cwd(), createdAt: recordedAt };
  const checkpoint = (id) => ({ sessionId: sessionRef.sessionId, checkpointId: id, kind: "assistant_response_committed" });
  const firstCheckpoint = checkpoint("first-answer");
  const secondCheckpoint = checkpoint("second-answer");
  const birth = { memoryOwner: owner, config: { profileId: "test", model: "text", defaultAiMode: "none" },
    aiMode: "none", instructions: "", capabilitySnapshot: { executionRoot: process.cwd() } };
  const makeRun = (runId, ordinal, predecessorRunId, startCheckpoint, endCheckpoint) => {
    const initial = createInitialOrdinaryRunState({ runId, sessionRef,
      turn: { conversationId: "branch-conversation", ordinal, predecessorRunId, userTurnId: `${runId}:user`, assistantTurnId: `${runId}:assistant` },
      runInput: { userMessage: runId }, birth, recordedAt, eventId: `${runId}:created` });
    return { ...initial, status: { kind: "completed" },
      session: { phase: "rollbackable", startCheckpoint, endCheckpoint, compactionCheckpoints: [] },
      visibleAssistantText: `${runId}:answer`, timestamps: { ...initial.timestamps, terminalAt: recordedAt } };
  };
  const first = makeRun("first", 1, undefined, null, firstCheckpoint);
  const second = makeRun("second", 2, "first", firstCheckpoint, secondCheckpoint);
  const documents = new Map([first, second].map((state) => [state.runId, { state, revision: 1 }]));
  let control = { state: { conversationId: "branch-conversation", createdAt: recordedAt, sessionRef, owner }, revision: 1, savedAt: recordedAt };
  let activeCheckpoint = secondCheckpoint;
  let nextId = 0;
  let failBirth = false;
  let releaseExecution;
  let executionGate = Promise.resolve();
  const executions = [];
  const branchEvents = [];
  const summary = (state) => ({ runId: state.runId, conversationId: state.turn.conversationId,
    userTurnId: state.turn.userTurnId, assistantTurnId: state.turn.assistantTurnId, status: state.status.kind,
    createdAt: state.timestamps.createdAt, updatedAt: state.timestamps.updatedAt });
  const createFeature = () => createOrdinaryAgentFeature({
    repository: {
      async get(id) { return documents.get(id); },
      async list() { return [...documents.values()].map(({ state }) => summary(state)); },
      async inspectRecoveryInventory() { return { summaries: await this.list(), issues: [] }; },
      async save(state, revision) {
        if (failBirth && revision === 0) throw new Error("birth write rejected");
        assert.equal(documents.get(state.runId)?.revision ?? 0, revision);
        const document = { state: structuredClone(state), revision: revision + 1 };
        documents.set(state.runId, document);
        return document;
      },
      async delete(id) { documents.delete(id); },
    },
    conversationRepository: {
      async get() { return control; }, async list() { return [{ conversationId: control.state.conversationId }]; },
      async save(state, revision, savedAt) {
        assert.equal(control.revision, revision);
        return control = { state: structuredClone(state), revision: revision + 1, savedAt };
      },
    },
    sessionRepository: {
      async locateSessionCheckpoints({ checkpoints }) {
        const activeIds = activeCheckpoint?.checkpointId === "second-answer" ? ["first-answer", "second-answer"]
          : activeCheckpoint?.checkpointId === "first-answer" ? ["first-answer"] : [];
        return checkpoints.filter((item) => activeIds.includes(item.checkpointId)).map((checkpoint) => ({ checkpoint, position: activeIds.indexOf(checkpoint.checkpointId) }));
      },
      async moveActiveCheckpoint(_ref, target) { activeCheckpoint = target; return target; },
      async readAssistantEntriesByCheckpoint({ checkpoints }) {
        return checkpoints.map((checkpoint) => ({ checkpoint, text: checkpoint.checkpointId }));
      },
    },
    execution: { async execute(input) {
      executions.push(input);
      await executionGate;
      return { status: "failed", error: { code: "test_stopped", message: "Stopped in test" }, toolCalls: [], usage: {} };
    } },
    onConversationBranchSelected: async (event) => { branchEvents.push(event); },
    now: () => new Date(Date.parse(recordedAt) + nextId).toISOString(), idFactory: (kind) => `${kind}:${++nextId}`,
  });
  return { createFeature, documents, birth, first, second, branchEvents, executions,
    get control() { return control; }, get activeCheckpoint() { return activeCheckpoint; },
    rejectBirth(value) { failBirth = value; },
    holdExecution() { executionGate = new Promise((resolve) => { releaseExecution = resolve; }); },
    releaseExecution() { releaseExecution?.(); },
    pendingEdit(committed) {
      const state = { ...createInitialOrdinaryRunState({ runId: "replacement", sessionRef,
        turn: { conversationId: control.state.conversationId, ordinal: 1, userTurnId: "replacement:user", assistantTurnId: "replacement:assistant", replacesRunId: "first" },
        runInput: { userMessage: "Edited first" }, birth, recordedAt, eventId: "replacement:created" }),
        status: { kind: "failed", error: { code: "test_stopped", message: "Stopped" } } };
      if (committed) documents.set(state.runId, { state, revision: 1 });
      activeCheckpoint = null;
      control = { ...control, state: { ...control.state, retiredRunIds: ["first", "second"], previousBranchRunId: "second",
        pendingBranchChange: { kind: "edit", runId: state.runId, targetCheckpoint: null, originalCheckpoint: secondCheckpoint,
          originalRetiredRunIds: [], retainedThroughOrdinal: 0, originalThroughOrdinal: 2 } } };
    },
  };
}

async function awaitTerminal(feature, runId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = await feature.queries.getRun(runId);
    if (run !== undefined && isTerminalStatus(run.status)) {
      await new Promise((resolve) => setImmediate(resolve));
      return run;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Run did not settle");
}

test("editing the first message retains old turns, rejects busy edits and restores message versions and their continuations after restart", async () => {
  const harness = conversationBranchHarness();
  harness.holdExecution();
  let feature = harness.createFeature();
  try {
    const original = structuredClone(harness.documents.get("first"));
    const edited = await feature.commands.submitTurn({ conversationId: "branch-conversation", replacesRunId: "first", submissionId: "edit-first",
      input: { userMessage: "Edited first" }, birth: harness.birth });
    assert.equal(harness.activeCheckpoint, null);
    assert.equal(edited.run.turn.ordinal, 1);
    assert.equal(edited.run.turn.replacesRunId, "first");
    assert.equal(edited.conversation.turns[0].content, "Edited first");
    assert.deepEqual(harness.documents.get("first"), original);
    assert.equal(harness.branchEvents[0].retainedThroughOrdinal, 0);
    const retry = await feature.commands.submitTurn({ conversationId: "branch-conversation", replacesRunId: "first", submissionId: "edit-first",
      input: { userMessage: "Edited first" }, birth: harness.birth });
    assert.equal(retry.run.runId, edited.run.runId);
    await assert.rejects(feature.commands.submitTurn({ conversationId: "branch-conversation", replacesRunId: edited.run.runId,
      input: { userMessage: "Busy edit" }, birth: harness.birth }), (error) => error.code === "ordinary_conversation_busy");
    harness.releaseExecution();
    await awaitTerminal(feature, edited.run.runId);
    assert.equal(harness.executions.length, 1);
    const summaries = await feature.queries.listConversationSummaries({ limit: 1 });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].owner.id, "branch-project");
    assert.equal(summaries[0].latestRunId, edited.run.runId);
    assert.equal("turns" in summaries[0], false);
    await feature.release();
    feature = harness.createFeature();
    assert.equal((await feature.queries.getConversation("branch-conversation")).turns[0].content, "Edited first");
    const restored = await feature.commands.selectConversationBranch({ conversationId: "branch-conversation", targetRunId: "first" });
    assert.deepEqual(restored.turns.filter((turn) => turn.role === "user").map((turn) => turn.content), ["first", "second"]);
    assert.equal(harness.activeCheckpoint.checkpointId, "second-answer");
    assert.equal(restored.turns[0].branchVersions.runIds.length, 2);
    const selectedEdit = await feature.commands.selectConversationBranch({ conversationId: "branch-conversation", targetRunId: edited.run.runId });
    assert.equal(selectedEdit.turns[0].content, "Edited first");
    assert.equal(harness.activeCheckpoint, null);
    const selectedOriginal = await feature.commands.selectConversationBranch({ conversationId: "branch-conversation", targetRunId: "first" });
    assert.equal(selectedOriginal.turns.length, 4);
    assert.equal(harness.activeCheckpoint.checkpointId, "second-answer");
  } finally { harness.releaseExecution(); await feature.release(); }
});

test("failed edit birth restores the original branch and editing a later turn keeps its prefix", async () => {
  const harness = conversationBranchHarness();
  const feature = harness.createFeature();
  try {
    harness.rejectBirth(true);
    await assert.rejects(feature.commands.submitTurn({ conversationId: "branch-conversation", replacesRunId: "first", submissionId: "failed-birth",
      input: { userMessage: "Edited" }, birth: harness.birth }), /birth write rejected/);
    assert.equal(harness.activeCheckpoint.checkpointId, "second-answer");
    assert.equal(harness.control.state.pendingBranchChange, undefined);
    assert.equal(harness.control.state.previousBranchRunId, undefined);
    assert.equal((await feature.queries.getConversation("branch-conversation")).turns.length, 4);
    harness.rejectBirth(false);
    const edited = await feature.commands.submitTurn({ conversationId: "branch-conversation", replacesRunId: "second",
      input: { userMessage: "Edited second" }, birth: harness.birth });
    assert.equal(harness.activeCheckpoint.checkpointId, "first-answer");
    assert.equal(edited.run.turn.predecessorRunId, "first");
    assert.equal(edited.run.turn.ordinal, 2);
    assert.deepEqual(edited.conversation.turns.filter((turn) => turn.role === "user").map((turn) => turn.content), ["first", "Edited second"]);
    await awaitTerminal(feature, edited.run.runId);
    assert.equal((await feature.queries.listStableEvidenceRuns("branch-conversation", { fromOrdinal: 1, throughOrdinal: 2 })).some((run) => run.runId === "second"), false);
  } finally { await feature.release(); }
});

for (const committed of [false, true]) {
  test(`restart converges an interrupted branch edit whose replacement birth is ${committed ? "durable" : "absent"}`, async () => {
    const harness = conversationBranchHarness();
    harness.pendingEdit(committed);
    const feature = harness.createFeature();
    try {
      const conversation = await feature.queries.getConversation("branch-conversation");
      assert.equal(harness.control.state.pendingBranchChange, undefined);
      assert.equal(conversation.turns[0].content, committed ? "Edited first" : "first");
      assert.equal(harness.activeCheckpoint?.checkpointId ?? null, committed ? null : "second-answer");
    } finally { await feature.release(); }
  });
}
