import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpaceConversationDeletionCoordinator,
  createWorkspaceDeletionCoordinator,
} from "../dist/app/workbench-coordination/index.js";

test("Workspace deletion is successful when retried after purge", async () => {
  let workspace = { id: "workspace-1", status: "available" };
  let purgeCount = 0;
  const coordinator = createWorkspaceDeletionCoordinator({
    workspaces: {
      commands: {
        async deleteWorkspace() { workspace = { ...workspace, status: "deleting" }; },
        async purgeWorkspace() { workspace = undefined; purgeCount += 1; },
      },
      queries: {
        async get() { return workspace; },
        async listAll() { return workspace === undefined ? [] : [workspace]; },
      },
    },
    spaces: {
      commands: { async unlinkReference() {} },
      queries: { async listReferencesByWorkspace() { return []; }, async getReference() { return undefined; } },
    },
    spaceAdmission: { async admit(_spaceId, operation) { return await operation(); } },
    ordinary: {
      commands: { async deleteConversation() {} },
      queries: { async listConversationsByOwner() { return []; } },
    },
    agentNotes: { async deleteByOwner() {} },
    memory: { async deleteByOwner() {} },
    processes: { async cleanupByConversation() { return emptyCleanup(); } },
    processTerminator: { async killTree() { return { status: "exited" }; } },
    async runExclusive(operation) { return await operation(); },
    async runWorkspaceExclusive(_workspaceId, operation) { return await operation(); },
  });

  await coordinator.deleteWorkspace("workspace-1");
  await coordinator.deleteWorkspace("workspace-1");
  assert.equal(purgeCount, 1);
  assert.equal(workspace, undefined);
});

test("Workspace deletion retries a failed cascade without admitting a new owner", async () => {
  let workspace = { id: "workspace-1", status: "available" };
  let reference = { id: "reference-1", spaceId: "space-1", reference: { kind: "workspace", workspaceId: "workspace-1" } };
  let failUnlink = true;
  const coordinator = createWorkspaceDeletionCoordinator({
    workspaces: {
      commands: {
        async deleteWorkspace() { workspace = { ...workspace, status: "deleting" }; },
        async purgeWorkspace() { workspace = undefined; },
      },
      queries: {
        async get() { return workspace; },
        async listAll() { return workspace === undefined ? [] : [workspace]; },
      },
    },
    spaces: {
      commands: {
        async unlinkReference() {
          if (failUnlink) throw new Error("space write failed");
          reference = undefined;
        },
      },
      queries: {
        async listReferencesByWorkspace() { return reference === undefined ? [] : [reference]; },
        async getReference() { return reference; },
      },
    },
    spaceAdmission: { async admit(_spaceId, operation) { return await operation(); } },
    ordinary: {
      commands: { async deleteConversation() {} },
      queries: { async listConversationsByOwner() { return []; } },
    },
    agentNotes: { async deleteByOwner() {} },
    memory: { async deleteByOwner() {} },
    processes: { async cleanupByConversation() { return emptyCleanup(); } },
    processTerminator: { async killTree() { return { status: "exited" }; } },
    async runExclusive(operation) { return await operation(); },
    async runWorkspaceExclusive(_workspaceId, operation) { return await operation(); },
  });

  await assert.rejects(coordinator.deleteWorkspace("workspace-1"), /space write failed/u);
  assert.equal(coordinator.isDeleting("workspace-1"), true);
  failUnlink = false;
  await coordinator.deleteWorkspace("workspace-1");
  assert.equal(workspace, undefined);
  assert.equal(reference, undefined);
});

