import assert from "node:assert/strict";
import test from "node:test";

import { isTerminalStatus } from "../dist/app/ordinary-agent/run-lifecycle-policy.js";

test("Ordinary terminal policy distinguishes completed, failed, cancelled and blocked", () => {
  for (const kind of ["completed", "failed", "cancelled", "blocked"]) {
    assert.equal(isTerminalStatus({ kind }), true);
  }
  for (const kind of ["queued", "running", "awaiting_approval"]) {
    assert.equal(isTerminalStatus({ kind }), false);
  }
});
