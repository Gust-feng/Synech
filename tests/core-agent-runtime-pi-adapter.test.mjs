import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AgentHarness, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";

import { createAgentSessionLoop } from "../dist/adapters/intelligence/agent-session-loop.js";
import { UNSUPPORTED_IMAGE_PLACEHOLDER } from "../dist/adapters/intelligence/session-image-placeholder.js";
import { createModelProviderBinding } from "../dist/adapters/intelligence/model-provider-binding.js";

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
function createModels(streams, model = MODEL) {
  const queue = [...streams];
  return {
    requested: 0,
    contexts: [],
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [model],
    getModel: () => model,
    getAuth: async () => undefined,
    streamSimple(_model, context) {
      this.requested += 1;
      this.contexts.push(structuredClone(context));
      const next = queue.shift();
      if (next === undefined) throw new Error("The scripted provider ran out of responses.");
      return next;
    },
    completeSimple: async () => assistantMessage([{ type: "text", text: "summary" }]),
  };
}

test("a custom gateway's associated vision model keeps user and tool images through the real Harness", async () => {
  const model = createModelProviderBinding({
    profileId: "image-gateway", protocol: "openai_compatible_chat_completions",
    baseUrl: "https://example.invalid/v1", apiKey: "unused-key", model: "vendor/deepseek-flash",
  }).selectedModel;
  const image = {
    kind: "image", source: { kind: "data", mimeType: "image/png", data: "aW1hZ2U=" },
  };
  const session = await createSession("associated-vision-images");
  const models = createModels([
    toolCallStream({ type: "toolCall", id: "call-read-image", name: DEFINITION.name, arguments: { value: "image" } }),
    textStream("Both images received."),
  ], model);
  const recorded = [];
  const boundary = toolBoundary(recorded);
  const imageTools = {
    ...boundary,
    gateway: { ...boundary.gateway, async execute(request) {
      return { ...request, output: { format: "image" }, modelAttachments: [image], status: "completed", durationMs: 0 };
    } },
  };
  const loop = createAgentSessionLoop({
    agentSession: session, modelRegistry: models, selectedModel: model,
    supportsVisionInput: true, compactionSettings: COMPACTION,
  });
  try {
    const outcome = await loop.execute(createInput(imageTools, recorded, {
      messages: [{ role: "user", content: "Inspect both images.", attachments: [image] }],
    }));
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.toolResults[0].modelAttachments, undefined);
    assert.equal(outcome.toolResults[0].modelAttachmentRefs.length, 1);
    assert.ok(!JSON.stringify(outcome.toolResults).includes(image.source.data));
    const firstUser = models.contexts[0].messages.find((message) => message.role === "user");
    assert.ok(firstUser.content.some((block) => block.type === "image" && block.data === image.source.data));
    const imageResult = models.contexts[1].messages.find((message) => message.role === "toolResult");
    assert.ok(imageResult.content.some((block) => block.type === "image" && block.data === image.source.data));
    const durableImages = (await session.findEntries(undefined, TODO_CONTEXT))
      .filter((entry) => entry.type === "message")
      .flatMap((entry) => Array.isArray(entry.message.content) ? entry.message.content : [])
      .filter((block) => block.type === "image");
    assert.equal(durableImages.length, 2, "the current turn and tool image remain available to future turns");
    const resultEntries = (await session.findEntries(undefined, TODO_CONTEXT))
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
    assert.ok(resultEntries.every((entry) => !JSON.stringify(entry.message.details).includes(image.source.data)),
      "Session stores image bytes in content once, not again in tool result details");
  } finally {
    await loop.release();
  }
});

test("a text-only run reports undelivered images while preserving them for a later vision run", async () => {
  const image = {
    kind: "image", source: { kind: "data", mimeType: "image/png", data: "aW1hZ2U=" },
  };
  const session = await createSession("text-only-image-notice");
  const models = createModels([textStream("The image was not delivered.")]);
  const loop = createAgentSessionLoop({
    agentSession: session, modelRegistry: models, selectedModel: MODEL,
    supportsVisionInput: false, compactionSettings: COMPACTION,
  });
  try {
    const outcome = await loop.execute(createInput(toolBoundary([]), [], {
      messages: [{ role: "user", content: "Inspect this image.", attachments: [image] }],
    }));
    assert.equal(outcome.status, "completed");
    const user = models.contexts[0].messages.find((message) => message.role === "user");
    assert.ok(user.content.some((block) => block.type === "text" && block.text === UNSUPPORTED_IMAGE_PLACEHOLDER));
    assert.ok(user.content.every((block) => block.type !== "image"));

    const visionModel = { ...MODEL, input: ["text", "image"] };
    const visionModels = createModels([textStream("The image is available now.")], visionModel);
    const visionLoop = createAgentSessionLoop({
      agentSession: session, modelRegistry: visionModels, selectedModel: visionModel,
      supportsVisionInput: true, compactionSettings: COMPACTION,
    });
    try {
      const resumed = await visionLoop.execute(createInput(toolBoundary([]), [], {
        messages: [{ role: "user", content: "Inspect the earlier image now." }],
      }));
      assert.equal(resumed.status, "completed");
      assert.ok(visionModels.contexts[0].messages.some((message) => Array.isArray(message.content) &&
        message.content.some((block) => block.type === "image" && block.data === image.source.data)));
    } finally {
      await visionLoop.release();
    }
  } finally {
    await loop.release();
  }
});

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

