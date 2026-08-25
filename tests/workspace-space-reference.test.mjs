import assert from "node:assert/strict";
import test from "node:test";

import { createSpaceFeature, SPACE_TREE_SCHEMA_VERSION } from "../dist/app/spaces/index.js";
import { createWorkspaceFeature, WORKSPACE_SCHEMA_VERSION } from "../dist/app/workspaces/index.js";

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

  await workspaces.commands.invalidateMount(workspace.workspace.id);
  assert.equal((await workspaces.queries.get(workspace.workspace.id))?.status, "disconnected");
  assert.equal((await spaces.queries.getReference(reference.id))?.reference.kind, "workspace");
  assert.deepEqual((await spaces.queries.listReferencesByWorkspace(workspace.workspace.id)).map((item) => item.id), [reference.id]);
});

test("moving a Workspace replaces the active mount and releases the historical path", async (t) => {
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
  const moved = await feature.commands.ensureWorkspace({
    rootPath: "D:/projects/moved",
    sourceIdentity: "identity-1",
    visibility: "listed",
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
