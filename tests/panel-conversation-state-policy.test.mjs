import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve(
  "src/app/panel-ui/src/workbench/conversation-state-policy.ts",
)).href;

test("conversation state policy prioritizes user attention over activity", () => {
  const result = runStripTypes(`
    import { projectConversationState } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify([
      projectConversationState({ pending: false, running: false, failed: false, hasVisibleContent: false }),
      projectConversationState({ pending: false, running: false, failed: false, hasVisibleContent: true }),
      projectConversationState({ pending: false, running: true, failed: false, hasVisibleContent: true }),
      projectConversationState({ pending: true, running: true, failed: true, hasVisibleContent: true }),
      projectConversationState({ pending: false, running: false, failed: true, hasVisibleContent: true }),
    ]));
  `);
  assert.deepEqual(result, ["initial", "completed", "working", "attention", "failed"]);
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