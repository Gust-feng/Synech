import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSpaceFeature, SPACE_TREE_SCHEMA_VERSION } from "../dist/app/spaces/index.js";
import { createWorkspaceFeature, WORKSPACE_SCHEMA_VERSION } from "../dist/app/workspaces/index.js";
import { createWorkbenchCoordination } from "../dist/app/workbench-coordination/index.js";
import { resolveConversationSpaceAccess } from "../dist/app/panel-server/spaces/space-agent-access.js";
import { resolveSpaceFilesystemReference } from "../dist/app/panel-server/spaces/space-workspace-reference.js";

test("an implicit Workspace is reused and promoted without changing its identity", async (t) => {
  const feature = createWorkspaceFeature({
    repository: memoryWorkspaceRepository(),
    idFactory: () => "workspace-1",
    mountVersionFactory: increasingId("mount"),
    now: increasingClock(),
  });
  t.after(async () => await feature.release());
  await feature.ready();

  const implicit = await feature.commands.ensureWorkspace({
    rootPath: "C:/projects/synech",
    sourceIdentity: "volume:file-index",
    visibility: "implicit",
  });
  assert.equal(implicit.created, true);
  assert.equal(implicit.workspace.visibility, "implicit");
  assert.deepEqual(await feature.queries.list(), []);

  const listed = await feature.commands.ensureWorkspace({
    rootPath: "C:/projects/synech",
    sourceIdentity: "volume:file-index",
    visibility: "listed",
  });
  assert.equal(listed.created, false);
  assert.equal(listed.workspace.id, implicit.workspace.id);
  assert.equal(listed.workspace.visibility, "listed");
  assert.equal((await feature.queries.list()).length, 1);
});

test("Workspace disconnection preserves every Space-owned relationship", async (t) => {
  const workspaces = createWorkspaceFeature({
    repository: memoryWorkspaceRepository(),
    idFactory: () => "workspace-1",
    mountVersionFactory: increasingId("mount"),
    now: increasingClock(),
  });
  const spaces = createSpaceFeature({ repository: memorySpaceRepository(), idFactory: increasingId("space"), now: increasingClock() });
  t.after(async () => { await spaces.release(); await workspaces.release(); });
  await Promise.all([workspaces.ready(), spaces.ready()]);

  const workspace = await workspaces.commands.ensureWorkspace({ rootPath: "C:/projects/synech", sourceIdentity: "identity-1", visibility: "implicit" });
  const space = await spaces.commands.createSpace({ id: "space-1", title: "Architecture" });
  const reference = await spaces.commands.addReference({
    id: "reference-1",
    spaceId: space.id,
    title: "Synech",
    reference: { kind: "workspace", workspaceId: workspace.workspace.id },
    actor: { kind: "user" },
  });

  await workspaces.commands.invalidateMount({
    workspaceId: workspace.workspace.id,
    expectedMountVersion: workspace.mount.mountVersion,
  });
  assert.equal((await workspaces.queries.get(workspace.workspace.id))?.status, "disconnected");
  assert.equal((await spaces.queries.getReference(reference.id))?.reference.kind, "workspace");
  assert.deepEqual((await spaces.queries.listReferencesByWorkspace(workspace.workspace.id)).map((item) => item.id), [reference.id]);
});

test("a stale mount invalidation cannot disconnect a reconnected Workspace", async (t) => {
  const feature = createWorkspaceFeature({
    repository: memoryWorkspaceRepository(),
    idFactory: () => "workspace-1",
    mountVersionFactory: increasingId("mount"),
    now: increasingClock(),
  });
  t.after(async () => await feature.release());
  await feature.ready();

  const registered = await feature.commands.ensureWorkspace({
    rootPath: "C:/projects/synech",
    sourceIdentity: "identity-1",
    visibility: "listed",
  });
  await feature.commands.invalidateMount({
    workspaceId: registered.workspace.id,
    expectedMountVersion: registered.mount.mountVersion,
  });
  const reconnected = await feature.commands.reconnectWorkspace({
    workspaceId: registered.workspace.id,
    rootPath: registered.mount.rootPath,
    sourceIdentity: registered.mount.sourceIdentity,
  });

  await feature.commands.invalidateMount({
    workspaceId: registered.workspace.id,
    expectedMountVersion: registered.mount.mountVersion,
  });
  const afterStaleInvalidation = await feature.queries.get(registered.workspace.id);
  assert.equal(afterStaleInvalidation?.status, "available");
  assert.equal(afterStaleInvalidation?.currentMount?.mountVersion, reconnected.mount.mountVersion);

  await feature.commands.invalidateMount({
    workspaceId: registered.workspace.id,
    expectedMountVersion: reconnected.mount.mountVersion,
  });
  assert.equal((await feature.queries.get(registered.workspace.id))?.status, "disconnected");
});

