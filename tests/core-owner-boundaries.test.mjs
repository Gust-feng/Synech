import assert from "node:assert/strict";
import test from "node:test";

import { createSpaceFeature } from "../dist/app/spaces/index.js";
import { createWorkspaceFeature } from "../dist/app/workspaces/index.js";

test("Workspace owns mount identity and reconnect keeps workspace identity", async () => {
  let snapshot = { schemaVersion: "workspaces/v1", workspaces: [], mounts: [] };
  const feature = createWorkspaceFeature({
    repository: {
      async read() { return structuredClone(snapshot); },
      async write(value) { snapshot = structuredClone(value); },
    },
    idFactory: () => "workspace-1",
    mountVersionFactory: (() => { let n = 0; return () => `mount-${++n}`; })(),
  });
  const first = await feature.commands.ensureWorkspace({ rootPath: "C:/project", sourceIdentity: "source-1", visibility: "listed" });
  const moved = await feature.commands.reconnectWorkspace({ workspaceId: first.workspace.id, rootPath: "D:/project", sourceIdentity: "source-1" });
  assert.equal(moved.workspace.id, first.workspace.id);
  assert.equal(moved.mount.mountVersion, "mount-2");
  assert.equal((await feature.queries.get(first.workspace.id)).currentMount.mountVersion, "mount-2");
});

test("Space owns membership independently from Workspace identity", async () => {
  let snapshot = { schemaVersion: "space-tree/v1", spaces: [], referenceItems: [] };
  const feature = createSpaceFeature({
    repository: {
      async read() { return structuredClone(snapshot); },
      async write(value) { snapshot = structuredClone(value); },
    },
    idFactory: (() => { let n = 0; return () => `id-${++n}`; })(),
  });
  await feature.commands.createSpace({ id: "space-1", title: "Project" });
  const item = await feature.commands.addReference({ spaceId: "space-1", title: "Project", reference: { kind: "workspace", workspaceId: "workspace-1" }, actor: { kind: "user" } });
  assert.equal(item.spaceId, "space-1");
  assert.deepEqual(item.reference, { kind: "workspace", workspaceId: "workspace-1" });
  await feature.commands.unlinkReference(item.id);
  assert.equal(await feature.queries.getReference(item.id), undefined);
});
