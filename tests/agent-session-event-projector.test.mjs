import assert from "node:assert/strict";
import test from "node:test";

import { ToolInvocationBindingTable } from "../dist/adapters/intelligence/agent-session-tool-bindings.js";
import { RootHarnessEventProjector } from "../dist/adapters/intelligence/agent-session-loop/harness-event-projector.js";

test("assistant tool calls are owner-bound before checkpoint and visible notification", async () => {
  const order = [];
  const fixture = projectorFixture({
    onAcceptToolInvocations(calls) {
      order.push("accepted");
      return calls.map((call) => ({ ...call, invocationId: `invocation:${call.providerCallId}` }));
    },
    onCheckpoint(checkpoint) {
      order.push(`checkpoint:${checkpoint.kind}`);
    },
    onToolRequested() {
      order.push("requested");
    },
  });

  fixture.leaf.value = "assistant-entry-1";
  await fixture.emit(assistantToolMessageEvent());

  assert.deepEqual(order, [
    "accepted",
    "checkpoint:assistant_tool_call_entry_committed",
    "requested",
  ]);
  assert.equal(fixture.bindings.get("provider-call-1")?.invocationId, "invocation:provider-call-1");
});

test("rejected checkpoint does not advance the safe Session leaf", async () => {
  const fixture = projectorFixture({
    onCheckpoint(checkpoint) {
      if (checkpoint.kind === "input_entry_committed") throw new Error("checkpoint rejected");
    },
  });
  fixture.leaf.value = "user-entry-1";

  await assert.rejects(
    fixture.emit({
      type: "message_end",
      message: { role: "user", content: "hello", timestamp: 0 },
    }),
    /checkpoint rejected/u,
  );

  const refs = fixture.projector.sessionExecutionRefs();
  assert.deepEqual(refs.safeLeafRef, { sessionId: "session-1", entryId: "start-entry" });
  assert.deepEqual(refs.latestLeafRef, { sessionId: "session-1", entryId: "user-entry-1" });
});

test("incomplete tool result groups become a projector maintenance failure", async () => {
  const fixture = projectorFixture();
  fixture.leaf.value = "assistant-entry-1";
  const assistant = assistantToolMessage();
  await fixture.emit({ type: "message_end", message: assistant });

  await assert.rejects(
    fixture.emit({ type: "turn_end", message: assistant, toolResults: [] }),
    /without one tool result/u,
  );
  assert.deepEqual(fixture.projector.maintenanceFailure, {
    code: "session_tool_result_group_incomplete",
    error: "Pi Session turn ended without one tool result for every assistant tool call.",
  });
});

test("tool result delivery rejection keeps the pending request for retry", async () => {
  let attempts = 0;
  const fixture = projectorFixture({
    async acceptObserved() {
      attempts += 1;
      if (attempts === 1) throw new Error("result rejected");
    },
  });
  fixture.leaf.value = "assistant-entry-1";
  await fixture.emit(assistantToolMessageEvent());
  const executionEnd = {
    type: "tool_execution_end",
    toolCallId: "provider-call-1",
    toolName: "Read",
    result: { content: [{ type: "text", text: "done" }], details: undefined },
  };

  await assert.rejects(fixture.emit(executionEnd), /result rejected/u);
  await fixture.emit(executionEnd);
  assert.equal(attempts, 2);
});

function projectorFixture(overrides = {}) {
  const leaf = { value: "start-entry" };
  const agentSession = {
    async getLeafId() { return leaf.value; },
  };
  const input = {
    abortSignal: new AbortController().signal,
    async acceptToolInvocations(calls) {
      return overrides.onAcceptToolInvocations?.(calls)
        ?? calls.map((call) => ({ ...call, invocationId: `invocation:${call.providerCallId}` }));
    },
    onSessionWriteCheckpoint: overrides.onCheckpoint,
    onToolRequested: overrides.onToolRequested,
  };
  const bindings = new ToolInvocationBindingTable();
  const projector = new RootHarnessEventProjector({
    input,
    loopOptions: {
      executionEnvironment: {},
      modelRegistry: {},
      selectedModel: { input: ["text"] },
      agentSession,
    },
    sessionId: "session-1",
    agentSession,
    runtimeSession: agentSession,
    startLeafEntryId: "start-entry",
    modelInputSupportsImage: false,
    rootBindings: bindings,
    resultPort: {
      acceptObserved: overrides.acceptObserved ?? (async () => undefined),
      deliverPendingMessage: async () => undefined,
    },
    isCancellationRequested: () => false,
  });
  const hooks = new Map();
  let subscriber;
  const harness = {
    on(name, handler) { hooks.set(name, handler); },
    subscribe(handler) { subscriber = handler; },
    getActiveTools() { return [{ name: "Read" }]; },
  };
  projector.attach(harness, new Map([["Read", undefined]]));
  return {
    projector,
    bindings,
    leaf,
    async emit(event) {
      assert.ok(subscriber, "projector subscriber was not attached");
      await subscriber(event);
    },
  };
}

function assistantToolMessageEvent() {
  return { type: "message_end", message: assistantToolMessage() };
}

function assistantToolMessage() {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "provider-call-1",
      name: "Read",
      arguments: { path: "README.md" },
    }],
    stopReason: "toolUse",
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  };
}
