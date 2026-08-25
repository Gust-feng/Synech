import assert from "node:assert/strict";
import test from "node:test";

import { createStableInvocationId } from "../dist/kernel/id.js";
import { sameResultForIdempotency } from "../dist/domain/tools/contracts.js";
import {
  createInitialOrdinaryRunState,
  reconcileInterruptedOrdinaryToolRound,
  transitionOrdinaryRun,
} from "../dist/app/ordinary-agent/state.js";

test("tool invocation identity is stable within a round and isolated across rounds", () => {
  const base = { runId: "run-1", roundId: "assistant-entry-1", providerCallId: "provider-call-1" };
  assert.equal(createStableInvocationId(base), createStableInvocationId(base));
  assert.notEqual(createStableInvocationId(base), createStableInvocationId({ ...base, roundId: "assistant-entry-2" }));
  assert.notEqual(createStableInvocationId(base), createStableInvocationId({
    ...base,
    parentInvocationId: "parent-invocation",
  }));
});

test("tool result idempotency ignores object key order but rejects provider identity drift", () => {
  const result = toolResult({
    input: { path: "README.md", options: { encoding: "utf8", limit: 10 } },
    output: { ok: true, facts: { first: 1, second: 2 } },
  });
  const reordered = toolResult({
    input: { options: { limit: 10, encoding: "utf8" }, path: "README.md" },
    output: { facts: { second: 2, first: 1 }, ok: true },
  });
  assert.equal(sameResultForIdempotency(result, reordered), true);
  assert.equal(sameResultForIdempotency(result, { ...reordered, providerCallId: "provider-call-2" }), false);
});

test("interrupted root tool round recovers before any result was persisted", () => {
  const recovered = reconcileInterruptedOrdinaryToolRound({
    state: runWithPendingToolRound(),
    orderedToolCalls: [
      providerToolCall("provider-call-1", "Read", { path: "README.md" }),
      providerToolCall("provider-call-2", "Search", { query: "Synech" }),
    ],
    recordedAt: "2026-08-25T00:00:04.000Z",
  });
  assert.deepEqual(recovered.toolCalls.map((result) => ({
    providerCallId: result.providerCallId,
    invocationId: result.invocationId,
    status: result.status,
    code: result.errorFacts?.code,
  })), [
    { providerCallId: "provider-call-1", invocationId: "invocation-1", status: "failed", code: "tool_execution_outcome_unknown" },
    { providerCallId: "provider-call-2", invocationId: "invocation-2", status: "failed", code: "tool_execution_outcome_unknown" },
  ]);
});

test("interrupted root tool round rejects a different provider order", () => {
  assert.throws(() => reconcileInterruptedOrdinaryToolRound({
    state: runWithPendingToolRound(),
    orderedToolCalls: [
      providerToolCall("provider-call-2", "Search", { query: "Synech" }),
      providerToolCall("provider-call-1", "Read", { path: "README.md" }),
    ],
    recordedAt: "2026-08-25T00:00:04.000Z",
  }), /does not match its provider-ordered Session tool calls/u);
});

function runWithPendingToolRound() {
  let state = createInitialOrdinaryRunState({
    runId: "run-1",
    sessionRef: { sessionId: "session-1" },
    turn: { conversationId: "conversation-1", ordinal: 1, userTurnId: "user-1", assistantTurnId: "assistant-1" },
    runInput: { userMessage: "Do the work" },
    birth: {
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
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
      agentDefinitionRef: { id: "ordinary" },
      capabilitySnapshot: { executionRoot: "Z:/Workspace" },
      memoryOwner: { kind: "workspace", id: "workspace-1" },
      informationAccess: {},
      toolConfirmationPolicy: {},
    },
    recordedAt: "2026-08-25T00:00:00.000Z",
    eventId: "event-created",
  });
  state = transition(state, { type: "start" }, 1, "event-started");
  state = transition(state, {
    type: "record_session_checkpoint",
    checkpoint: { kind: "start_leaf_captured", sessionId: "session-1", startLeafRef: null },
  }, 2, "event-start-leaf");
  state = transition(state, {
    type: "record_session_checkpoint",
    checkpoint: {
      kind: "input_entry_committed",
      sessionId: "session-1",
      inputEntryRef: { sessionId: "session-1", entryId: "user-entry-1" },
    },
  }, 3, "event-input");
  return transition(state, {
    type: "record_session_checkpoint",
    checkpoint: {
      kind: "assistant_tool_call_entry_committed",
      sessionId: "session-1",
      assistantEntryRef: { sessionId: "session-1", entryId: "assistant-entry-1" },
      providerCallIds: ["provider-call-1", "provider-call-2"],
      invocationIds: ["invocation-1", "invocation-2"],
    },
  }, 4, "event-tool-round");
}

function transition(state, next, seconds, eventId) {
  return transitionOrdinaryRun({
    state,
    transition: next,
    recordedAt: `2026-08-25T00:00:0${seconds}.000Z`,
    eventId,
  });
}

function providerToolCall(providerCallId, toolName, input) {
  return { providerCallId, toolName, input, roundId: "assistant-entry-1" };
}

function toolResult(overrides = {}) {
  return {
    providerCallId: "provider-call-1",
    invocationId: "invocation-1",
    toolName: "Read",
    input: { path: "README.md" },
    output: { ok: true },
    status: "completed",
    durationMs: 1,
    ...overrides,
  };
}
