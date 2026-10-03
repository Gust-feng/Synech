import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryRuntime } from "../dist/app/memory/memory-runtime.js";
import { createProvenAbsentMemoryLifecycle } from "../dist/app/memory/noop.js";

import {
  createConversationLifecycleCoordinator,
  WorkbenchCoordinationError,
} from "../dist/app/workbench-coordination/index.js";

test("conversation-scoped mutations are rejected once deletion admission starts", async () => {
  const records = new Map();
  let deletionStarted;
  const deletionStartedPromise = new Promise((resolve) => { deletionStarted = resolve; });
  let releaseDelete;
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  const lifecycleEvents = [];

  const coordinator = createConversationLifecycleCoordinator({
    ordinary: {
      commands: {
        async submitTurn() {
          throw new Error("not used");
        },
        async deleteConversation() {
          lifecycleEvents.push("ordinary.delete");
          deletionStarted();
          await deleteGate;
        },
      },
      queries: {
        async getConversation() {
          return undefined;
        },
        async getConversationOwner() {
          return undefined;
        },
      },
    },
    processes: {
      async cleanupByConversation() {
        return { attempted: [], skipped: [] };
      },
    },
    processTerminator: {},
    journal: {
      async list() {
        return [...records.values()];
      },
      async getByConversation(conversationId) {
        return [...records.values()].find((record) => record.conversationId === conversationId);
      },
      async save(record) {
        records.set(record.operationId, record);
      },
      async delete(operationId) {
        records.delete(operationId);
      },
    },
    prepareConversationRemoval: async () => {
      lifecycleEvents.push("memory.prepare");
      return {
        ticketId: "memory-ticket",
        scope: { kind: "conversation", conversationId: "conversation-1" },
        fencedGeneration: 1,
        preparedAt: "2026-09-02T00:00:00.000Z",
      };
    },
    finalizeConversationRemoval: async () => {
      lifecycleEvents.push("memory.finalize");
    },
  });

  const deletion = coordinator.deleteConversation("conversation-1");
  await deletionStartedPromise;
  await assert.rejects(
    () => coordinator.admitConversation("conversation-1", async () => "should-not-run"),
    (error) => error instanceof WorkbenchCoordinationError && error.code === "conversation_deletion_in_progress",
  );
  releaseDelete();
  await deletion;
  assert.deepEqual(lifecycleEvents, ["memory.prepare", "ordinary.delete", "memory.finalize"]);
});

test("absent memory query contribution never implies successful lifecycle cleanup", async () => {
  const runtime = createMemoryRuntime({ controlRepository: {} });
  const owner = { kind: "space", id: "s1" };
  assert.equal(await runtime.backgroundPort.getActiveOwnerMemoryHead(owner), undefined);
  const search = await runtime.historyQueryPort.searchEntries({ owner, query: "预算", limit: 8 });
  assert.equal(search.outcome, "unavailable");
  assert.equal((await runtime.historyQueryPort.readEntry({ owner, entryId: "entry", limitTokens: 4_000 })).outcome, "unavailable");
  assert.equal((await runtime.captureRuntime.acceptStableSignal({ owner, conversationId: "c1", stableThrough: { turnId: "u1", ordinal: 1, sourceRevision: 1 } })).status, "skipped");
  await assert.rejects(() => runtime.lifecycle.clearOwnerMemory(owner), /lifecycle is unavailable/);
  await assert.rejects(() => runtime.lifecycle.supersedeConversationSources({ owner, conversationId: "c1", retainedThroughOrdinal: 0 }), /lifecycle is unavailable/);
  await assert.rejects(() => createProvenAbsentMemoryLifecycle().clearOwnerMemory(owner), /proven absent/);
});