test("Pi Adapter stops undeliverable tool images without a final response checkpoint", async (t) => {
  for (const supportsVisionInput of [false, true]) await t.test(
    supportsVisionInput ? "capability projection mismatch" : "vision input unsupported",
    async () => {
      const session = await createSession("adapter-tool-use-terminal");
      const recorded = [];
      const models = createModels([
        toolCallStream({ type: "toolCall", id: "call-attachment", name: DEFINITION.name, arguments: { value: "image" } }),
      ]);
      const loop = createAgentSessionLoop({
        agentSession: session,
        modelRegistry: models,
        selectedModel: MODEL,
        supportsVisionInput,
        compactionSettings: COMPACTION,
      });
      const checkpoints = [];
      const boundary = toolBoundary(recorded);
      const attachmentBoundary = {
        ...boundary,
        gateway: {
          ...boundary.gateway,
          async execute(request) {
            return { ...request, output: { kind: "text", text: "image result" },
              modelAttachments: [{ kind: "image", source: { kind: "data", mimeType: "image/png", data: "aW1hZ2U=" } }],
              status: "completed", durationMs: 0 };
          },
        },
      };

      try {
        const outcome = await loop.execute(createInput(attachmentBoundary, recorded, {
          onSessionWriteCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
        }));
        assert.equal(outcome.status, "failed");
        assert.equal(outcome.errorCode, "tool_result_delivery_failed");
        assert.equal(outcome.toolResults.length, 1);
        assert.equal(outcome.toolResults[0].errorFacts.code, supportsVisionInput
          ? "tool_result_image_input_projection_mismatch" : "tool_result_image_input_unsupported");
        assert.equal(models.requested, 1, "an undeliverable image must stop before another model request");
        assert.equal(
          checkpoints.some((checkpoint) => checkpoint.kind === "assistant_response_entry_committed"),
          false,
          "tool-use termination must not be promoted to a final response checkpoint",
        );
      } finally {
        await loop.release();
      }
    },
  );
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

test("Pi Adapter settles a rejected input checkpoint before returning", { timeout: 5000 }, async () => {
  const session = await createSession("adapter-input-projection-failed");
  const recorded = [];
  const checkpoints = [];
  const models = createModels([textStream("Must not be requested.")]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });

  let recreated;
  try {
    const outcome = await loop.execute(createInput(toolBoundary(recorded), recorded, {
      onSessionWriteCheckpoint(checkpoint) {
        checkpoints.push(checkpoint);
        if (checkpoint.kind === "input_entry_committed") {
          throw new Error("Product input checkpoint could not be persisted.");
        }
      },
    }));

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.errorCode, "runtime_projection_failed");
    assert.equal(outcome.error, "Product input checkpoint could not be persisted.");
    assert.equal(models.requested, 0, "a rejected input checkpoint must not reach the provider");
    assert.equal(recorded.length, 0, "a rejected input checkpoint must not execute tools");
    assert.equal(
      checkpoints.some((checkpoint) => checkpoint.kind === "assistant_response_entry_committed"),
      false,
    );
    // Recreate without driving: the next loop's startup recovery must not hide
    // an operation left open by the failed projection.
    recreated = await AgentHarness.create({
      session,
      models,
      model: MODEL,
      tools: [],
      compaction: COMPACTION,
    }, TODO_CONTEXT);
    assert.equal(recreated.open.length, 0, "the failed run must have durably settled its operation");
    const lane = await recreated.harness.lane("main", TODO_CONTEXT);
    assert.equal((await lane.inspectExecution(TODO_CONTEXT)).current, null);
  } finally {
    try {
      await loop.release();
    } finally {
      await recreated?.harness.close(TODO_CONTEXT);
    }
  }
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
  let recreated;
  try {
    const outcome = await loop.execute(createInput(toolBoundary(recorded), recorded, {
      onSessionWriteCheckpoint(checkpoint) {
        if (checkpoint.kind === "assistant_tool_call_entry_committed") {
          throw new Error("Product checkpoint could not be persisted.");
        }
      },
    }));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.errorCode, "runtime_projection_failed");
    assert.equal(outcome.error, "Product checkpoint could not be persisted.");
    assert.equal(models.requested, 1, "projection failure must stop further model requests");
    assert.equal(recorded.length, 0, "an unaccepted checkpoint must not execute tools");
    recreated = await AgentHarness.create({
      session,
      models,
      model: MODEL,
      tools: [],
      compaction: COMPACTION,
    }, TODO_CONTEXT);
    assert.equal(recreated.open.length, 0, "projection failure must not leave an open operation");
  } finally {
    try {
      await loop.release();
    } finally {
      await recreated?.harness.close(TODO_CONTEXT);
    }
  }
});

