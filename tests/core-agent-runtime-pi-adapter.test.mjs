import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";

import { createAgentSessionLoop } from "../dist/adapters/intelligence/agent-session-loop.js";
import { withToolModelAttachments } from "../dist/domain/tools/model-attachments.js";

const MODEL = Object.freeze({
  id: "adapter-model",
  name: "adapter-model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0 },
  contextWindow: 32_000,
  maxTokens: 1_024,
});

const COMPACTION = Object.freeze({
  enabled: false,
  reserveTokens: 4_096,
  keepRecentTokens: 4_096,
});

function assistantMessage(content, overrides = {}) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: MODEL.id,
    content,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, reasoning: 0, cost: { total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function emptyPartial() {
  return assistantMessage([]);
}

function textPartial(text) {
  return assistantMessage([{ type: "text", text }]);
}

function toolCallPartial(call) {
  return assistantMessage([call]);
}

function textStream(text) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: emptyPartial() });
  stream.push({ type: "text_start", contentIndex: 0, partial: textPartial("") });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: textPartial(text) });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: textPartial(text) });
  stream.push({ type: "done", reason: "stop", message: assistantMessage([{ type: "text", text }]) });
  return stream;
}

function toolCallStream(call) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: emptyPartial() });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: toolCallPartial(call) });
  stream.push({
    type: "toolcall_delta",
    contentIndex: 0,
    delta: JSON.stringify(call.arguments),
    partial: toolCallPartial(call),
  });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: toolCallPartial(call) });
  stream.push({ type: "done", reason: "toolUse", message: assistantMessage([call]) });
  return stream;
}

function errorStream(message) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: emptyPartial() });
  const failed = assistantMessage([], { stopReason: "error", errorMessage: message });
  stream.push({ type: "done", reason: "error", message: failed });
  return stream;
}

function deferredStream() {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: emptyPartial() });
  stream.push({
    type: "done",
    reason: "deferred",
    message: assistantMessage([], {
      stopReason: "deferred",
      deferred: {
        provider: MODEL.provider,
        modelId: MODEL.id,
        api: MODEL.api,
        id: "deferred-adapter-test",
      },
    }),
  });
  return stream;
}

/** Queue-based fake provider registry. Each entry is the stream for one request. */
function createModels(streams) {
  const queue = [...streams];
  return {
    requested: 0,
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [MODEL],
    getModel: () => MODEL,
    getAuth: async () => undefined,
    streamSimple() {
      this.requested += 1;
      const next = queue.shift();
      if (next === undefined) throw new Error("The scripted provider ran out of responses.");
      return next;
    },
    completeSimple: async () => assistantMessage([{ type: "text", text: "summary" }]),
  };
}

async function createSession(sessionId) {
  const repo = new MemorySessionRepo();
  return repo.create({ id: sessionId }, TODO_CONTEXT);
}

const DEFINITION = Object.freeze({
  name: "AdapterFakeTool",
  description: "A tool used only by the Pi Adapter contract tests.",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  metadata: { operationType: "read-write" },
});

function createGateway(recorded) {
  return {
    list: () => [DEFINITION],
    has: (name) => name === DEFINITION.name,
    preflight: (request) => ({ status: "ready", request }),
    async execute(request) {
      recorded.push(request);
      return {
        ...request,
        output: { kind: "text", text: `handled:${JSON.stringify(request.input)}` },
        status: "completed",
        durationMs: 0,
      };
    },
  };
}

function createInput(tools, recorded, overrides = {}) {
  return {
    instructions: "You are the Synech adapter contract test agent.",
    messages: [{ role: "user", content: "Start." }],
    tools,
    abortSignal: new AbortController().signal,
    async acceptToolInvocations(calls) {
      return calls.map((call) => ({ ...call, invocationId: `invocation:${call.providerCallId}` }));
    },
    async acceptNestedToolInvocations(calls) {
      return calls.map((call) => ({ ...call, invocationId: `nested:${call.providerCallId}` }));
    },
    ...overrides,
  };
}

