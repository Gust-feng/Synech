import assert from "node:assert/strict";
import test from "node:test";

import { isTerminalStatus } from "../dist/app/ordinary-agent/run-lifecycle-policy.js";
import {
  createInitialOrdinaryRunState,
  transitionOrdinaryRun,
} from "../dist/app/ordinary-agent/state.js";

test("Ordinary terminal policy distinguishes completed, failed, cancelled and blocked", () => {
  for (const kind of ["completed", "failed", "cancelled", "blocked"]) {
    assert.equal(isTerminalStatus({ kind }), true);
  }
  for (const kind of ["queued", "running", "awaiting_approval"]) {
    assert.equal(isTerminalStatus({ kind }), false);
  }
});

test("Ordinary state rejects an assistant checkpoint without a model request identity", () => {
  const sessionRef = {
    sessionId: "session-request-identity",
    storageKey: "session-request-identity",
    sessionCwd: process.cwd(),
    createdAt: "2026-09-30T00:00:00.000Z",
  };
  const checkpoint = (checkpointId, kind) => ({
    sessionId: sessionRef.sessionId,
    checkpointId,
    kind,
  });
  const base = createInitialOrdinaryRunState({
    runId: "run-request-identity",
    sessionRef,
    turn: {
      conversationId: "conversation-request-identity",
      ordinal: 1,
      userTurnId: "user-request-identity",
      assistantTurnId: "assistant-request-identity",
    },
    runInput: { userMessage: "hello" },
    birth: {},
    recordedAt: "2026-09-30T00:00:00.000Z",
    eventId: "event-created",
  });
  const started = transitionOrdinaryRun({
    state: base,
    transition: { type: "start" },
    recordedAt: "2026-09-30T00:00:01.000Z",
    eventId: "event-started",
  });
  const withStart = transitionOrdinaryRun({
    state: started,
    transition: {
      type: "record_session_checkpoint",
      checkpoint: {
        sessionId: sessionRef.sessionId,
        kind: "start_leaf_captured",
        checkpoint: null,
      },
    },
    recordedAt: "2026-09-30T00:00:02.000Z",
    eventId: "event-start-checkpoint",
  });
  const withInput = transitionOrdinaryRun({
    state: withStart,
    transition: {
      type: "record_session_checkpoint",
      checkpoint: {
        sessionId: sessionRef.sessionId,
        kind: "input_entry_committed",
        checkpoint: checkpoint("input#1", "input_committed"),
      },
    },
    recordedAt: "2026-09-30T00:00:03.000Z",
    eventId: "event-input-checkpoint",
  });

  assert.throws(
    () => transitionOrdinaryRun({
      state: withInput,
      transition: {
        type: "record_session_checkpoint",
        checkpoint: {
          sessionId: sessionRef.sessionId,
          kind: "assistant_response_entry_committed",
          checkpoint: checkpoint("answer#1", "assistant_response_committed"),
          assistantText: "answer",
        },
      },
      recordedAt: "2026-09-30T00:00:04.000Z",
      eventId: "event-answer-checkpoint",
    }),
    (error) => error?.code === "ordinary_run_state_conflict" &&
      /model request identity/u.test(error.message),
  );
});