test("default mount versions remain unique when reconnect happens in the same clock tick", async (t) => {
  const feature = createWorkspaceFeature({
    repository: memoryWorkspaceRepository(),
    idFactory: () => "workspace-1",
    now: () => "2026-08-26T00:00:00.000Z",
  });
  t.after(async () => await feature.release());
  await feature.ready();

  const registered = await feature.commands.ensureWorkspace({
    rootPath: "C:/projects/synech",
    sourceIdentity: "identity-1",
    visibility: "listed",
  });
  await feature.commands.invalidateMount({
    workspaceId: registered.workspace.id,
    expectedMountVersion: registered.mount.mountVersion,
  });
  const reconnected = await feature.commands.reconnectWorkspace({
    workspaceId: registered.workspace.id,
    rootPath: registered.mount.rootPath,
    sourceIdentity: registered.mount.sourceIdentity,
  });

  assert.notEqual(reconnected.mount.mountVersion, registered.mount.mountVersion);
  await feature.commands.invalidateMount({
    workspaceId: registered.workspace.id,
    expectedMountVersion: registered.mount.mountVersion,
  });
  assert.equal((await feature.queries.get(registered.workspace.id))?.status, "available");
});

test("Workspace reconnect reuses the same nesting policy as first registration", async (t) => {
  const feature = createWorkspaceFeature({
    repository: memoryWorkspaceRepository(),
    idFactory: increasingId("workspace"),
    mountVersionFactory: increasingId("mount"),
    now: increasingClock(),
  });
  t.after(async () => await feature.release());
  await feature.ready();
  const parent = await feature.commands.ensureWorkspace({ rootPath: "C:/projects/root", sourceIdentity: "root-id", visibility: "listed" });
  await feature.commands.invalidateMount({
    workspaceId: parent.workspace.id,
    expectedMountVersion: parent.mount.mountVersion,
  });
  await feature.commands.ensureWorkspace({ rootPath: "C:/projects/root/sub", sourceIdentity: "child-id", visibility: "listed" });

  await assert.rejects(
    () => feature.commands.reconnectWorkspace({ workspaceId: parent.workspace.id, rootPath: "C:/projects/root", sourceIdentity: "root-id" }),
    (error) => error?.code === "workspace_nested_path",
  );
});

test("failed Workspace attachment compensates a newly-created implicit registration", async (t) => {
  const workspaces = createWorkspaceFeature({
    repository: memoryWorkspaceRepository(),
    idFactory: () => "workspace-compensated",
    mountVersionFactory: () => "mount-1",
    now: increasingClock(),
  });
  t.after(async () => await workspaces.release());
  await workspaces.ready();
  let admissionHeld = false;
  const originalDiscard = workspaces.commands.discardImplicitWorkspace;
  workspaces.commands.discardImplicitWorkspace = async (workspaceId) => {
    assert.equal(admissionHeld, true);
    await originalDiscard(workspaceId);
  };
  const coordination = createWorkbenchCoordination({
    spaces: {
      commands: {
        async addReference() { throw new Error("space write failed"); },
        async unlinkReference() {},
      },
      queries: {
        async getTree() { return { space: { id: "space-1" }, entries: [] }; },
        async getReference() { return undefined; },
        async listReferencesByWorkspace() { return []; },
      },
    },
    workspaces: { commands: workspaces.commands },
    async inspectDirectory() { return { kind: "folder", identity: "folder-id" }; },
    async withSpaceAdmission(_spaceId, operation) { return await operation(); },
    async listWorkspaceConversationIds() { return []; },
    async withWorkspaceAdmission(_workspaceId, operation) {
      admissionHeld = true;
      try { return await operation(); } finally { admissionHeld = false; }
    },
    async withWorkspacePathLease(_workspaceId, operation) { return await operation(); },
    async withWorkspaceMountTransitionLease(_workspaceId, _rootPath, operation) { return await operation(); },
    async deleteWorkspace() {},
    async deleteSpace() {},
    async detachKnowledgeFromSpace() {},
  });

  await assert.rejects(
    () => coordination.commands.attachWorkspaceToSpace({ spaceId: "space-1", rootPath: "C:/projects/root", actor: { kind: "user" } }),
    /space write failed/u,
  );
  assert.deepEqual(await workspaces.queries.listAll(), []);
});

