import assert from "node:assert/strict";
import test from "node:test";

import { resolveProductHome, resolveProductPaths } from "../dist/platform/storage/index.js";
import { isWithinRoot, normalizeRelativePath } from "../dist/app/local-filesystem/index.js";

test("Product Home has one canonical root and stable owned paths", () => {
  assert.equal(resolveProductHome({ productHome: "C:/data/synech" }), "C:\\data\\synech");
  assert.equal(resolveProductHome({ env: { SYNECH_HOME: "C:/configured" } }), "C:\\configured");
  const paths = resolveProductPaths({ productHome: "C:/data/synech" });
  assert.equal(paths.data.database, "C:\\data\\synech\\data\\synech.sqlite3");
  assert.equal(paths.state.journals, "C:\\data\\synech\\state\\journals");
  assert.equal(paths.cache.commandLogs, "C:\\data\\synech\\cache\\command-logs");
});

test("filesystem boundaries reject traversal and prefix lookalikes", () => {
  assert.equal(isWithinRoot("C:/work", "C:/work/file.txt"), true);
  assert.equal(isWithinRoot("C:/work", "C:/workspace/file.txt"), false);
  assert.throws(() => normalizeRelativePath("../escape.txt"));
});
