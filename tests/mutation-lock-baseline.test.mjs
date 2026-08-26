import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { serializeContextReference } from "../dist/domain/ordinary/index.js";
import { createLocalWriteFileTool } from "../dist/app/tool-center/adapters/local-workspace-write-tools.js";
import { InMemoryLocalWorkspaceMutationCoordinator } from "../dist/app/tool-center/adapters/local-workspace-mutation-coordinator.js";
import {
  createSpaceRunPathAuthorization,
  spaceReferenceAttachmentId,
  spaceReferenceWritePermission,
  spaceScopePermission,
} from "../dist/app/spaces/index.js";
import {
  createSpaceReferenceUnlinkService,
  createWorkbenchCoordination,
} from "../dist/app/workbench-coordination/index.js";

test("Write repeats authorization after acquiring the shared path lease", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = path.join(directory, "note.txt");
    await fs.writeFile(filePath, "original", "utf8");
    let authorized = true;
    const tool = createLocalWriteFileTool(directory, {
      pathAuthorization: {
        async resolve() {
          if (!authorized) throw new Error("reference revoked");
          return {
            absolutePath: filePath,
            relativePath: "note.txt",
            rootDirectory: directory,
            resourceScope: { ownerKind: "space", ownerId: "space-1" },
            resourceId: "reference-1",
          };
        },
      },
      mutationCoordinator: {
        events: { subscribe() { return () => {}; } },
        async run(_key, operation) {
          authorized = false;
          return await operation();
        },
        async runExclusive(_key, operation) { return await operation(); },
      },
    });

    await assert.rejects(
      tool.execute({ path: filePath, content: "changed" }, {}),
      /reference revoked/u,
    );
    assert.equal(await fs.readFile(filePath, "utf8"), "original");
  });
});

test("a frozen Workspace grant rejects a new mountVersion at lock time", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = path.join(directory, "late.txt");
    let mountVersion = "mount-1";
    const authorization = createSpaceRunPathAuthorization({
      runContext: {
        contextRefs: [{
          attachmentId: spaceReferenceAttachmentId("reference-1"),
          ref: serializeContextReference({ scheme: "local_project", path: directory }),
          kind: "project",
          sourceIdentity: "source-1",
          mountVersion: "mount-1",
        }],
        permissionBoundaryRefs: [
          spaceScopePermission("space-1"),
          spaceReferenceWritePermission("reference-1"),
        ],
      },
      workspaceRoot: directory,
      externalSourceInspector: async () => ({ kind: "folder", identity: "source-1" }),
      resolveCurrentSource: async () => ({
        path: directory,
        sourceIdentity: "source-1",
        mountVersion,
      }),
    });
    const tool = createLocalWriteFileTool(directory, {
      pathAuthorization: authorization,
      mutationCoordinator: {
        events: { subscribe() { return () => {}; } },
        async run(_key, operation) {
          mountVersion = "mount-2";
          return await operation();
        },
        async runExclusive(_key, operation) { return await operation(); },
      },
    });

    await assert.rejects(
      tool.execute({ path: filePath, content: "must not be written" }, {}),
      /changed source identity/u,
    );
    await assert.rejects(fs.stat(filePath), (error) => error?.code === "ENOENT");
  });
});

test("local-file unlink waits for the same lease as an active write", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = path.join(directory, "source.txt");
    await fs.writeFile(filePath, "source", "utf8");
    const coordinator = new InMemoryLocalWorkspaceMutationCoordinator();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const blocker = coordinator.run(filePath, async () => await held);
    let unlinked = 0;
    const item = localFileReference("reference-1", filePath);
    const service = createSpaceReferenceUnlinkService({
      spaces: {
        queries: { async getReference() { return unlinked === 0 ? item : undefined; } },
        commands: { async unlinkReference() { unlinked += 1; } },
      },
      coordination: { commands: { async detachWorkspaceFromSpace() {} } },
      mutations: coordinator,
      async withSpaceAdmission(_spaceId, operation) { return await operation(); },
    });

    const pendingUnlink = service.unlink(item.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unlinked, 0);
    release();
    await Promise.all([blocker, pendingUnlink]);
    assert.equal(unlinked, 1);
  });
});

test("Workspace reconnect waits for writes under the previous mount", async () => {
  await withTemporaryDirectory(async (directory) => {
    const oldRoot = path.join(directory, "old");
    const nextRoot = path.join(directory, "next");
    await Promise.all([fs.mkdir(oldRoot), fs.mkdir(nextRoot)]);
    const coordinator = new InMemoryLocalWorkspaceMutationCoordinator();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const blocker = coordinator.run(path.join(oldRoot, "active.txt"), async () => await held);
    let reconnects = 0;
    const coordination = createWorkbenchCoordination({
      spaces: {
        commands: { async addReference() { throw new Error("unused"); }, async unlinkReference() {} },
        queries: {
          async getTree() { return undefined; },
          async getReference() { return undefined; },
          async listReferencesByWorkspace() { return []; },
        },
      },
      workspaces: {
        commands: {
          async reconnectWorkspace(input) {
            reconnects += 1;
            return {
              workspace: { id: input.workspaceId },
              mount: { rootPath: input.rootPath, sourceIdentity: input.sourceIdentity },
            };
          },
          async ensureWorkspace() { throw new Error("unused"); },
          async setVisibility() { throw new Error("unused"); },
          async discardImplicitWorkspace() {},
        },
      },
      async inspectDirectory() { return { kind: "folder", identity: "source-1" }; },
      async withSpaceAdmission(_spaceId, operation) { return await operation(); },
      async listWorkspaceConversationIds() { return []; },
      async withWorkspaceAdmission(_workspaceId, operation) { return await operation(); },
      async withWorkspacePathLease(_workspaceId, operation) { return await operation(); },
      async withWorkspaceMountTransitionLease(_workspaceId, candidateRoot, operation) {
        return await coordinator.runExclusive(oldRoot, async () =>
          await coordinator.runExclusive(candidateRoot, operation));
      },
      async deleteWorkspace() {},
      async deleteSpace() {},
      async detachKnowledgeFromSpace() {},
    });

    const pendingReconnect = coordination.commands.reconnectWorkspace({
      workspaceId: "workspace-1",
      rootPath: nextRoot,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconnects, 0);
    release();
    await Promise.all([blocker, pendingReconnect]);
    assert.equal(reconnects, 1);
  });
});

function localFileReference(id, filePath) {
  return {
    id,
    spaceId: "space-1",
    title: "Source",
    reference: { kind: "local_file", path: filePath },
    sourceIdentity: "source-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function withTemporaryDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-mutation-lock-"));
  try {
    await operation(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}
