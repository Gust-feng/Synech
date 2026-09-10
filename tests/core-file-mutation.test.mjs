import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalWriteFileTool } from "../dist/app/tool-center/adapters/local-workspace-write-tools.js";
import { InMemoryLocalWorkspaceMutationCoordinator } from "../dist/app/tool-center/adapters/local-workspace-mutation-coordinator.js";

test("file mutation rechecks authorization after acquiring the shared lease", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-core-mutation-"));
  try {
    const filePath = path.join(directory, "note.txt");
    await fs.writeFile(filePath, "before", "utf8");
    const coordinator = new InMemoryLocalWorkspaceMutationCoordinator();
    let authorized = true;
    const tool = createLocalWriteFileTool(directory, {
      mutationCoordinator: coordinator,
      pathAuthorization: {
        async resolve() {
          if (!authorized) throw new Error("reference revoked");
          return { absolutePath: filePath, relativePath: "note.txt", rootDirectory: directory, resourceId: "reference-1", resourceScope: { ownerKind: "space", ownerId: "space-1" } };
        },
      },
    });
    let release;
    const blocker = coordinator.run(filePath, async () => await new Promise((resolve) => { release = resolve; }));
    const pending = tool.execute({ path: filePath, content: "after" }, {});
    await new Promise((resolve) => setImmediate(resolve));
    authorized = false;
    release();
    await assert.rejects(pending, /reference revoked/u);
    await blocker;
    assert.equal(await fs.readFile(filePath, "utf8"), "before");
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
