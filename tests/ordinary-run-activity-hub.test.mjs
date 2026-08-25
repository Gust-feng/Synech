import assert from "node:assert/strict";
import test from "node:test";

import { createOrdinaryRunActivityHub } from "../dist/app/ordinary-agent/run-activity-hub.js";

test("activity hub aggregates deltas and replaces live output with the durable transition", async () => {
  const reasoningFacts = [];
  const fixture = createFixture({
    recordReasoning: async (input) => { reasoningFacts.push(input); },
  });

  fixture.hub.recordModelRequest(RUN_ID, "initial");
  fixture.hub.recordReasoningDelta(RUN_ID, 0, "first ");
  fixture.hub.recordReasoningDelta(RUN_ID, 0, "second");
  await fixture.hub.completeReasoning(RUN_ID, 0);
  assert.equal(reasoningFacts.length, 1);
  assert.deepEqual(reasoningFacts[0], {
    runId: RUN_ID,
    modelRequestId: reasoningFacts[0].modelRequestId,
    contentIndex: 0,
    content: "first second",
  });
  assert.match(reasoningFacts[0].modelRequestId, /^ordinary-activity-/u);

  fixture.hub.recordOutputDelta(RUN_ID, 0, "Hello, ");
  fixture.hub.recordOutputDelta(RUN_ID, 0, "world.");
  assert.equal(fixture.hub.visibleAssistantText(RUN_ID), "Hello, world.");

  fixture.hub.recordTransition({
    eventId: "event-output-completed",
    runId: RUN_ID,
    recordedAt: "2026-08-25T00:00:01.000Z",
    type: "model.output.completed",
    modelRequestId: reasoningFacts[0].modelRequestId,
    assistantEntryRef: { sessionId: "session-1", entryId: "assistant-1" },
  }, "Hello, complete world.");

  const stream = await fixture.hub.replayStream(fixture.document);
  assert.equal(stream.activities.some((activity) => activity.type === "model.output.delta"), false);
  assert.deepEqual(
    stream.activities.filter((activity) => activity.type === "model.output.completed")
      .map((activity) => activity.content),
    ["Hello, complete world."],
  );
  fixture.hub.release();
});

test("activity hub calls the release hook only after the last subscriber leaves", () => {
  const releasedRunIds = [];
  const fixture = createFixture({
    onLastSubscriberRemoved: (runId) => { releasedRunIds.push(runId); },
  });
  const firstUnsubscribe = fixture.hub.subscribe(RUN_ID, () => undefined);
  const secondUnsubscribe = fixture.hub.subscribe(RUN_ID, () => undefined);

  firstUnsubscribe();
  assert.deepEqual(releasedRunIds, []);
  secondUnsubscribe();
  assert.deepEqual(releasedRunIds, [RUN_ID]);
  fixture.hub.release();
});

test("activity hub prepareRelease persists the latest visible assistant text", async () => {
  const checkpoints = [];
  const fixture = createFixture({
    persistVisibleAssistantText: async (runId, text) => { checkpoints.push({ runId, text }); },
  });

  fixture.hub.recordModelRequest(RUN_ID, "initial");
  fixture.hub.recordOutputDelta(RUN_ID, 0, "latest ");
  fixture.hub.recordOutputDelta(RUN_ID, 0, "answer");
  await fixture.hub.prepareRelease();

  assert.deepEqual(checkpoints, [{ runId: RUN_ID, text: "latest answer" }]);
  fixture.hub.release();
});

const RUN_ID = "run-activity-hub-test";

function createFixture(overrides = {}) {
  const state = {
    runId: RUN_ID,
    status: { kind: "running" },
    timeline: [],
    toolCalls: [],
    toolResultRecordedAt: {},
  };
  const document = { revision: 1, state };
  let nextId = 0;
  const trackedTasks = [];
  const hub = createOrdinaryRunActivityHub({
    streamEpoch: "test-stream-epoch",
    checkpointIntervalMs: 60_000,
    idFactory: (prefix) => `${prefix}-${++nextId}`,
    now: () => "2026-08-25T00:00:00.000Z",
    sessionRepository: { readAssistantEntries: async () => [] },
    isReleased: () => false,
    getCachedRun: () => document,
    loadRun: async () => document,
    persistVisibleAssistantText: overrides.persistVisibleAssistantText ?? (async () => undefined),
    recordReasoning: overrides.recordReasoning ?? (async () => undefined),
    trackBackgroundTask: (task) => { trackedTasks.push(task); },
    onLastSubscriberRemoved: overrides.onLastSubscriberRemoved ?? (() => undefined),
  });
  return { document, hub, trackedTasks };
}
