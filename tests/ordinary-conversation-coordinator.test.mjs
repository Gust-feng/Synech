import assert from "node:assert/strict";
import test from "node:test";

import { createOrdinaryConversationCoordinator } from "../dist/app/ordinary-agent/feature/conversation-coordinator.js";

test("new conversation birth failure cleans unpublished run, control, and session", async () => {
  const fixture = createFixture({ claimCommitFailure: new Error("claim commit failed") });

  await assert.rejects(
    fixture.coordinator.submitTurn({
      newConversationId: "conversation-new",
      owner: { kind: "space", id: "space-1" },
      input: { userMessage: "create it" },
      birth: birth(),
    }),
    /claim commit failed/u,
  );

  assert.equal(fixture.events.some((event) => event.startsWith("publish:")), false);
  assert.equal(fixture.events.some((event) => event.startsWith("delete-run:")), true);
  assert.equal(fixture.events.includes("delete-control:conversation-new"), true);
  assert.equal(fixture.events.some((event) => event.startsWith("delete-session:")), true);
  assert.equal(await fixture.coordinator.getConversation("conversation-new"), undefined);
});

test("rollback moves the Session leaf and delete performs owned cleanup", async () => {
  const run1 = completedRun("run-1", 1, undefined, "entry-1");
  const run2 = completedRun("run-2", 2, "run-1", "entry-2");
  const fixture = createFixture({ documents: [run1, run2], activeEntryIds: ["entry-1", "entry-2"] });
  fixture.coordinator.adoptControl(control("conversation-1"));

  const rolledBack = await fixture.coordinator.rollbackConversation({ conversationId: "conversation-1", stepsBack: 1 });
  assert.equal(rolledBack.latestRunId, "run-1");
  assert.equal(fixture.events.includes("move-leaf:entry-1"), true);

  await fixture.coordinator.deleteConversation("conversation-1");
  assert.equal(fixture.events.includes("delete-run:run-1"), true);
  assert.equal(fixture.events.includes("delete-run:run-2"), true);
  assert.equal(fixture.events.includes("delete-managed:conversation-1"), true);
  assert.equal(fixture.events.includes("delete-session:session-1"), true);
  assert.equal(fixture.events.includes("release-activity:run-1"), true);
});

test("title generation is attempted once and view/list read from the owned cache", async () => {
  const run = cancelledRun("run-title", "conversation-title");
  let titleAttempts = 0;
  const fixture = createFixture({
    documents: [run],
    generateConversationTitle: async () => {
      titleAttempts += 1;
      return "Generated title";
    },
  });
  fixture.coordinator.adoptControl(control("conversation-title", { owner: { kind: "space", id: "space-1" } }));

  await fixture.coordinator.requestAutoConversationTitleIfMissing("run-title");
  await fixture.coordinator.requestAutoConversationTitleIfMissing("run-title");
  const view = await fixture.coordinator.getConversation("conversation-title");
  const listed = await fixture.coordinator.listConversationsByOwner({ kind: "space", id: "space-1" });

  assert.equal(titleAttempts, 1);
  assert.equal(view.title, "Generated title");
  assert.deepEqual(listed.map((item) => item.conversationId), ["conversation-title"]);
  assert.deepEqual((await fixture.coordinator.listConversations()).map((item) => item.title), ["Generated title"]);
});

