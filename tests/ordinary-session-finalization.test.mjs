import assert from "node:assert/strict";
import test from "node:test";

import { createOrdinaryAgentLoopExecutionPort } from "../dist/app/ordinary-agent/agent-loop-execution.js";
import { nextEligibleQueuedRun } from "../dist/app/ordinary-agent/conversation-scheduler.js";
import { createTerminalSettlement } from "../dist/app/ordinary-agent/terminal-settlement.js";

test("Session finalization retries its first target and clears the queue barrier", async () => {
  const revokedTargets = [];
  let releaseSessionAttempts = 0;
  const execution = createOrdinaryAgentLoopExecutionPort({
    resources: {
      async acquire() {
        return {
          loop: {
            async execute() {
              return {
                status: "completed",
                finalText: "done",
                session: sessionRefs("entry-completed"),
                toolResults: [],
                usage: {},
              };
            },
          },
          resolvedMessages: [],
          tools: {},
          async revokeSessionTo(target) {
            revokedTargets.push(structuredClone(target));
          },
          async releaseSession() {
            releaseSessionAttempts += 1;
            if (releaseSessionAttempts <= 2) throw new Error("release failed");
          },
          async release() {},
        };
      },
    },
  });
  await execution.execute(executionInput("run-1"));

  let document = terminalDocument("run-1", "entry-t1");
  const diagnostics = [];
  const settlement = createTerminalSettlement({
    finalizeSession: execution.finalizeSession,
    loadRun: async () => document,
    cachedRun: () => document,
    persistToolResult: async () => undefined,
    reconcilePendingToolRound: async () => undefined,
    reconcileLostApprovalResults: async () => undefined,
    externalSettlementCleared: () => true,
    isHiddenRun: () => false,
    hasActivitySubscribers: () => false,
    releaseActivityStream: () => undefined,
    emitDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onStable: () => undefined,
  });
  settlement.markSessionAwaitingFinalization("run-1");

  await assert.rejects(
    settlement.finalizeSession("run-1", document.state, true),
    /release failed/u,
  );
  assert.equal(settlement.isFinalizationPending("run-1"), true);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(revokedTargets, [entryRef("entry-t1")]);

  document = terminalDocument("run-1", "entry-t2");
  const queued = queuedRun("run-2");
  assert.equal(nextEligibleQueuedRun(
    [document.state, queued],
    (runId) => schedulingFacts(settlement.isFinalizationPending(runId)),
  ), undefined);

  await settlement.retryFinalization("run-1");

  assert.deepEqual(revokedTargets, [entryRef("entry-t1")]);
  assert.equal(releaseSessionAttempts, 3);
  assert.equal(settlement.isFinalizationPending("run-1"), false);
  assert.equal(settlement.finalizationFailure("run-1"), undefined);
  assert.equal(nextEligibleQueuedRun(
    [document.state, queued],
    (runId) => schedulingFacts(settlement.isFinalizationPending(runId)),
  ), queued);
});

test("Session finalization reports no_session without parsing an error message", async () => {
  const execution = createOrdinaryAgentLoopExecutionPort({
    resources: { async acquire() { throw new Error("not used"); } },
  });

  assert.deepEqual(await execution.finalizeSession("missing-run", null), { status: "no_session" });

  const document = terminalDocument("missing-run", "unused-entry");
  const diagnostics = [];
  const settlement = createTerminalSettlement({
    finalizeSession: execution.finalizeSession,
    loadRun: async () => document,
    cachedRun: () => document,
    persistToolResult: async () => undefined,
    reconcilePendingToolRound: async () => undefined,
    reconcileLostApprovalResults: async () => undefined,
    externalSettlementCleared: () => true,
    isHiddenRun: () => false,
    hasActivitySubscribers: () => false,
    releaseActivityStream: () => undefined,
    emitDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onStable: () => undefined,
  });
  settlement.markSessionAwaitingFinalization("missing-run");
  await settlement.finalizeSession("missing-run", document.state, true);

  assert.equal(settlement.isFinalizationPending("missing-run"), false);
  assert.equal(settlement.finalizationFailure("missing-run"), undefined);
  assert.deepEqual(diagnostics, []);
});

function executionInput(runId) {
  return {
    runId,
    conversationId: "conversation-1",
    sessionRef: { sessionId: "session-1" },
    birth: {},
    runInput: { userMessage: "test" },
    abortSignal: new AbortController().signal,
    onModelContent: () => undefined,
    acceptToolInvocations: () => [],
    acceptNestedToolInvocations: () => [],
    onToolRequested: () => undefined,
    onNestedToolRequestsAccepted: async () => undefined,
    onToolProgress: () => undefined,
    onSessionWriteCheckpoint: async () => undefined,
    onToolResult: async () => undefined,
  };
}

function terminalDocument(runId, endEntryId) {
  return {
    revision: 1,
    state: {
      runId,
      status: { kind: "failed", error: { code: "failed", message: "failed" } },
      session: {
        phase: "rollbackable",
        startLeafRef: null,
        endLeafRef: entryRef(endEntryId),
        compactionEntryRefs: [],
      },
      turn: { conversationId: "conversation-1", ordinal: 1 },
      input: { userMessage: "test" },
      birth: { capabilitySnapshot: { executionRoot: "." }, workspaceSelection: "default" },
      timeline: [],
      toolCalls: [],
      timestamps: { createdAt: "2026-08-26T00:00:00.000Z", terminalAt: "2026-08-26T00:00:01.000Z" },
    },
  };
}

function queuedRun(runId) {
  return {
    runId,
    status: { kind: "queued" },
    turn: { conversationId: "conversation-1", ordinal: 2 },
  };
}

function schedulingFacts(sessionFinalizationPending) {
  return {
    unsettledToolWork: false,
    sessionFinalizationPending,
    executionActive: false,
  };
}

function sessionRefs(endEntryId) {
  return {
    startLeafRef: null,
    endLeafRef: entryRef(endEntryId),
    compactionEntryRefs: [],
  };
}

function entryRef(entryId) {
  return { sessionId: "session-1", entryId };
}
