import assert from "node:assert/strict";
import test from "node:test";

import { createOrdinaryExecutionCoordinator } from "../dist/app/ordinary-agent/feature/execution-coordinator.js";
import { createOrdinaryExecutionOperations } from "../dist/app/ordinary-agent/feature/execution-operations.js";
import { createInitialOrdinaryRunState, transitionOrdinaryRun } from "../dist/app/ordinary-agent/state.js";

test("invalid execution start releases its controller without settling a session", async () => {
  const fixture = createFixture({ document: undefined });
  fixture.operations.start(RUN_ID);
  await fixture.state.awaitExecutionTasks();
  await fixture.state.awaitPostExecutionTasks();

  assert.equal(fixture.state.hasController(RUN_ID), false);
  assert.equal(fixture.events.includes("settle"), false);
});

test("tool result delivery remembers, persists, then forgets the accepted fact", async () => {
  const result = toolResult();
  const fixture = createFixture({
    execution: {
      async execute(input) {
        await input.onToolResult(result);
        return failedOutcome();
      },
    },
  });
  fixture.operations.start(RUN_ID);
  await fixture.state.awaitExecutionTasks();
  await fixture.state.awaitPostExecutionTasks();

  const remembered = fixture.events.indexOf("remember:tool-1");
  const persisted = fixture.events.indexOf("persist:tool-1");
  const forgotten = fixture.events.indexOf("forget:tool-1");
  assert.equal(remembered >= 0, true);
  assert.equal(remembered < persisted && persisted < forgotten, true, fixture.events.join(" -> "));
});

test("cancel commits the durable terminal fact before aborting execution", async () => {
  const events = [];
  const fixture = createFixture({ events });
  const controller = fixture.state.beginExecution(RUN_ID);
  controller.signal.addEventListener("abort", () => { events.push("abort"); }, { once: true });

  await fixture.operations.cancel(RUN_ID, "cancelled_by_test");
  assert.deepEqual(events.slice(0, 2), ["mutateLocked:cancel", "abort"]);
  await fixture.state.awaitCancellationTasks();
});

test("approval transition failure rolls the continuation lease back", async () => {
  const continuation = { availability: "live_only", decide: async () => failedOutcome(), release: async () => undefined };
  const fixture = createFixture({
    document: { revision: 1, state: awaitingApprovalRun() },
    failLockedTransition: "approval_decided",
  });
  fixture.state.registerApprovalContinuation(RUN_ID, continuation);

  await assert.rejects(
    fixture.operations.decideApproval({
      ownerRunId: RUN_ID,
      confirmationId: "confirmation-1",
      decision: "approved",
      decidedAt: NOW,
    }),
    /approval transition failed/u,
  );
  const restored = fixture.state.beginApprovalDecision(RUN_ID, "confirmation-1");
  assert.equal(restored.status, "acquired");
  assert.equal(restored.lease.continuation, continuation);
  fixture.state.rollbackApprovalDecision(restored.lease);
});

test("completion commit failure records one blocked fallback without rewriting completion as failure", async () => {
  const fixture = createFixture({
    failTransition: "complete",
    execution: { async execute() { return completedOutcome(); } },
  });
  fixture.operations.start(RUN_ID);
  await fixture.state.awaitExecutionTasks();
  await fixture.state.awaitPostExecutionTasks();

  assert.equal(fixture.events.includes("diagnostic:completion_commit_failed"), true);
  assert.equal(fixture.events.includes("mutate:block"), true);
  assert.equal(fixture.events.includes("mutate:fail"), false);
  assert.equal(fixture.events.includes("finalize:keep"), true);
});

const RUN_ID = "run-execution-operations";
const NOW = "2026-08-25T00:00:00.000Z";