test("Pi Adapter cancels a parallel child after delegated request acceptance fails", { timeout: 5000 }, async () => {
  const session = await createSession("adapter-delegated-projection-failed");
  const recorded = [];
  const childDefinition = { ...DEFINITION, name: "AdapterChildTool" };
  const definitions = [DEFINITION, childDefinition];
  const parentStream = createAssistantMessageEventStream();
  parentStream.push({ type: "start", partial: emptyPartial() });
  parentStream.push({
    type: "done",
    reason: "toolUse",
    message: assistantMessage([
      { type: "toolCall", id: "call-parent-a", name: DEFINITION.name, arguments: { value: "delegate-a" } },
      { type: "toolCall", id: "call-parent-b", name: DEFINITION.name, arguments: { value: "delegate-b" } },
    ], { stopReason: "toolUse" }),
  });
  const models = createModels([
    parentStream,
    toolCallStream({ type: "toolCall", id: "call-child-a", name: childDefinition.name, arguments: { value: "hi" } }),
    toolCallStream({ type: "toolCall", id: "call-child-b", name: childDefinition.name, arguments: { value: "hi" } }),
    textStream("Must not be requested."),
  ]);
  const loop = createAgentSessionLoop({
    agentSession: session,
    modelRegistry: models,
    selectedModel: MODEL,
    compactionSettings: COMPACTION,
  });
  const boundary = toolBoundary(recorded);
  let markSiblingStarted;
  const siblingStarted = new Promise((resolve) => { markSiblingStarted = resolve; });
  let siblingAborted = false;
  let recreated;
  try {
    const outcome = await loop.execute(createInput({
      ...boundary,
      definitions,
      permission: { ...boundary.permission, allowedTools: definitions.map((definition) => definition.name) },
      gateway: {
        ...boundary.gateway,
        list: () => definitions,
        has: (name) => definitions.some((definition) => definition.name === name),
        deliverResult: async (result) => result,
        async execute(request, context) {
          recorded.push(request);
          markSiblingStarted();
          await new Promise((resolve) => {
            if (context.abortSignal.aborted) resolve();
            else context.abortSignal.addEventListener("abort", resolve, { once: true });
          });
          siblingAborted = true;
          return { ...request, status: "cancelled", output: undefined, error: "Sibling cancelled.", durationMs: 0 };
        },
      },
    }, recorded, {
      agentTools: [{
        toolName: DEFINITION.name,
        resolve: async () => ({
          agentName: "adapter-child",
          instructions: "You are the child adapter contract test agent.",
          input: "Run the child tool.",
          callerAgentId: "adapter-child",
          allowedTools: [childDefinition.name],
        }),
      }],
      onNestedToolRequestsAccepted: async (requests) => {
        if (requests.some((request) => request.providerCallId === "call-child-a")) {
          await siblingStarted;
          throw new Error("Nested requests could not be persisted.");
        }
      },
    }));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.errorCode, "runtime_projection_failed");
    assert.equal(outcome.error, "Nested requests could not be persisted.");
    assert.equal(models.requested, 3, "child maintenance failure must stop sibling and parent follow-up requests");
    assert.deepEqual(recorded.map((request) => request.providerCallId), ["call-child-b"],
      "only the accepted sibling request may execute");
    assert.equal(siblingAborted, true, "the sibling must receive cancellation while the parent awaits tools");
    recreated = await AgentHarness.create({
      session,
      models,
      model: MODEL,
      tools: [],
      compaction: COMPACTION,
    }, TODO_CONTEXT);
    assert.equal(recreated.open.length, 0, "child maintenance failure must durably settle the parent");
  } finally {
    try {
      await loop.release();
    } finally {
      await recreated?.harness.close(TODO_CONTEXT);
    }
  }
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


test("restored conversations apply current model, capabilities, instructions and tools without losing history", async () => {
  const session = await createSession("adapter-model-switch");
  const recorded = [];
  const image = { kind: "image", source: { kind: "data", mimeType: "image/png", data: "aW1hZ2U=" } };
  const selections = [
    { model: { ...MODEL, reasoning: true, input: ["text", "image"] }, thinkingLevel: "high", tools: true },
    { model: { ...MODEL, id: "switched-model", reasoning: true }, thinkingLevel: "low", tools: false },
    { model: { ...MODEL, id: "switched-model", reasoning: true, input: ["text", "image"], maxTokens: 2048 }, thinkingLevel: "high", tools: true },
    { model: { ...MODEL, provider: "other-provider" }, tools: false },
    { model: { ...MODEL, provider: "other-provider" }, tools: false },
  ];
  for (const [index, selection] of selections.entries()) {
    const models = createModels([textStream(`Reply ${index}.`)], selection.model);
    models.getModel = (provider, modelId) =>
      provider === selection.model.provider && modelId === selection.model.id ? selection.model : undefined;
    const requests = [];
    const streamSimple = models.streamSimple.bind(models);
    models.streamSimple = (model, context, options) => {
      requests.push({ model, options });
      return streamSimple(model, context);
    };
    const loop = createAgentSessionLoop({
      agentSession: session, modelRegistry: models, selectedModel: selection.model,
      thinkingLevel: selection.thinkingLevel, compactionSettings: COMPACTION,
    });
    const boundary = toolBoundary(recorded);
    const tools = selection.tools ? boundary : {
      ...boundary, definitions: [], permission: { ...boundary.permission, allowedTools: [] },
    };
    try {
      const outcome = await loop.execute(createInput(tools, recorded, {
        instructions: `Instructions for turn ${index}.`,
        messages: [{ role: "user", content: `Turn ${index}.`, ...(index === 0 ? { attachments: [image] } : {}) }],
      }));
      assert.equal(outcome.status, "completed", JSON.stringify(outcome));
      assert.equal(outcome.finalText, `Reply ${index}.`);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model.id, selection.model.id);
      assert.equal(requests[0].model.provider, selection.model.provider);
      assert.equal(requests[0].model.maxTokens, selection.model.maxTokens);
      assert.equal(requests[0].options.reasoning, selection.thinkingLevel);
      const context = models.contexts[0];
      assert.equal(context.systemPrompt, `Instructions for turn ${index}.`);
      assert.deepEqual((context.tools ?? []).map((tool) => tool.name), selection.tools ? [DEFINITION.name] : []);
      const users = context.messages.filter((message) => message.role === "user");
      assert.equal(users.length, index + 1, "switching models must retain prior turns");
      const earlierImage = users[0].content;
      assert.equal(earlierImage.some((block) => block.type === "image"), selection.model.input.includes("image"));
      if (!selection.model.input.includes("image")) {
        assert.ok(earlierImage.some((block) => block.type === "text" && block.text === UNSUPPORTED_IMAGE_PLACEHOLDER));
      }
    } finally {
      await loop.release();
    }
  }
});

