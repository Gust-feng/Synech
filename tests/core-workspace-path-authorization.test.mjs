import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultCommandShellConfig } from "../dist/app/tool-center/adapters/local-workspace-command-tools.js";
import { createLocalReadFileTool } from "../dist/app/tool-center/adapters/local-workspace-read-tools.js";
import { createLocalShellCommandTool } from "../dist/app/tool-center/adapters/local-workspace-command-tools.js";
import { InMemoryLocalWorkspaceMutationCoordinator } from "../dist/app/tool-center/adapters/local-workspace-mutation-coordinator.js";

test("read rechecks Workspace authorization after waiting for the shared path lease", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-core-read-auth-"));
  try {
    const filePath = path.join(directory, "note.txt");
    await fs.writeFile(filePath, "content", "utf8");
    const coordinator = new InMemoryLocalWorkspaceMutationCoordinator();
    let authorized = true;
    const tool = createLocalReadFileTool(directory, {
      mutationCoordinator: coordinator,
      pathAuthorization: {
        async resolve() {
          if (!authorized) throw new Error("reference revoked");
          return {
            absolutePath: filePath,
            relativePath: "note.txt",
            rootDirectory: directory,
            resourceId: "reference-1",
            resourceScope: { ownerKind: "space", ownerId: "space-1" },
          };
        },
      },
    });
    let release;
    const blocker = coordinator.runExclusive(filePath, async () => await new Promise((resolve) => { release = resolve; }));
    const pending = tool.execute({ path: filePath }, {});
    await new Promise((resolve) => setImmediate(resolve));
    authorized = false;
    release();
    await assert.rejects(pending, /reference revoked/u);
    await blocker;
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("Workspace-scoped background Shell is rejected before process start", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-core-shell-auth-"));
  try {
    let spawned = false;
    const tool = createLocalShellCommandTool(directory, {
      commandShell: createDefaultCommandShellConfig(),
      pathAuthorization: {
        async resolve() {
          return {
            absolutePath: directory,
            relativePath: ".",
            rootDirectory: directory,
            resourceId: "reference-1",
            resourceScope: { ownerKind: "space", ownerId: "space-1" },
          };
        },
      },
      processRegistry: {
        register() {
          spawned = true;
        },
      },
    });
    await assert.rejects(
      tool.execute({ command: "echo blocked", background: true }, {}),
      (error) => error?.code === "workspace_background_authorization_unsupported",
    );
    assert.equal(spawned, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