test("Workspace attachment and detachment are idempotent application commands", async (t) => {
  const workspaces = createWorkspaceFeature({
    repository: memoryWorkspaceRepository(),
    idFactory: () => "workspace-1",
    mountVersionFactory: () => "mount-1",
    now: increasingClock(),
  });
  const spaces = createSpaceFeature({ repository: memorySpaceRepository(), idFactory: increasingId("reference"), now: increasingClock() });
  t.after(async () => { await spaces.release(); await workspaces.release(); });
  await Promise.all([spaces.ready(), workspaces.ready()]);
  await spaces.commands.createSpace({ id: "space-1", title: "Space" });
  let leaseHeld = false;
  const coordination = createWorkbenchCoordination({
    spaces,
    workspaces: { commands: workspaces.commands },
    async inspectDirectory() { return { kind: "folder", identity: "folder-id" }; },
    async withSpaceAdmission(_spaceId, operation) { return await operation(); },
    async listWorkspaceConversationIds() { return []; },
    async withWorkspaceAdmission(_workspaceId, operation) { return await operation(); },
    async withWorkspacePathLease(_workspaceId, operation) {
      leaseHeld = true;
      try { return await operation(); } finally { leaseHeld = false; }
    },
    async withWorkspaceMountTransitionLease(_workspaceId, _rootPath, operation) { return await operation(); },
    async deleteWorkspace() {},
    async deleteSpace() {},
    async detachKnowledgeFromSpace() {},
  });

  const first = await coordination.commands.attachWorkspaceToSpace({ spaceId: "space-1", rootPath: "C:/projects/root", actor: { kind: "user" } });
  const retry = await coordination.commands.attachWorkspaceToSpace({ spaceId: "space-1", rootPath: "C:/projects/root", actor: { kind: "user" } });
  assert.equal(retry.item.id, first.item.id);
  assert.equal((await spaces.queries.listReferencesByWorkspace(first.workspace.id)).length, 1);

  const originalUnlink = spaces.commands.unlinkReference;
  spaces.commands.unlinkReference = async (referenceId) => {
    assert.equal(leaseHeld, true);
    await originalUnlink(referenceId);
  };
  await coordination.commands.detachWorkspaceFromSpace(first.item.id);
  await coordination.commands.detachWorkspaceFromSpace(first.item.id);
  assert.equal((await spaces.queries.listReferencesByWorkspace(first.workspace.id)).length, 0);
});