function createFixture(overrides = {}) {
  const events = [];
  const cached = new Map((overrides.documents ?? []).map((document) => [document.state.runId, document]));
  const persisted = new Map(cached);
  const controls = new Map();
  let activeEntryIds = [...(overrides.activeEntryIds ?? [])];
  let nextId = 0;
  const runStore = {
    cached: (runId) => cached.get(runId),
    cachedDocuments: () => [...cached.values()],
    has: (runId) => cached.has(runId),
    load: async (runId) => cached.get(runId),
    withExclusiveRun: async (_runId, operation) => await operation(),
    async persistUnpublished(state) {
      const document = { revision: 1, state: structuredClone(state) };
      persisted.set(state.runId, document);
      events.push(`persist-unpublished:${state.runId}`);
      return document;
    },
    publishBirth(document) {
      cached.set(document.state.runId, document);
      events.push(`publish:${document.state.runId}`);
    },
    inspectPersisted: async (runId) => persisted.get(runId),
    listSummaries: async () => [...persisted.values()].map((document) => ({
      runId: document.state.runId,
      conversationId: document.state.turn.conversationId,
    })),
    async delete(runId) {
      cached.delete(runId);
      persisted.delete(runId);
      events.push(`delete-run:${runId}`);
    },
    async mutate(runId, transition) {
      const document = cached.get(runId);
      const state = transition.type === "start"
        ? { ...document.state, status: { kind: "running" } }
        : document.state;
      cached.set(runId, { revision: document.revision + 1, state });
      return state;
    },
    async mutateLocked(runId, transition) { return await this.mutate(runId, transition); },
  };
  const conversationRepository = {
    async get(conversationId) { return controls.get(conversationId); },
    async save(state, expectedRevision, savedAt) {
      const current = controls.get(state.conversationId);
      assert.equal(current?.revision ?? 0, expectedRevision);
      const document = { revision: expectedRevision + 1, savedAt, state: structuredClone(state) };
      controls.set(state.conversationId, document);
      events.push(`save-control:${state.conversationId}`);
      return document;
    },
    async delete(conversationId) {
      controls.delete(conversationId);
      events.push(`delete-control:${conversationId}`);
    },
  };
  const sessionRepository = {
    async create({ sessionId, sessionCwd }) {
      return { sessionId, storageKey: `session:${sessionId}`, sessionCwd, createdAt: NOW };
    },
    async delete(sessionRef) { events.push(`delete-session:${sessionRef.sessionId}`); },
    async getActiveBranchEntryRefs() {
      return activeEntryIds.map((entryId) => ({ sessionId: "session-1", entryId }));
    },
    async moveActiveLeaf(_sessionRef, target) {
      activeEntryIds = target === null ? [] : activeEntryIds.slice(0, activeEntryIds.indexOf(target.entryId) + 1);
      events.push(`move-leaf:${target?.entryId ?? "root"}`);
      return target;
    },
    async readAssistantEntries({ entryRefs }) {
      return entryRefs.map((entryRef) => ({ entryRef, text: `answer:${entryRef.entryId}` }));
    },
  };
  const managedAttachments = {
    async claimForRun({ runInput }) {
      return {
        runInput,
        async commit() {
          if (overrides.claimCommitFailure !== undefined) throw overrides.claimCommitFailure;
        },
        async rollback() { events.push("rollback-claim"); },
      };
    },
    async createDraft() { return {}; },
    async discardDraft() {},
    async deleteConversation(conversationId) { events.push(`delete-managed:${conversationId}`); },
  };
  const settlement = {
    hasAcceptedToolResults: () => false,
    isFinalizationPending: () => false,
    isStable: () => true,
    finalizationFailure: () => undefined,
    retryFinalization: async () => undefined,
    settleExecution: async () => undefined,
    notifyStable: () => undefined,
    clearAcceptedToolResults: () => undefined,
  };
  const coordinator = createOrdinaryConversationCoordinator({
    conversationRepository,
    runStore,
    sessionRepository,
    managedAttachments,
    memoryFactRepository: { async deleteByRunIds() {} },
    releaseToolEvidenceOwner: async () => undefined,
    activity: {
      recordTransition: () => undefined,
      releaseRun: (runId) => { events.push(`release-activity:${runId}`); },
    },
    execution: {
      start: (runId) => { events.push(`start:${runId}`); },
      cancel: async () => cancelledRun("cancelled", "conversation-1").state,
      schedulingFacts: () => ({ unsettledToolWork: false, executionActive: false }),
      trackPostTask: () => undefined,
      waitForRunExecution: async () => undefined,
      waitForCancellationCleanup: async () => undefined,
    },
    settlement,
    generateConversationTitle: overrides.generateConversationTitle,
    now: () => NOW,
    idFactory: (prefix) => `${prefix}-${++nextId}`,
    isReleased: () => false,
    emitDiagnostic: (diagnostic) => { events.push(`diagnostic:${diagnostic.kind}`); },
  });
  return { coordinator, events };
}

const NOW = "2026-08-25T00:00:00.000Z";

function control(conversationId, overrides = {}) {
  return {
    revision: 1,
    savedAt: NOW,
    state: {
      conversationId,
      createdAt: NOW,
      sessionRef: { sessionId: "session-1", storageKey: "session:1", sessionCwd: ".", createdAt: NOW },
      owner: overrides.owner ?? { kind: "space", id: "space-1" },
    },
  };
}

function completedRun(runId, ordinal, predecessorRunId, entryId) {
  return {
    revision: 1,
    state: {
      ...baseRun(runId, "conversation-1", ordinal, predecessorRunId),
      status: { kind: "completed" },
      session: {
        phase: "rollbackable",
        startLeafRef: null,
        endLeafRef: { sessionId: "session-1", entryId },
        compactionEntryRefs: [],
      },
    },
  };
}

function cancelledRun(runId, conversationId) {
  return {
    revision: 1,
    state: {
      ...baseRun(runId, conversationId, 1),
      status: { kind: "cancelled", reason: "cancelled_by_user" },
      session: { phase: "not_started" },
    },
  };
}

function baseRun(runId, conversationId, ordinal, predecessorRunId) {
  return {
    runId,
    sessionRef: { sessionId: "session-1", storageKey: "session:1", sessionCwd: ".", createdAt: NOW },
    turn: {
      conversationId,
      ordinal,
      userTurnId: `user-${ordinal}`,
      assistantTurnId: `assistant-${ordinal}`,
      ...(predecessorRunId === undefined ? {} : { predecessorRunId }),
    },
    input: { userMessage: `message ${ordinal}` },
    birth: birth(),
    timeline: [],
    toolCalls: [],
    toolResultRecordedAt: {},
    timestamps: { createdAt: NOW, updatedAt: NOW },
  };
}

function birth() {
  return {
    instructions: "test", aiMode: "chat",
    config: { kind: "openai-compatible", profileId: "profile-1", model: "test-model" },
    agentDefinitionRef: { agentId: "ordinary", promptRef: "ordinary", promptVersion: "1" },
    capabilitySnapshot: {
      snapshotId: "snapshot-1", createdAt: NOW,
      activeModel: { kind: "openai-compatible", profileId: "profile-1", model: "test-model" },
      modelCapabilities: {}, toolCatalog: { scope: "agent-basic", tools: [], allowedTools: [] },
      skillCatalog: [], subAgentCatalog: [], skillTrigger: { mode: "keyword" }, mcpCatalog: [],
      executionRoot: ".", toolConfirmation: { policy: "never" }, warnings: [],
    },
    agentNoteVersions: [], memoryOwner: { kind: "global" }, workspaceSelection: "explicit",
    ownerContext: "test", informationAccess: { web: { enabled: false } }, toolConfirmationPolicy: "never",
  };
}
