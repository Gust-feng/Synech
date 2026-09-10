import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpaceConversationDeletionCoordinator,
  createWorkspaceDeletionCoordinator,
} from "../dist/app/workbench-coordination/index.js";

function inMemorySpaceDeletionJournal() {
  const records = new Map();
  return {
    async list() { return [...records.values()]; },
    async getBySpace(spaceId) {
      return [...records.values()].find((record) => record.spaceId === spaceId);
    },
    async save(record) { records.set(record.deletionId, structuredClone(record)); },
    async delete(deletionId) { records.delete(deletionId); },
  };
}

function indexOf(events, event) {
  const index = events.indexOf(event);
  assert.ok(index >= 0, `${event} was not observed`);
  return index;
}

test("Space deletion fences implicit memory before Conversation removal and purges after owner deletion", async () => {
  const events = [];
  const coordinator = createSpaceConversationDeletionCoordinator({
    spaces: {
      commands: { async deleteSpace() { events.push("space.delete"); } },
      queries: { async getTree() { return { entries: [] }; } },
    },
    ordinary: {
      commands: { async deleteConversation() { events.push("ordinary.delete"); } },
      queries: { async listConversationsByOwner() { return [{ conversationId: "conversation-1" }]; } },
    },
    personalKnowledge: { commands: { async cleanupSpace() { events.push("knowledge.cleanup"); } } },
    agentNotes: { async deleteByOwner() { events.push("agent-notes.delete"); } },
    collaborationRules: { async deleteByOwner() { events.push("rules.delete"); } },
    memory: { async deleteByOwner() { events.push("path-dependencies.delete"); } },
    memoryLifecycle: {
      async prepareOwnerRemoval() {
        events.push("memory.prepare");
        return {
          ticketId: "space-ticket",
          scope: { kind: "owner", owner: { kind: "space", id: "space-1" } },
          fencedGeneration: 1,
          preparedAt: "2026-09-02T00:00:00.000Z",
        };
      },
      async finalizeOwnerRemoval() { events.push("memory.finalize"); },
    },
    processes: { async cleanupBySpace() { events.push("processes.stop"); return { attempted: [], skipped: [] }; } },
    processTerminator: {},
    journal: inMemorySpaceDeletionJournal(),
    now: () => "2026-09-02T00:00:00.000Z",
  });

  await coordinator.deleteSpace("space-1");

  assert.ok(indexOf(events, "memory.prepare") < indexOf(events, "ordinary.delete"));
  assert.ok(indexOf(events, "memory.finalize") > indexOf(events, "space.delete"));
});

test("Workspace deletion fences implicit memory before Conversation removal and purges after Workspace removal", async () => {
  const events = [];
  const workspace = { id: "workspace-1", status: "available" };
  const coordinator = createWorkspaceDeletionCoordinator({
    workspaces: {
      commands: {
        async deleteWorkspace() { events.push("workspace.delete"); },
        async purgeWorkspace() { events.push("workspace.purge"); },
      },
      queries: {
        async get() { return workspace; },
        async listAll() { return [workspace]; },
      },
    },
    spaces: {
      commands: { async unlinkReference() { events.push("reference.unlink"); } },
      queries: {
        async listReferencesByWorkspace() { return []; },
        async getReference() { return undefined; },
      },
    },
    spaceAdmission: { async admit(_spaceId, operation) { return await operation(); } },
    ordinary: {
      commands: { async deleteConversation() { events.push("ordinary.delete"); } },
      queries: { async listConversationsByOwner() { return [{ conversationId: "conversation-1" }]; } },
    },
    agentNotes: { async deleteByOwner() { events.push("agent-notes.delete"); } },
    collaborationRules: { async deleteByOwner() { events.push("rules.delete"); } },
    memory: { async deleteByOwner() { events.push("path-dependencies.delete"); } },
    memoryLifecycle: {
      async prepareOwnerRemoval() {
        events.push("memory.prepare");
        return {
          ticketId: "workspace-ticket",
          scope: { kind: "owner", owner: { kind: "workspace", id: "workspace-1" } },
          fencedGeneration: 1,
          preparedAt: "2026-09-02T00:00:00.000Z",
        };
      },
      async finalizeOwnerRemoval() { events.push("memory.finalize"); },
    },
    processes: { async cleanupByConversation() { events.push("processes.stop"); return { attempted: [], skipped: [] }; } },
    processTerminator: {},
  });

  await coordinator.deleteWorkspace("workspace-1");

  assert.ok(indexOf(events, "workspace.delete") < indexOf(events, "memory.prepare"));
  assert.ok(indexOf(events, "memory.prepare") < indexOf(events, "ordinary.delete"));
  assert.ok(indexOf(events, "memory.finalize") > indexOf(events, "workspace.purge"));
});
