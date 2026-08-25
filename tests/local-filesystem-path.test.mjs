import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalFilesystemPathError,
  resolveDestinationWithinRoot,
} from "../dist/app/local-filesystem/index.js";

test("destination resolution exposes stable root and path error codes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synech-path-error-"));
  try {
    assert.equal(
      await resolveDestinationWithinRoot(root, "new-file.txt"),
      path.join(await realpath(root), "new-file.txt"),
    );
    await assert.rejects(
      resolveDestinationWithinRoot(path.join(root, "missing-root"), "file.txt"),
      (error) => error instanceof LocalFilesystemPathError && error.code === "root_missing",
    );
    await assert.rejects(
      resolveDestinationWithinRoot(root, "missing-parent/file.txt"),
      (error) => error instanceof LocalFilesystemPathError && error.code === "path_escape",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