test("a new model settles an interrupted old-model operation before starting without replaying it", async () => {
  const session = await createSession("adapter-interrupted-model-switch");
  const oldModels = createModels([textStream("Must not replay the interrupted run.")]);
  const interrupted = await AgentHarness.create({
    session, models: oldModels, model: MODEL, thinkingLevel: "high", compaction: COMPACTION,
    activeToolNames: ["RemovedTool"],
  }, TODO_CONTEXT);
  const oldLane = await interrupted.harness.lane("main", TODO_CONTEXT);
  const admission = await oldLane.accept({ kind: "prompt", prompt: "Interrupted prompt." }, TODO_CONTEXT);
  assert.equal(admission.ok, true);
  // Acceptance is durable, but drive never started: this is a process-stop boundary.
  const model = { ...MODEL, id: "replacement-model", provider: "replacement-provider" };
  const models = createModels([textStream("New turn completed.")], model);
  models.getModel = (provider, modelId) => provider === model.provider && modelId === model.id ? model : undefined;
  const loop = createAgentSessionLoop({
    agentSession: session, modelRegistry: models, selectedModel: model, compactionSettings: COMPACTION,
  });
  try {
    const outcome = await loop.execute(createInput(toolBoundary([]), [], {
      messages: [{ role: "user", content: "Continue with the replacement model." }],
    }));
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    assert.equal(outcome.finalText, "New turn completed.");
    assert.equal(oldModels.requested, 0);
    assert.equal(models.requested, 1, "startup recovery must not issue an extra model request");
    const restored = await AgentHarness.create({ session, models, model, compaction: COMPACTION }, TODO_CONTEXT);
    assert.equal(restored.open.length, 0);
    const lane = await restored.harness.lane("main", TODO_CONTEXT);
    const previousResult = await lane.getResult(admission.value.operationId, TODO_CONTEXT);
    assert.equal(previousResult.status, "aborted");
    await restored.harness.close(TODO_CONTEXT);
  } finally {
    await loop.release();
  }
});
