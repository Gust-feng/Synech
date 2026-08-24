import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDefaultSpaceInitializer,
  ensureDefaultSpace,
} from "../dist/app/panel-server/storage/default-space-initializer.js";

test("default Space initializer creates the Space and managed directory once", async () => {
  await withTemporaryDirectory(async (managedSpaceRoot) => {
    const spaces = [];
    let createCount = 0;
    const spaceFeature = {
      queries: {
        async list() {
          return spaces;
        },
      },
      commands: {
        async createSpace(input) {
          createCount += 1;
          spaces.push({ ...input });
          return input;
        },
      },
    };

    await ensureDefaultSpace({ spaceFeature, managedSpaceRoot });
    await fs.rm(path.join(managedSpaceRoot, "space-default"), { recursive: true, force: true });
    await ensureDefaultSpace({ spaceFeature, managedSpaceRoot });

    assert.deepEqual(spaces, [{ id: "space-default", title: "我的空间" }]);
    assert.equal(createCount, 1);
    assert.equal((await fs.stat(path.join(managedSpaceRoot, "space-default", "files"))).isDirectory(), true);
  });
});

test("default Space initializer shares concurrent work and retries a failed attempt", async () => {
  let attempts = 0;
  let releaseFirstAttempt;
  const firstAttempt = new Promise((resolve) => {
    releaseFirstAttempt = resolve;
  });
  const initializer = createDefaultSpaceInitializer(async () => {
    attempts += 1;
    if (attempts === 1) {
      await firstAttempt;
      throw new Error("initialization failed");
    }
  });

  const first = initializer.ensure();
  const concurrent = initializer.ensure();
  assert.equal(first, concurrent);
  releaseFirstAttempt();
  await assert.rejects(first, /initialization failed/u);

  await initializer.ensure();
  await initializer.ensure();
  assert.equal(attempts, 2);
});

test("default Space initializer does not recreate a deleted default when another Space exists", async () => {
  await withTemporaryDirectory(async (managedSpaceRoot) => {
    let createCount = 0;
    const spaceFeature = {
      queries: { async list() { return [{ id: "space-personal", title: "个人空间" }]; } },
      commands: { async createSpace(input) { createCount += 1; return input; } },
    };

    await ensureDefaultSpace({ spaceFeature, managedSpaceRoot });

    assert.equal(createCount, 0);
    await assert.rejects(fs.stat(path.join(managedSpaceRoot, "space-default")), { code: "ENOENT" });
  });
});

async function withTemporaryDirectory(operation) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-default-space-test-"));
  try {
    await operation(temporaryDirectory);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