function createFixture(overrides = {}) {
  const events = overrides.events ?? [];
  let document = overrides.document === undefined && !("document" in overrides)
    ? { revision: 1, state: runningRun() }
    : overrides.document;
  const state = createOrdinaryExecutionCoordinator();
  const runStore = {
    cached: () => document,
    load: async () => document,
    withExclusiveRun: async (_runId, operation) => await operation(),
    async savePublished(nextState) {
      for (const result of nextState.toolCalls ?? []) {
        if (result.invocationId === "tool-1") events.push("persist:tool-1");
      }
      document = { revision: (document?.revision ?? 0) + 1, state: structuredClone(nextState) };
      return document;
    },
    async mutate(_runId, transition) {
      events.push(`mutate:${transition.type}`);
      if (overrides.failTransition === transition.type) throw new Error(`${transition.type} transition failed`);
      document = { revision: (document?.revision ?? 0) + 1, state: stateAfter(document.state, transition) };
      return document.state;
    },
    async mutateLocked(_runId, transition) {
      events.push(`mutateLocked:${transition.type}`);
      if (overrides.failLockedTransition === transition.type) throw new Error("approval transition failed");
      document = { revision: (document?.revision ?? 0) + 1, state: stateAfter(document.state, transition) };
      return document.state;
    },
    inspectPersisted: async () => document,
    async adoptPersisted(nextDocument) { document = nextDocument; },
  };
  const terminalSettlement = {
    markSessionAwaitingFinalization: () => { events.push("await-finalization"); },
    rememberToolResults: (_runId, results) => {
      for (const result of results) events.push(`remember:${result.invocationId}`);
    },
    forgetPersistedToolResults: (_runId, results) => {
      for (const result of results) events.push(`forget:${result.invocationId}`);
    },
    hasAcceptedToolResult: () => false,
    async finalizeSession(_runId, _runState, rollback) { events.push(`finalize:${rollback ? "rollback" : "keep"}`); },
    async settleExecution() { events.push("settle"); },
    isFinalizationPending: () => false,
    notifyStable: () => { events.push("stable"); },
  };
  const activityHub = new Proxy({}, { get: () => () => undefined });
  activityHub.completeReasoning = async () => undefined;
  activityHub.currentModelRequestId = () => "model-request-1";
  const operations = createOrdinaryExecutionOperations({
    state,
    runStore,
    activityHub,
    terminalSettlement,
    execution: overrides.execution ?? { async execute() { return failedOutcome(); } },
    sessionRepository: {
      readToolCalls: async () => [],
      reconcileToolResultEntries: async () => ({ sessionId: "session-1", entryId: "tool-result-1" }),
      readAssistantEntries: async () => [],
    },
    now: () => NOW,
    idFactory: (prefix) => `${prefix}-1`,
    isReleased: () => false,
    emitDiagnostic: (diagnostic) => { events.push(`diagnostic:${diagnostic.kind}`); },
    activateSuccessor: async () => { events.push("activate-successor"); },
  });
  return { events, operations, state };
}

function runningRun() {
  const initial = createInitialOrdinaryRunState({
    runId: RUN_ID,
    sessionRef: { sessionId: "session-1" },
    turn: { conversationId: "conversation-1", ordinal: 1, userTurnId: "user-1", assistantTurnId: "assistant-1" },
    runInput: { userMessage: "test" },
    birth: birth(),
    recordedAt: NOW,
    eventId: "event-created",
  });
  return transitionOrdinaryRun({
    state: initial,
    transition: { type: "start" },
    recordedAt: NOW,
    eventId: "event-started",
  });
}

function awaitingApprovalRun() {
  return {
    ...runningRun(),
    status: {
      kind: "awaiting_approval",
      confirmationRequests: [{ confirmationId: "confirmation-1", toolName: "Shell", actionSummary: "Run command", riskLevel: "high" }],
      continuationAvailability: "live_only",
    },
  };
}

function stateAfter(state, transition) {
  if (transition.type === "cancel") return { ...state, status: { kind: "cancelled", reason: transition.reason } };
  if (transition.type === "block") return { ...state, status: { kind: "blocked", reason: transition.reason, continueBy: transition.continueBy } };
  if (transition.type === "fail") return { ...state, status: { kind: "failed", error: transition.error } };
  if (transition.type === "complete") return { ...state, status: { kind: "completed" } };
  if (transition.type === "approval_decided") return { ...state, status: { kind: "running" } };
  return state;
}

function toolResult() {
  return {
    invocationId: "tool-1",
    providerCallId: "call-1",
    toolName: "Read",
    input: { path: "README.md" },
    status: "completed",
    output: { ok: true },
    durationMs: 1,
  };
}

function failedOutcome() {
  return { status: "failed", error: { code: "test_failure", message: "failed" }, toolCalls: [], usage: {} };
}

function completedOutcome() {
  return {
    status: "completed",
    answer: "done",
    session: {
      sessionId: "session-1",
      startLeafRef: null,
      safeLeafRef: null,
      latestLeafRef: null,
      compactionEntryRefs: [],
    },
    toolCalls: [],
    usage: {},
  };
}

function birth() {
  return {
    instructions: "test",
    aiMode: "chat",
    config: { kind: "openai-compatible", profileId: "profile-1", model: "test-model" },
    agentDefinitionRef: { agentId: "ordinary", promptRef: "ordinary", promptVersion: "1" },
    capabilitySnapshot: {
      snapshotId: "snapshot-1", createdAt: NOW,
      activeModel: { kind: "openai-compatible", profileId: "profile-1", model: "test-model" },
      modelCapabilities: {}, toolCatalog: { scope: "agent-basic", tools: [], allowedTools: [] },
      skillCatalog: [], subAgentCatalog: [], skillTrigger: { mode: "keyword" }, mcpCatalog: [],
      executionRoot: ".", toolConfirmation: { policy: "never" }, warnings: [],
    },
    agentNoteVersions: [], memoryOwner: { kind: "global" },
    ownerContext: "test", informationAccess: { web: { enabled: false } }, toolConfirmationPolicy: "never",
  };
}
