import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve(
  "src/app/panel-ui/src/workbench/search-state.ts",
)).href;

test("search state preserves the previous result while updating and failing", () => {
  const result = runStripTypes(`
    import {
      beginRemoteSearch,
      completeRemoteSearch,
      failRemoteSearch,
    } from ${JSON.stringify(moduleUrl)};
    const ready = completeRemoteSearch(["old"]);
    const loading = beginRemoteSearch(ready);
    const failed = failRemoteSearch(loading, "offline");
    console.log(JSON.stringify({ ready, loading, failed }));
  `);
  assert.deepEqual(result, {
    ready: { status: "ready", results: ["old"] },
    loading: { status: "loading", previous: ["old"] },
    failed: { status: "error", message: "offline", previous: ["old"] },
  });
});

function runStripTypes(source) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}