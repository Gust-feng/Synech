import test from "node:test";
import assert from "node:assert/strict";

import { createWorkbenchCoordination } from "../dist/app/workbench-coordination/index.js";

test("deleteSpace uses the internal Knowledge detach workflow without re-entering the public queue", async () => {
  const detached = [];
  let deleteCalls = 0;
  let spaceExists = true;
  let failDeleteOnce = false;
  const coordination = createWorkbenchCoordination({
    spaces: {
      commands: { async addReference() {}, async unlinkReference() {} },
      queries: {
        async getTree() { return spaceExists ? { space: { id: "space-1" }, entries: [] } : undefined; },
        async getReference() { return undefined; },
        async listReferencesByWorkspace() { return []; },
      },
    },
    workspaces: {
      commands: {
        async ensureWorkspace() { throw new Error("not used"); },
        async reconnectWorkspace() { throw new Error("not used"); },
        async setVisibility() { throw new Error("not used"); },
        async discardImplicitWorkspace() { throw new Error("not used"); },
      },
    },
    async inspectDirectory() { return undefined; },
    async withSpaceAdmission(_spaceId, operation) { return await operation(); },
    async listWorkspaceConversationIds() { return []; },
    async withWorkspaceAdmission(_workspaceId, operation) { return await operation(); },
    async withWorkspacePathLease(_workspaceId, operation) { return await operation(); },
    async withWorkspaceMountTransitionLease(_workspaceId, _rootPath, operation) { return await operation(); },
    async deleteWorkspace() {},
    async deleteSpace(spaceId, detachKnowledgeFromSpace) {
      deleteCalls += 1;
      await detachKnowledgeFromSpace({ spaceId, referenceIds: ["reference-1"] });
      if (failDeleteOnce) {
        failDeleteOnce = false;
        throw new Error("space delete unavailable");
      }
    },
    async detachKnowledgeFromSpace(input) {
      detached.push(input);
    },
  });

  await Promise.race([
    coordination.commands.deleteSpace("space-1"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("deleteSpace re-entered its public queue")), 250)),
  ]);

  assert.equal(deleteCalls, 1);
  assert.deepEqual(detached, [{ spaceId: "space-1", referenceIds: ["reference-1"] }]);
  spaceExists = false;
  await assert.rejects(
    coordination.commands.detachKnowledgeFromSpace({ spaceId: "space-1", referenceIds: [] }),
    (error) => error?.code === "coordination_space_not_found",
  );
  spaceExists = true;
  failDeleteOnce = true;
  await assert.rejects(coordination.commands.deleteSpace("space-1"), /space delete unavailable/u);
  await coordination.commands.deleteSpace("space-1");
  assert.equal(deleteCalls, 3);
});

test("Knowledge detach has a serialized retry boundary and remains idempotent", async () => {
  let attempts = 0;
  const coordination = createWorkbenchCoordination({
    spaces: {
      commands: { async addReference() {}, async unlinkReference() {} },
      queries: {
        async getTree() { return { space: { id: "space-1" }, entries: [] }; },
        async getReference() { return undefined; },
        async listReferencesByWorkspace() { return []; },
      },
    },
    workspaces: {
      commands: {
        async ensureWorkspace() { throw new Error("not used"); },
        async reconnectWorkspace() { throw new Error("not used"); },
        async setVisibility() { throw new Error("not used"); },
        async discardImplicitWorkspace() { throw new Error("not used"); },
      },
    },
    async inspectDirectory() { return undefined; },
    async withSpaceAdmission(_spaceId, operation) { return await operation(); },
    async listWorkspaceConversationIds() { return []; },
    async withWorkspaceAdmission(_workspaceId, operation) { return await operation(); },
    async withWorkspacePathLease(_workspaceId, operation) { return await operation(); },
    async withWorkspaceMountTransitionLease(_workspaceId, _rootPath, operation) { return await operation(); },
    async deleteWorkspace() {},
    async deleteSpace() {},
    async detachKnowledgeFromSpace() {
      attempts += 1;
      if (attempts === 1) throw new Error("knowledge unavailable");
    },
  });

  await assert.rejects(
    coordination.commands.detachKnowledgeFromSpace({ spaceId: "space-1", referenceIds: ["reference-1"] }),
    /knowledge unavailable/u,
  );
  await coordination.commands.detachKnowledgeFromSpace({ spaceId: "space-1", referenceIds: ["reference-1"] });
  await coordination.commands.detachKnowledgeFromSpace({ spaceId: "space-1", referenceIds: ["reference-1"] });
  assert.equal(attempts, 3);
});

test("independent Space and Knowledge commands remain on one coordination lane", async () => {
  let releaseAttachment;
  const attachmentGate = new Promise((resolve) => { releaseAttachment = resolve; });
  let attachmentStarted = false;
  let detachStarted = false;
  const coordination = createWorkbenchCoordination({
    spaces: {
      commands: {
        async addReference() {
          attachmentStarted = true;
          await attachmentGate;
          return { id: "reference-1", spaceId: "space-1", title: "Workspace", reference: { kind: "workspace", workspaceId: "workspace-1" } };
        },
        async unlinkReference() {},
      },
      queries: {
        async getTree() { return { space: { id: "space-1" }, entries: [] }; },
        async getReference() { return undefined; },
        async listReferencesByWorkspace() { return []; },
      },
    },
    workspaces: {
      commands: {
        async ensureWorkspace() {
          return {
            created: false,
            workspace: { id: "workspace-1", title: "Workspace", status: "available", visibility: "implicit" },
            mount: { rootPath: "C:/projects/root", sourceIdentity: "source-1", mountVersion: "mount-1" },
          };
        },
        async reconnectWorkspace() { throw new Error("not used"); },
        async setVisibility() { throw new Error("not used"); },
        async discardImplicitWorkspace() { throw new Error("not used"); },
      },
    },
    async inspectDirectory() { return { kind: "folder", identity: "source-1" }; },
    async withSpaceAdmission(_spaceId, operation) { return await operation(); },
    async listWorkspaceConversationIds() { return []; },
    async withWorkspaceAdmission(_workspaceId, operation) { return await operation(); },
    async withWorkspacePathLease(_workspaceId, operation) { return await operation(); },
    async withWorkspaceMountTransitionLease(_workspaceId, _rootPath, operation) { return await operation(); },
    async deleteWorkspace() {},
    async deleteSpace() {},
    async detachKnowledgeFromSpace() { detachStarted = true; },
  });

  const attach = coordination.commands.attachWorkspaceToSpace({
    spaceId: "space-1",
    rootPath: "C:/projects/root",
    actor: { kind: "user" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attachmentStarted, true);
  const detach = coordination.commands.detachKnowledgeFromSpace({ spaceId: "space-1", referenceIds: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detachStarted, false);
  releaseAttachment();
  await Promise.all([attach, detach]);
  assert.equal(detachStarted, true);
});
