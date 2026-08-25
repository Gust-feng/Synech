import assert from "node:assert/strict";
import test from "node:test";

import { createOrdinaryRunStore } from "../dist/app/ordinary-agent/feature/run-store.js";
import { createInitialOrdinaryRunState } from "../dist/app/ordinary-agent/state.js";

test("RunStore keeps a persisted birth unpublished when claim commit fails", async () => {
  const repository = createRepository();
  const store = createStore(repository);
  const initial = initialRun("run-unpublished");
  const claim = {
    async commit() { throw new Error("claim commit failed"); },
  };

  await assert.rejects(async () => {
    const persisted = await store.persistUnpublished(initial, 0);
    await claim.commit();
    store.publishBirth(persisted);
  }, /claim commit failed/u);

  assert.equal(store.cached(initial.runId), undefined);
  assert.equal(await store.load(initial.runId), undefined);
  assert.equal((await store.inspectPersisted(initial.runId))?.state.runId, initial.runId);
});

test("RunStore publishes a birth only after the claim barrier and then owns CAS mutation", async () => {
  const repository = createRepository();
  const transitions = [];
  const savedStates = [];
  const store = createStore(repository, {
    onSaved: (state) => { savedStates.push(state.status.kind); },
    onTransition: (event) => { transitions.push(event.type); },
  });
  const initial = initialRun("run-published");

  const persisted = await store.persistUnpublished(initial, 0);
  assert.equal(store.cached(initial.runId), undefined);
  store.publishBirth(persisted);
  assert.equal(store.cached(initial.runId)?.state.status.kind, "queued");

  const running = await store.mutate(initial.runId, { type: "start" });
  assert.equal(running.status.kind, "running");
  assert.deepEqual(savedStates, ["queued", "running"]);
  assert.deepEqual(transitions, ["run.started"]);
});

function createStore(repository, overrides = {}) {
  let nextId = 0;
  return createOrdinaryRunStore({
    repository,
    now: () => "2026-08-25T00:00:01.000Z",
    idFactory: (prefix) => `${prefix}-${++nextId}`,
    visibleAssistantText: () => undefined,
    onLoaded: overrides.onLoaded ?? (async () => undefined),
    onSaved: overrides.onSaved ?? (() => undefined),
    onTransition: overrides.onTransition ?? (() => undefined),
  });
}

function createRepository() {
  const documents = new Map();
  return {
    async save(state, expectedRevision) {
      const current = documents.get(state.runId);
      assert.equal(current?.revision ?? 0, expectedRevision);
      const document = { schemaVersion: "ordinary-run/v1", revision: expectedRevision + 1, state: structuredClone(state) };
      documents.set(state.runId, document);
      return structuredClone(document);
    },
    async get(runId) {
      const document = documents.get(runId);
      return document === undefined ? undefined : structuredClone(document);
    },
    async list() { return []; },
    async inspectRecoveryInventory() { return { summaries: [], issues: [] }; },
    async delete(runId) { documents.delete(runId); },
  };
}

function initialRun(runId) {
  return createInitialOrdinaryRunState({
    runId,
    sessionRef: { sessionId: `session-${runId}` },
    turn: {
      conversationId: "conversation-1",
      ordinal: 1,
      userTurnId: "user-1",
      assistantTurnId: "assistant-1",
    },
    runInput: { userMessage: "Test unpublished birth" },
    birth: {
      instructions: "test",
      aiMode: "chat",
      config: { kind: "openai-compatible", profileId: "profile-1", model: "test-model" },
      agentDefinitionRef: { agentId: "ordinary", promptRef: "ordinary", promptVersion: "1" },
      capabilitySnapshot: {
        snapshotId: "snapshot-1",
        createdAt: "2026-08-25T00:00:00.000Z",
        activeModel: { kind: "openai-compatible", profileId: "profile-1", model: "test-model" },
        modelCapabilities: {},
        toolCatalog: { scope: "agent-basic", tools: [], allowedTools: [] },
        skillCatalog: [],
        subAgentCatalog: [],
        skillTrigger: { mode: "keyword" },
        mcpCatalog: [],
        executionRoot: ".",
        toolConfirmation: { policy: "never" },
        warnings: [],
      },
      agentNoteVersions: [],
      memoryOwner: { kind: "global" },
      ownerContext: "test",
      informationAccess: { web: { enabled: false } },
      toolConfirmationPolicy: "never",
    },
    recordedAt: "2026-08-25T00:00:00.000Z",
    eventId: "event-created",
  });
}
