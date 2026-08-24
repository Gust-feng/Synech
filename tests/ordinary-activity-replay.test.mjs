import assert from "node:assert/strict";
import test from "node:test";

import {
  durableOrdinaryRunReplayFromState,
  ordinaryRunActivityCursor,
} from "../dist/app/ordinary-agent/activity-replay.js";

test("durable replay restores tool, reasoning and assistant output in semantic order", () => {
  const toolResult = {
    callId: "call-1",
    toolName: "Read",
    input: { path: "README.md" },
    output: "content",
    status: "completed",
    durationMs: 5,
  };
  const replay = durableOrdinaryRunReplayFromState({
    runId: "run-1",
    timeline: [
      event("event-created", "run.created", "2026-01-01T00:00:00.000Z"),
      {
        ...event("event-output", "model.output.completed", "2026-01-01T00:00:03.000Z"),
        modelRequestId: "request-1",
        assistantEntryRef: { sessionId: "session-1", entryId: "assistant-1" },
      },
      {
        ...event("event-reasoning", "model.reasoning.completed", "2026-01-01T00:00:04.000Z"),
        modelRequestId: "request-1",
        content: "reasoning",
      },
      {
        ...event("event-completed", "run.completed", "2026-01-01T00:00:05.000Z"),
        toolCallIds: ["call-1"],
      },
    ],
    toolCalls: [toolResult],
    toolResultRecordedAt: { "call-1:completed": "2026-01-01T00:00:02.000Z" },
  }, [{
    entryRef: { sessionId: "session-1", entryId: "assistant-1" },
    text: "final answer",
  }]);

  assert.deepEqual(replay.activities.map((activity) => activity.type), [
    "run.transition",
    "tool.result",
    "run.transition",
    "model.output.completed",
    "run.transition",
  ]);
  assert.equal(replay.activities[2].event.type, "model.reasoning.completed");
  assert.equal(replay.activities[3].content, "final answer");
  assert.deepEqual(replay.activities.map((activity) => activity.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(replay.cursor, {
    streamId: "ordinary-command-response:run-1:event-completed",
    sequence: 5,
  });
  assert.equal(replay.reset, false);
});

test("durable replay omits unresolved output and approval-only tool results", () => {
  const replay = durableOrdinaryRunReplayFromState({
    runId: "run-2",
    timeline: [{
      ...event("event-output", "model.output.completed", "2026-01-01T00:00:01.000Z"),
      modelRequestId: "request-2",
      assistantEntryRef: { sessionId: "session-2", entryId: "assistant-2" },
    }],
    toolCalls: [{
      callId: "call-2",
      toolName: "Write",
      input: { path: "file.txt" },
      output: undefined,
      status: "approval_required",
      durationMs: 0,
    }],
    toolResultRecordedAt: { "call-2:approval_required": "2026-01-01T00:00:00.000Z" },
  }, []);

  assert.deepEqual(replay.activities, []);
  assert.deepEqual(replay.cursor, {
    streamId: "ordinary-command-response:run-2:event-output",
    sequence: 0,
  });
  assert.deepEqual(ordinaryRunActivityCursor({ streamId: "live-stream", nextSequence: 4 }), {
    streamId: "live-stream",
    sequence: 3,
  });
});

function event(eventId, type, recordedAt) {
  return {
    eventId,
    runId: eventId.startsWith("event-output") && eventId === "event-output" ? "run-2" : "run-1",
    sequence: 1,
    recordedAt,
    type,
  };
}