function toolBoundary(recorded) {
  return {
    definitions: [DEFINITION],
    gateway: createGateway(recorded),
    context: {
      callerAgentId: "adapter-agent",
      traceId: "trace-adapter",
      goalId: "goal-adapter",
      conversationId: "conversation-adapter",
    },
    permission: { callerAgentId: "adapter-agent", allowedTools: [DEFINITION.name] },
  };
}

async function mainBranchEntries(session) {
  const branch = await session.branch("main", TODO_CONTEXT);
  return branch === undefined ? [] : await branch.findEntries({ order: "oldestFirst" }, TODO_CONTEXT);
}

test("Pi Adapter runs a real prompt and reports product session checkpoints", async () => {
  const session = await createSession("adapter-completed");
  const models = createModels([textStream("Adapter done.")]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });
  const content = [];
  const checkpoints = [];

  const outcome = await loop.execute(createInput(
    toolBoundary([]),
    [],
    {
      onModelContent: (event) => content.push(event),
      onSessionWriteCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    },
  ));

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.finalText, "Adapter done.");
  assert.equal(models.requested, 1);
  assert.ok(content.some((event) => event.phase === "delta" && event.content === "Adapter done."));

  assert.ok(outcome.session !== undefined, "completed run must report product session refs");
  assert.equal(outcome.session.sessionId, "adapter-completed");
  assert.equal(outcome.session.startCheckpoint, null,
    "a run on a Session with no earlier leaf has no start checkpoint to resolve");
  assert.ok(outcome.session.safeCheckpoint !== null, "completed run must have a durable safe checkpoint");
  assert.ok(
    checkpoints.some((checkpoint) => checkpoint.kind === "assistant_response_entry_committed"),
    "the assistant response must be checkpointed in write order",
  );
  const responses = checkpoints.filter((checkpoint) => checkpoint.kind === "assistant_response_entry_committed");
  assert.deepEqual(
    responses.map((checkpoint) => checkpoint.assistantText),
    ["Adapter done."],
    "the assistant text must travel with the checkpoint: Pi commits the entry after the event, so a live run cannot read it back",
  );

  // The main branch must exist for the Synech adapter to read the durable leaf.
  const entries = await mainBranchEntries(session);
  assert.ok(entries.length > 0, "the durable transcript must expose a main branch");
  assert.ok(
    outcome.session.latestCheckpoint !== null,
    "completed run must report the checkpoint of its latest durable entry",
  );
  assert.ok(
    checkpoints.every((checkpoint) => !("entryId" in checkpoint) && !("entryRef" in checkpoint)),
    "a write checkpoint must carry only product identity, never a provider entry id",
  );
  assert.ok(
    checkpoints.some((checkpoint) => checkpoint.checkpoint?.checkpointId === outcome.session.latestCheckpoint.checkpointId),
    "the reported latest checkpoint must have been emitted in write order",
  );

  await loop.release();
});

test("Pi Adapter dispatches a Synech tool through the product gateway", async () => {
  const session = await createSession("adapter-tool");
  const recorded = [];
  const models = createModels([
    toolCallStream({ type: "toolCall", id: "call-adapter-1", name: DEFINITION.name, arguments: { value: "hi" } }),
    textStream("Tool finished."),
  ]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });
  const delivered = [];
  const checkpoints = [];

  const outcome = await loop.execute(createInput(toolBoundary(recorded), recorded, {
    onToolResult: (result) => delivered.push(result),
    onSessionWriteCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  }));

  assert.equal(outcome.status, "completed");
  assert.equal(models.requested, 2, "the tool result must trigger exactly one follow-up request");
  assert.deepEqual(
    checkpoints
      .filter((checkpoint) => checkpoint.kind === "assistant_tool_call_entry_committed" ||
        checkpoint.kind === "assistant_response_entry_committed")
      .map((checkpoint) => [checkpoint.kind, checkpoint.assistantText]),
    [
      ["assistant_tool_call_entry_committed", ""],
      ["assistant_response_entry_committed", "Tool finished."],
    ],
    "every assistant checkpoint must carry the text of the output it names",
  );

  assert.equal(recorded.length, 1, "the Synech gateway must execute exactly once");
  const request = recorded[0];
  assert.equal(request.providerCallId, "call-adapter-1", "the provider call id must be returned unchanged");
  assert.equal(request.toolName, DEFINITION.name);
  assert.equal(request.invocationId, "invocation:call-adapter-1", "the invocation id must be Synech-bound");
  assert.deepEqual(request.input, { value: "hi" });

  assert.equal(delivered.length, 1, "the tool result must be delivered to the owning feature");
  assert.equal(delivered[0].status, "completed");
  assert.equal(outcome.toolResults.length, 1);
  assert.equal(outcome.toolResults[0].invocationId, "invocation:call-adapter-1");

  await loop.release();
});

