import assert from "node:assert/strict";
import test from "node:test";

import { createOrdinaryExecutionCoordinator } from "../dist/app/ordinary-agent/feature/execution-coordinator.js";

test("rejected execution and cancellation cleanup tasks do not leak unhandled rejections", async () => {
  const coordinator = createOrdinaryExecutionCoordinator();
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const executionFailure = Promise.reject(new Error("execution failed"));
    const cleanupFailure = Promise.reject(new Error("cleanup failed"));
    coordinator.startExecutionTask("run-execution", executionFailure);
    coordinator.startCancellationCleanup("run-cancellation", undefined, () => cleanupFailure);
    await Promise.allSettled([executionFailure, cleanupFailure]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(coordinator.hasExecution("run-execution"), false);
    assert.equal(coordinator.hasCancellationCleanup("run-cancellation"), false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("approval decision lease atomically reserves, restores, and finishes continuation state", () => {
  const coordinator = createOrdinaryExecutionCoordinator();
  const continuation = { decide: async () => undefined, release: async () => undefined };
  assert.equal(coordinator.registerApprovalContinuation("run-1", continuation), true);

  const acquired = coordinator.beginApprovalDecision("run-1", "confirmation-1");
  assert.equal(acquired.status, "acquired");
  assert.equal(coordinator.beginApprovalDecision("run-1", "confirmation-1").status, "busy");
  coordinator.rollbackApprovalDecision(acquired.lease);

  const retried = coordinator.beginApprovalDecision("run-1", "confirmation-1");
  assert.equal(retried.status, "acquired");
  coordinator.finishApprovalDecision(retried.lease, false);
  assert.equal(coordinator.beginApprovalDecision("run-1", "confirmation-1").status, "continuation_missing");
});

test("beginExecution rejects a duplicate active run", () => {
  const coordinator = createOrdinaryExecutionCoordinator();
  const first = coordinator.beginExecution("run-1");
  assert.throws(
    () => coordinator.beginExecution("run-1"),
    /already has an active execution/u,
  );
  coordinator.removeController("run-1", first);
  assert.notEqual(coordinator.beginExecution("run-1"), first);
});

test("cancellation cleanup is separate from unsettled tool work in scheduling facts", async () => {
  const coordinator = createOrdinaryExecutionCoordinator();
  let resolveCleanup;
  const cleanup = new Promise((resolve) => { resolveCleanup = resolve; });
  coordinator.startCancellationCleanup("run-1", undefined, () => cleanup);

  assert.deepEqual(coordinator.schedulingFacts("run-1"), {
    unsettledToolWork: false,
    cancellationCleanupPending: true,
    executionActive: false,
  });
  resolveCleanup();
  await cleanup;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.hasCancellationCleanup("run-1"), false);
});