test("local-file resolution rejects a different filesystem object at the same path", async () => {
  await withTemporaryDirectory(async (directory) => {
    const file = path.join(directory, "reference.txt");
    await fs.writeFile(file, "first", "utf8");
    const first = await fs.stat(file, { bigint: true });
    await fs.rename(file, path.join(directory, "original.txt"));
    await fs.writeFile(file, "replacement", "utf8");
    const item = {
      id: "reference-1",
      spaceId: "space-1",
      title: "reference.txt",
      reference: { kind: "local_file", path: file },
      sourceIdentity: `${first.dev}:${first.ino}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await assert.rejects(
      () => resolveSpaceFilesystemReference({ workspaceFeature: unavailableWorkspaceFeature() }, item),
      (error) => error?.code === "space_reference_source_replaced",
    );
  });
});

test("Workspace repository failures are not silently projected as missing Space context", async () => {
  const spaces = {
    queries: {
      async getTree() {
        return {
          space: { id: "space-1" },
          entries: [{ item: { id: "reference-1", spaceId: "space-1", title: "Workspace", reference: { kind: "workspace", workspaceId: "workspace-1" } } }],
        };
      },
    },
  };
  const failure = new Error("workspace repository unavailable");
  await assert.rejects(
    () => resolveConversationSpaceAccess(
      spaces,
      { commands: { async invalidateMount() {} }, queries: { async get() { throw failure; } } },
      async () => ({ kind: "space", id: "space-1" }),
      "conversation-1",
      undefined,
    ),
    failure,
  );
});

test("moving a Workspace requires the explicit reconnect command and releases the historical path", async (t) => {
  const feature = createWorkspaceFeature({
    repository: memoryWorkspaceRepository(),
    idFactory: increasingId("workspace"),
    mountVersionFactory: increasingId("mount"),
    now: increasingClock(),
  });
  t.after(async () => await feature.release());
  await feature.ready();

  const original = await feature.commands.ensureWorkspace({
    rootPath: "C:/projects/original",
    sourceIdentity: "identity-1",
    visibility: "listed",
  });
  await assert.rejects(
    () => feature.commands.ensureWorkspace({
      rootPath: "D:/projects/moved",
      sourceIdentity: "identity-1",
      visibility: "listed",
    }),
    (error) => error?.code === "workspace_mount_invalid",
  );
  const moved = await feature.commands.reconnectWorkspace({
    workspaceId: original.workspace.id,
    rootPath: "D:/projects/moved",
    sourceIdentity: "identity-1",
  });
  assert.equal(moved.workspace.id, original.workspace.id);
  const detail = await feature.queries.get(original.workspace.id);
  assert.equal(detail.mounts.filter((mount) => mount.status === "active").length, 1);
  assert.equal(detail.mounts.find((mount) => mount.status === "active")?.rootPath.toLowerCase(), "d:\\projects\\moved");
  assert.equal(detail.mounts.find((mount) => mount.rootPath.toLowerCase() === "c:\\projects\\original")?.status, "invalidated");

  const replacement = await feature.commands.ensureWorkspace({
    rootPath: "C:/projects/original",
    sourceIdentity: "identity-2",
    visibility: "listed",
  });
  assert.notEqual(replacement.workspace.id, original.workspace.id);
});

test("same-path reconnect is idempotent and hiding preserves identity", async (t) => {
  const feature = createWorkspaceFeature({
    repository: memoryWorkspaceRepository(),
    idFactory: increasingId("workspace"),
    mountVersionFactory: increasingId("mount"),
    now: increasingClock(),
  });
  t.after(async () => await feature.release());
  await feature.ready();

  const registered = await feature.commands.ensureWorkspace({ rootPath: "C:/projects/synech", sourceIdentity: "identity-1", visibility: "listed" });
  const reconnected = await feature.commands.reconnectWorkspace({ workspaceId: registered.workspace.id, rootPath: "C:/projects/synech", sourceIdentity: "identity-1" });
  assert.equal(reconnected.mount.mountVersion, registered.mount.mountVersion);
  assert.equal((await feature.queries.get(registered.workspace.id)).mounts.length, 1);

  await feature.commands.setVisibility(registered.workspace.id, "implicit");
  assert.deepEqual(await feature.queries.list(), []);
  const restored = await feature.commands.ensureWorkspace({ rootPath: "C:/projects/synech", sourceIdentity: "identity-1", visibility: "listed" });
  assert.equal(restored.workspace.id, registered.workspace.id);
  assert.equal(restored.workspace.visibility, "listed");
});

function memoryWorkspaceRepository() {
  let snapshot = { schemaVersion: WORKSPACE_SCHEMA_VERSION, workspaces: [], mounts: [] };
  return { async read() { return structuredClone(snapshot); }, async write(next) { snapshot = structuredClone(next); } };
}

function memorySpaceRepository() {
  let snapshot = { schemaVersion: SPACE_TREE_SCHEMA_VERSION, spaces: [], referenceItems: [] };
  return { async read() { return structuredClone(snapshot); }, async write(next) { snapshot = structuredClone(next); } };
}

function increasingId(prefix) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function increasingClock() {
  let seconds = 0;
  return () => `2026-01-01T00:00:${String(seconds++).padStart(2, "0")}.000Z`;
}

function unavailableWorkspaceFeature() {
  return { commands: { async invalidateMount() {} }, queries: { async get() { return undefined; } } };
}

async function withTemporaryDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-workspace-baseline-"));
  try { await operation(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