test("Pi Adapter maps a blocked tool preflight to a delivered failure", async () => {
  const session = await createSession("adapter-blocked");
  const recorded = [];
  const models = createModels([textStream("Unused.")]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });
  const boundary = toolBoundary(recorded);
  const blockedBoundary = {
    ...boundary,
    gateway: {
      ...boundary.gateway,
      list: () => [],
      has: () => false,
      preflight: () => ({
        status: "blocked",
        result: {
          providerCallId: "unused",
          invocationId: "unused",
          toolName: DEFINITION.name,
          input: undefined,
          output: undefined,
          status: "failed",
          error: "The tool is not available in this run.",
          errorDomain: "runtime_error",
          errorFacts: { code: "tool_unavailable", doNotBlindlyRetry: true },
        },
      }),
    },
  };

  const outcome = await loop.execute(createInput(blockedBoundary, recorded));

  assert.equal(outcome.status, "completed");
  assert.equal(recorded.length, 0, "a blocked preflight must not reach the executor");
});

test("Pi Adapter cancellation converges as cancelled, not failed", async () => {
  const session = await createSession("adapter-cancelled");
  const controller = new AbortController();
  const models = createModels([textStream("Never shown.")]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });

  controller.abort(new Error("user stopped the run"));
  const outcome = await loop.execute(createInput(
    toolBoundary([]),
    [],
    { abortSignal: controller.signal },
  ));

  assert.equal(outcome.status, "cancelled");
  assert.equal(models.requested, 0, "an aborted run must not call the provider");
});

test("Pi Adapter surfaces a provider failure with a structured code", async () => {
  const session = await createSession("adapter-failed");
  const models = createModels([errorStream("Provider refused the request.")]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });

  const outcome = await loop.execute(createInput(toolBoundary([]), []));

  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /Provider refused the request/);
  assert.equal(outcome.errorCode, "provider_response");
});

test("Pi Adapter settles unsupported deferred runs without resuming them", async () => {
  const session = await createSession("adapter-deferred");
  const models = createModels([deferredStream(), textStream("After deferred.")]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });

  const first = await loop.execute(createInput(toolBoundary([]), []));

  assert.equal(first.status, "failed");
  assert.equal(first.errorCode, "deferred_unsupported");
  assert.equal(models.requested, 1, "unsupported deferred runs must not be resumed");

  const second = await loop.execute(createInput(toolBoundary([]), []));
  assert.equal(second.status, "completed", "the suspended operation must be settled before the next prompt");
  assert.equal(second.finalText, "After deferred.");
  assert.equal(models.requested, 2);
  await loop.release();
});

