import assert from "node:assert/strict";
import test from "node:test";

import { createSpaceReferenceRuntimeGuard } from "../dist/app/panel-server/composition/space-reference-runtime-guard.js";

test("Space reference runtime guard revokes access, flushes cleanup, and releases subscriptions", async () => {
  const spaces = eventSource();
  const revoked = [];
  let finishCleanup;
  const guard = createSpaceReferenceRuntimeGuard({
    spaces: { events: spaces.events },
    processes: {
      async revokeByReference(referenceId) {
        revoked.push(referenceId);
        await new Promise((resolve) => { finishCleanup = resolve; });
        return { attempted: [], skipped: [] };
      },
    },
    processTerminator: { async killTree() { return { status: "exited" }; } },
  });

  spaces.emit({
    type: "space.reference_removed",
    itemId: "reference-1",
    removedItemIds: ["reference-1"],
  });
  assert.equal(guard.revocationOverlay.has("reference-1"), true);
  assert.deepEqual(revoked, ["reference-1"]);

  const flushing = guard.flush();
  finishCleanup();
  await flushing;
  guard.release();
  assert.equal(spaces.listenerCount(), 0);
});

function eventSource() {
  const listeners = new Set();
  return {
    events: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(event) { for (const listener of [...listeners]) listener(event); },
    listenerCount() { return listeners.size; },
  };
}
