import assert from "node:assert/strict";
import test from "node:test";

import { createConversationLifecycleCoordinator } from "../dist/app/workbench-coordination/index.js";

test("Conversation birth uses owner admission and removes its durable record after commit", async () => {
  const records = new Map();
  const conversations = new Map();
  const admissions = [];
  const coordinator = createConversationLifecycleCoordinator({
    ordinary: {
      commands: {
        async submitTurn(input) {
          const conversationId = input.newConversationId ?? input.conversationId;
          conversations.set(conversationId, { conversationId, owner: input.owner });
          return { conversationId };
        },
        async deleteConversation(conversationId) { conversations.delete(conversationId); },
      },
      queries: {
        async getConversation(conversationId) { return conversations.get(conversationId); },
        async getConversationOwner(conversationId) { return conversations.get(conversationId)?.owner; },
      },
    },
    processes: { async cleanupByConversation() { return emptyCleanup(); } },
    processTerminator: { async killTree() { return { status: "exited" }; } },
    journal: memoryJournal(records),
    async spaceAdmission(spaceId, operation) {
      admissions.push(spaceId);
      return await operation();
    },
    now: () => "2026-08-26T00:00:00.000Z",
  });

  const result = await coordinator.submit({
    owner: { kind: "space", id: "space-1" },
    submissionId: "submission-1",
    runInput: {},
    birth: {},
  });

  assert.deepEqual(admissions, ["space-1"]);
  assert.equal(result.conversationId, "conversation:submission-1");
  assert.equal(records.size, 0);
});

test("Conversation deletion keeps admission closed after cleanup failure and completes on retry", async () => {
  const records = new Map();
  const conversations = new Map([
    ["conversation-1", { conversationId: "conversation-1", owner: { kind: "space", id: "space-1" } }],
  ]);
  let cleanupFails = true;
  const coordinator = createConversationLifecycleCoordinator({
    ordinary: {
      commands: {
        async submitTurn() { throw new Error("not used"); },
        async deleteConversation(conversationId) { conversations.delete(conversationId); },
      },
      queries: {
        async getConversation(conversationId) { return conversations.get(conversationId); },
        async getConversationOwner(conversationId) { return conversations.get(conversationId)?.owner; },
      },
    },
    processes: {
      async cleanupByConversation() {
        return cleanupFails
          ? { attempted: [{ processId: "process-1", outcome: "error" }], skipped: [] }
          : emptyCleanup();
      },
    },
    processTerminator: { async killTree() { return { status: "exited" }; } },
    journal: memoryJournal(records),
    now: () => "2026-08-26T00:00:00.000Z",
  });

  await assert.rejects(
    coordinator.deleteConversation("conversation-1"),
    (error) => error?.code === "background_process_stop_pending",
  );
  assert.throws(
    () => coordinator.assertConversationAvailable("conversation-1"),
    (error) => error?.code === "conversation_deletion_in_progress",
  );
  assert.equal(records.size, 1);

  cleanupFails = false;
  await coordinator.deleteConversation("conversation-1");
  coordinator.assertConversationAvailable("conversation-1");
  assert.equal(conversations.has("conversation-1"), false);
  assert.equal(records.size, 0);
});

function emptyCleanup() {
  return { attempted: [], skipped: [] };
}

function memoryJournal(records) {
  return {
    async list() { return [...records.values()]; },
    async getByConversation(conversationId) {
      return [...records.values()].find((record) => record.conversationId === conversationId);
    },
    async save(record) { records.set(record.operationId, structuredClone(record)); },
    async delete(operationId) { records.delete(operationId); },
  };
}