test("Pi Adapter does not mint a response checkpoint for completed tool use", async () => {
  const session = await createSession("adapter-tool-use-terminal");
  const recorded = [];
  const models = createModels([
    toolCallStream({ type: "toolCall", id: "call-attachment", name: DEFINITION.name, arguments: { value: "image" } }),
  ]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });
  const checkpoints = [];
  const boundary = toolBoundary(recorded);
  const attachmentBoundary = {
    ...boundary,
    gateway: {
      ...boundary.gateway,
      async execute(request) {
        const output = withToolModelAttachments(
          { kind: "text", text: "image result" },
          [{ kind: "image", source: { kind: "data", mimeType: "image/png", data: "aW1hZ2U=" } }],
        );
        return { ...request, output, status: "completed", durationMs: 0 };
      },
    },
  };

  const outcome = await loop.execute(createInput(attachmentBoundary, recorded, {
    onSessionWriteCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  }));

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorCode, "tool_result_delivery_failed");
  assert.equal(outcome.toolResults.length, 1);
  assert.equal(outcome.toolResults[0].errorFacts.code, "tool_result_image_input_unsupported");
  assert.equal(
    checkpoints.some((checkpoint) => checkpoint.kind === "assistant_response_entry_committed"),
    false,
    "tool-use termination must not be promoted to a final response checkpoint",
  );
  await loop.release();
});

test("Pi Adapter rejects an empty completed assistant", async () => {
  const session = await createSession("adapter-empty-assistant");
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: emptyPartial() });
  stream.push({ type: "done", reason: "stop", message: assistantMessage([]) });
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: createModels([stream]),
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });
  const checkpoints = [];
  const outcome = await loop.execute(createInput(toolBoundary([]), [], {
    onSessionWriteCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  }));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorCode, "final_assistant_empty");
  assert.equal(
    checkpoints.some((checkpoint) => checkpoint.kind === "assistant_response_entry_committed"),
    false,
  );
  await loop.release();
});

test("Pi Adapter refuses to execute after release", async () => {
  const session = await createSession("adapter-released");
  const models = createModels([textStream("First.")]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });

  const first = await loop.execute(createInput(toolBoundary([]), []));
  assert.equal(first.status, "completed");
  await loop.release();

  await assert.rejects(
    () => loop.execute(createInput(toolBoundary([]), [])),
    /released/,
  );
});

test("Pi Adapter stops after a durable projection fails", { timeout: 5000 }, async () => {
  const session = await createSession("adapter-projection-failed");
  const recorded = [];
  const models = createModels([
    toolCallStream({ type: "toolCall", id: "call-projection", name: DEFINITION.name, arguments: { value: "hi" } }),
    textStream("Must not be requested."),
  ]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });
  const outcome = await loop.execute(createInput(toolBoundary(recorded), recorded, {
    onSessionWriteCheckpoint(checkpoint) {
      if (checkpoint.kind === "assistant_tool_call_entry_committed") {
        throw new Error("Product checkpoint could not be persisted.");
      }
    },
  }));
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.errorCode, "runtime_projection_failed");
  assert.equal(models.requested, 1, "projection failure must stop further model requests");
  assert.equal(recorded.length, 0, "an unaccepted checkpoint must not execute tools");
  await loop.release();
});

test("Pi Adapter lets the owner finish accepting a tool round before the tool executes", async () => {
  const session = await createSession("adapter-slow-accept");
  const models = createModels([
    toolCallStream({ type: "toolCall", id: "call-slow", name: DEFINITION.name, arguments: { value: "hi" } }),
    textStream("Tool finished."),
  ]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });
  const recorded = [];
  let toolRequestedBeforeAcceptance = false;
  let acceptanceSettled = false;

  const outcome = await loop.execute(createInput(toolBoundary(recorded), recorded, {
    onToolRequested: () => {
      if (!acceptanceSettled) toolRequestedBeforeAcceptance = true;
    },
    async acceptToolInvocations(calls) {
      // Pi must await the projection, so nothing downstream of the binding can
      // run while the owner is still deciding. Let the microtask and timer
      // queues drain before settling the acceptance.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(recorded.length, 0, "the tool executed before its invocation was accepted");
      assert.ok(!toolRequestedBeforeAcceptance, "the tool was requested before its invocation was accepted");
      acceptanceSettled = true;
      return calls.map((call) => ({
        ...call,
        invocationId: `invocation:${call.providerCallId}`,
      }));
    },
  }));

  assert.equal(outcome.status, "completed");
  assert.equal(recorded.length, 1, "the Synech gateway must execute exactly once");
  assert.equal(recorded[0].invocationId, "invocation:call-slow");

  await loop.release();
});
