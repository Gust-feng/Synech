import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isSchedulingBarrierCleared,
  nextEligibleQueuedRun,
  orderedConversationRuns,
} from "../dist/app/ordinary-agent/conversation-scheduler.js";
import {
  conversationCleanupJobIsIdle,
  createConversationCleanupJob,
  prepareConversationCleanup,
  recordConversationCleanupSuccess,
} from "../dist/app/ordinary-agent/conversation-cleanup.js";
import { createInitialOrdinaryRunState, transitionOrdinaryRun } from "../dist/app/ordinary-agent/state.js";

test("conversation scheduling selects the first queued run only after earlier work settles", () => {
  const completed = run("run-1", "completed", 1);
  const queued = run("run-2", "queued", 2);
  const clear = schedulingFacts();

  assert.equal(isSchedulingBarrierCleared(completed, clear), true);
  assert.equal(nextEligibleQueuedRun([completed, queued], () => clear), queued);

  const unsettled = schedulingFacts({ unsettledToolWork: true });
  assert.equal(isSchedulingBarrierCleared(completed, unsettled), false);
  assert.equal(nextEligibleQueuedRun([completed, queued], () => unsettled), undefined);
});

test("cancelled runs release the queue after accepted tool work settles", () => {
  const cancelled = run("run-1", "cancelled", 1);
  const queued = run("run-2", "queued", 2);

  assert.equal(nextEligibleQueuedRun(
    [cancelled, queued],
    () => schedulingFacts({ executionActive: true }),
  ), queued);
  assert.equal(nextEligibleQueuedRun(
    [cancelled, queued],
    () => schedulingFacts({ unsettledToolWork: true, executionActive: true }),
  ), undefined);
});

test("fallback scheduling order is conversation-local and ordinal", () => {
  const runs = [
    run("other", "queued", 1, "conversation-2"),
    run("second", "queued", 2),
    run("first", "completed", 1),
  ];

  assert.deepEqual(
    orderedConversationRuns("conversation-1", runs).map((item) => item.runId),
    ["first", "second"],
  );
});

test("queued successor selection does not mutate its durable queued fact", () => {
  const completed = run("run-1", "completed", 1);
  const queued = run("run-2", "queued", 2);
  const selected = nextEligibleQueuedRun([completed, queued], () => schedulingFacts());

  assert.equal(selected, queued);
  assert.deepEqual(queued.status, { kind: "queued" });
});

test("conversation cleanup remains pending until an explicit successful attempt", () => {
  const job = createConversationCleanupJob();
  const first = prepareConversationCleanup(
    job,
    conversationControl(1),
    ["run-1", "run-1"],
    "delete_uncommitted",
  );
  const latest = prepareConversationCleanup(
    job,
    conversationControl(2),
    ["run-2"],
    "delete_uncommitted",
  );

  assert.equal(latest.control.revision, 2);
  assert.deepEqual(latest.runIds, ["run-1", "run-2"]);
  recordConversationCleanupSuccess(job, first);
  assert.equal(job.pendingUncommitted, latest);
  recordConversationCleanupSuccess(job, latest);
  assert.equal(job.pendingUncommitted, undefined);
  assert.equal(conversationCleanupJobIsIdle(job), true);
});

test("completion fallback records one honest blocked terminal fact", () => {
  const initial = createInitialOrdinaryRunState({
    runId: "run-1",
    sessionRef: { sessionId: "session-1" },
    turn: {
      conversationId: "conversation-1",
      ordinal: 1,
      userTurnId: "user-1",
      assistantTurnId: "assistant-1",
    },
    runInput: { userMessage: "Do the work" },
    birth: birth(),
    recordedAt: "2026-08-24T00:00:00.000Z",
    eventId: "event-created",
  });
  const running = transitionOrdinaryRun({
    state: initial,
    transition: { type: "start" },
    recordedAt: "2026-08-24T00:00:01.000Z",
    eventId: "event-started",
  });
  const blocked = transitionOrdinaryRun({
    state: running,
    transition: {
      type: "block",
      reason: {
        code: "ordinary_completion_commit_failed",
        message: "模型执行已完成，但 Ordinary 终态无法写入。请发送新消息继续；系统不会将这次完成改写为失败。",
      },
      continueBy: "new_turn",
      toolCalls: [],
    },
    recordedAt: "2026-08-24T00:00:02.000Z",
    eventId: "event-blocked",
  });

  assert.deepEqual(blocked.status, {
    kind: "blocked",
    reason: {
      code: "ordinary_completion_commit_failed",
      message: "模型执行已完成，但 Ordinary 终态无法写入。请发送新消息继续；系统不会将这次完成改写为失败。",
    },
    continueBy: "new_turn",
  });
  assert.equal(blocked.timeline.at(-1).type, "run.blocked");
});

test("Ordinary background retry timers are absent while visible checkpoint debounce remains", async () => {
  const sources = await Promise.all([
    readFile(new URL("../src/app/ordinary-agent/ordinary-agent-feature.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/ordinary-agent/run-activity-hub.ts", import.meta.url), "utf8"),
  ]);
  const source = sources.join("\n");
  for (const retiredName of [
    "completionCommitRetryTimers",
    "completionCommitRetryCounts",
    "successorActivationRetryDelayMs",
    "cancellationCleanupRetryTimers",
    "cancellationCleanupFailureCounts",
    "conversationCleanupRetryTimers",
    "cleanupRetryDelayMs",
  ]) {
    assert.equal(source.includes(retiredName), false, retiredName);
  }
  assert.equal((source.match(/setTimeout\(/gu) ?? []).length, 1);
  assert.match(source, /visibleAssistantCheckpointTimers/u);
});

function run(runId, statusKind, ordinal, conversationId = "conversation-1") {
  return {
    runId,
    status: { kind: statusKind },
    turn: { conversationId, ordinal },
    pendingToolRound: undefined,
    pendingNestedToolCalls: undefined,
  };
}

function schedulingFacts(overrides = {}) {
  return {
    unsettledToolWork: false,
    sessionFinalizationPending: false,
    executionActive: false,
    ...overrides,
  };
}

function conversationControl(revision) {
  return {
    revision,
    state: {
      conversationId: "conversation-1",
      sessionRef: { sessionId: "session-1" },
    },
  };
}

function birth() {
  return {
    instructions: "Do the work",
    aiMode: "openai-compatible",
    config: {
      profileId: "default",
      providerKind: "openai_compatible",
      protocolKind: "openai_compatible_chat_completions",
      baseUrl: "https://example.test/v1",
      model: "model",
      defaultAiMode: "openai-compatible",
      secretRef: "secret://model",
      secretConfigured: true,
      updatedAt: "2026-08-24T00:00:00.000Z",
    },
    agentDefinitionRef: { id: "ordinary" },
    capabilitySnapshot: { executionRoot: "Z:/Workspace" },
    memoryOwner: { kind: "workspace", id: "workspace-1" },
    informationAccess: {},
    toolConfirmationPolicy: {},
  };
}
