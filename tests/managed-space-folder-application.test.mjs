import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createManagedSpaceFolderApplication } from "../dist/app/application/managed-space-folder-application.js";
import { createSpaceCreateManagedFolderTool } from "../dist/app/spaces/space-tools.js";

test("managed-folder Route delegates allocation and membership to one application command", async () => {
  const source = await fs.readFile("src/app/panel-server/spaces/space-routes.ts", "utf8");
  assert.match(source, /managedSpaceFolderApplication\.create/u);
  assert.doesNotMatch(source, /createManagedSpaceFolder|deleteManagedSpaceFolder/u);
});

test("managed-folder application creates the folder and adds one Space membership", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synech-managed-space-"));
  try {
    const events = [];
    const application = createManagedSpaceFolderApplication({
      async addReference(input) {
        events.push({ kind: "add", input });
        return { id: "reference-1", spaceId: input.spaceId, reference: input.reference };
      },
      spaceConversationDeletion: {
        assertAvailable(id) { events.push({ kind: "available", id }); },
        async admit(id, operation) { events.push({ kind: "admit", id }); return operation(); },
      },
      fileMutationCoordinator: {
        async run(key, operation) {
          events.push({ kind: "lock", key });
          return operation();
        },
      },
      managedSpaceFolderRoot: root,
    });

    const item = await application.create({ spaceId: "space-1", title: "Managed", actor: { kind: "user" } });
    assert.equal(item.id, "reference-1");
    assert.deepEqual(events.slice(0, 3), [
      { kind: "available", id: "space-1" },
      { kind: "admit", id: "space-1" },
      { kind: "lock", key: root },
    ]);
    assert.equal(events[3].input.reference.kind, "managed_folder");
    assert.equal(await fs.stat(events[3].input.reference.path).then(() => true), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("managed-folder application compensates physical state when Space write fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synech-managed-space-"));
  try {
    const application = createManagedSpaceFolderApplication({
      async addReference() { throw new Error("space write failed"); },
      spaceConversationDeletion: {
        assertAvailable() {},
        async admit(_id, operation) { return operation(); },
      },
      fileMutationCoordinator: { async run(_key, operation) { return operation(); } },
      managedSpaceFolderRoot: root,
    });

    await assert.rejects(
      application.create({ spaceId: "space-1", title: "Managed", actor: { kind: "user" } }),
      /space write failed/u,
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Agent managed-folder tool delegates to the same application command and preserves actor", async () => {
  const calls = [];
  const tool = createSpaceCreateManagedFolderTool({
    spaces: { commands: {}, queries: {} },
    workspaceRoot: "C:\\workspace",
    managedSpaceFolderApplication: {
      async create(input) {
        calls.push(input);
        return {
          id: "reference-1",
          spaceId: input.spaceId,
          title: input.title,
          reference: { kind: "managed_folder", path: "C:\\managed\\folder" },
        };
      },
    },
  });

  const result = await tool.execute(
    { spaceId: "space-1", title: "Managed" },
    { callerAgentId: "agent-1", traceId: "trace-1", goalId: "goal-1", providerCallId: "provider-1" },
  );
  assert.equal(result.status, "created");
  assert.deepEqual(calls, [{
    spaceId: "space-1",
    title: "Managed",
    actor: { kind: "agent", actorId: "agent-1", traceId: "trace-1", goalId: "goal-1", toolCallId: "provider-1" },
  }]);
});
