import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve(
  "src/app/panel-ui/src/workbench/async-request-state.ts",
)).href;

test("async request state distinguishes initial loading from snapshot refresh", () => {
  const result = runStripTypes(`
    import {
      createIdleAsyncRequestState,
      failAsyncRequest,
      resolveAsyncRequest,
      settleAsyncRequest,
      startAsyncRequest,
    } from ${JSON.stringify(moduleUrl)};
    const idle = createIdleAsyncRequestState();
    const loading = startAsyncRequest(idle);
    const ready = resolveAsyncRequest(["workspace-1"]);
    const refreshing = startAsyncRequest(ready);
    const failed = failAsyncRequest(refreshing, "offline");
    console.log(JSON.stringify({ idle, loading, ready, refreshing, failed, settled: settleAsyncRequest(loading) }));
  `);
  assert.deepEqual(result, {
    idle: { status: "idle" },
    loading: { status: "loading" },
    ready: { status: "ready", data: ["workspace-1"] },
    refreshing: { status: "refreshing", data: ["workspace-1"] },
    failed: { status: "error", data: ["workspace-1"], error: "offline" },
    settled: { status: "idle" },
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