test("Workspace deletion rejects a reference that changes Space membership while admission waits", async () => {
  let workspace = { id: "workspace-1", status: "available" };
  let reference = { id: "reference-1", spaceId: "space-1", reference: { kind: "workspace", workspaceId: "workspace-1" } };
  let purged = false;
  let unlinked = false;
  const coordinator = createWorkspaceDeletionCoordinator({
    workspaces: {
      commands: {
        async deleteWorkspace() { workspace = { ...workspace, status: "deleting" }; },
        async purgeWorkspace() { purged = true; workspace = undefined; },
      },
      queries: {
        async get() { return workspace; },
        async listAll() { return workspace === undefined ? [] : [workspace]; },
      },
    },
    spaces: {
      commands: { async unlinkReference() { unlinked = true; } },
      queries: {
        async listReferencesByWorkspace() { return [reference]; },
        async getReference() { return reference; },
      },
    },
    spaceAdmission: {
      async admit(_spaceId, operation) {
        reference = { ...reference, spaceId: "space-2" };
        return await operation();
      },
    },
    ordinary: {
      commands: { async deleteConversation() {} },
      queries: { async listConversationsByOwner() { return []; } },
    },
    agentNotes: { async deleteByOwner() {} },
    memory: { async deleteByOwner() {} },
    processes: { async cleanupByConversation() { return emptyCleanup(); } },
    processTerminator: { async killTree() { return { status: "exited" }; } },
    async runExclusive(operation) { return await operation(); },
    async runWorkspaceExclusive(_workspaceId, operation) { return await operation(); },
  });

  await assert.rejects(
    coordinator.deleteWorkspace("workspace-1"),
    (error) => error?.code === "workspace_reference_membership_changed",
  );
  assert.equal(coordinator.isDeleting("workspace-1"), true);
  assert.equal(unlinked, false);
  assert.equal(purged, false);
});

test("Space deletion is successful when retried after journal cleanup", async () => {
  let tree = {
    space: { id: "space-1" },
    entries: [],
  };
  let deleteCount = 0;
  const records = new Map();
  const coordinator = createSpaceConversationDeletionCoordinator({
    spaces: {
      commands: { async deleteSpace() { tree = undefined; deleteCount += 1; } },
      queries: { async getTree() { return tree; } },
    },
    ordinary: {
      commands: { async deleteConversation() {} },
      queries: { async listConversationsByOwner() { return []; } },
    },
    personalKnowledge: { commands: { async cleanupSpace() {} } },
    agentNotes: { async deleteByOwner() {} },
    memory: { async deleteByOwner() {} },
    processes: { async cleanupBySpace() { return emptyCleanup(); } },
    processTerminator: { async killTree() { return { status: "exited" }; } },
    journal: {
      async list() { return [...records.values()]; },
      async getBySpace(spaceId) { return [...records.values()].find((record) => record.spaceId === spaceId); },
      async save(record) { records.set(record.deletionId, structuredClone(record)); },
      async delete(deletionId) { records.delete(deletionId); },
    },
    async runExclusive(operation) { return await operation(); },
  });

  await coordinator.deleteSpace("space-1");
  await coordinator.deleteSpace("space-1");
  assert.equal(deleteCount, 1);
  assert.equal(tree, undefined);
  assert.equal(records.size, 0);
});

test("Space deletion resumes its durable checkpoint after Knowledge cleanup fails", async () => {
  let tree = { space: { id: "space-1" }, entries: [] };
  let failKnowledge = true;
  const records = new Map();
  const coordinator = createSpaceConversationDeletionCoordinator({
    spaces: {
      commands: { async deleteSpace() { tree = undefined; } },
      queries: { async getTree() { return tree; } },
    },
    ordinary: {
      commands: { async deleteConversation() {} },
      queries: { async listConversationsByOwner() { return []; } },
    },
    personalKnowledge: {
      commands: {
        async cleanupSpace() {
          if (failKnowledge) throw new Error("knowledge unavailable");
        },
      },
    },
    agentNotes: { async deleteByOwner() {} },
    memory: { async deleteByOwner() {} },
    processes: { async cleanupBySpace() { return emptyCleanup(); } },
    processTerminator: { async killTree() { return { status: "exited" }; } },
    journal: memoryJournal(records),
    async runExclusive(operation) { return await operation(); },
  });

  await assert.rejects(coordinator.deleteSpace("space-1"), /knowledge unavailable/u);
  assert.equal(coordinator.isDeleting("space-1"), true);
  assert.equal(records.size, 1);
  failKnowledge = false;
  await coordinator.deleteSpace("space-1");
  assert.equal(tree, undefined);
  assert.equal(records.size, 0);
});

function emptyCleanup() {
  return { attempted: [], skipped: [] };
}

function memoryJournal(records) {
  return {
    async list() { return [...records.values()]; },
    async getBySpace(spaceId) { return [...records.values()].find((record) => record.spaceId === spaceId); },
    async save(record) { records.set(record.deletionId, structuredClone(record)); },
    async delete(deletionId) { records.delete(deletionId); },
  };
}
