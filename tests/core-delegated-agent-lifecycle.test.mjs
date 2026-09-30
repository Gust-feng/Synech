import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { AgentHarness, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { Type } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

import { createDelegatedAgentTool } from "../dist/adapters/intelligence/agent-session-loop/delegated-agent-runner.js";
import { ToolInvocationBindingTable } from "../dist/adapters/intelligence/agent-session-tool-bindings.js";
import { harnessToolResult } from "../dist/adapters/intelligence/tool-result-transport.js";

const MODEL = Object.freeze({
  id: "delegated-lifecycle-model",
  name: "delegated-lifecycle-model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0 },
  contextWindow: 32_000,
  maxTokens: 1_024,
});
const COMPACTION = Object.freeze({ enabled: false, reserveTokens: 4_096, keepRecentTokens: 4_096 });
const NESTED_TOOL = Object.freeze({
  name: "LifecycleTool",
  description: "Lifecycle contract tool.",
  inputSchema: { type: "object", properties: {} },
});
const TOOL_CALL = Object.freeze({
  type: "toolCall", id: "nested-call", name: NESTED_TOOL.name, arguments: {},
});
const MODEL_INPUT = Object.freeze({ supportsVisionInput: false, modelInputSupportsImage: false });

function assistant(content, stopReason = "stop", extra = {}) {
  return {
    role: "assistant",
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      reasoning: 0, cost: { total: 0 },
    },
    ...extra,
  };
}

function text(text) {
  return assistant([{ type: "text", text }]);
}

function deferred() {
  return assistant([], "deferred", {
    deferred: { provider: MODEL.provider, modelId: MODEL.id, api: MODEL.api, id: "deferred-child" },
  });
}

function scriptedModels(responses, onRequest) {
  const queue = [...responses];
  return {
    requested: 0,
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [MODEL],
    getModel: () => MODEL,
    getAuth: async () => undefined,
    completeSimple: async () => text("Summary."),
    async streamSimple(_model, _context, options) {
      this.requested += 1;
      const next = queue.shift();
      assert.ok(next !== undefined, "no unplanned provider request is permitted");
      await options.onPayload?.({}, MODEL);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: assistant([]) });
      onRequest?.(options);
      stream.push({ type: "done", reason: next.stopReason, message: next });
      return stream;
    },
  };
}

function createRun(t, responses, faults = {}) {
  const controller = new AbortController();
  const models = scriptedModels(responses, () => {
    if (faults.cancelDuringRequest) controller.abort(new Error("User cancelled."));
  });
  const repo = new MemorySessionRepo();
  const subscriptions = new Set();
  const state = {
    controller, models, subscriptions,
    maintenance: [], delivered: [], executed: [], accepted: [],
    session: undefined, harness: undefined, lane: undefined,
    executionAtClose: undefined, resultAtClose: undefined, settings: undefined,
  };
  t.after(async () => {
    await state.harness?.close(TODO_CONTEXT);
    await repo.close(TODO_CONTEXT);
  });
  const trackRegistrations = (bus) => ({
    on(name, listener, options) {
      if (faults.registration && name === "after_tool") throw new Error("Hook registration failed.");
      const registration = { name, listener };
      const unsubscribe = bus.on(name, listener, options);
      subscriptions.add(registration);
      return () => {
        unsubscribe();
        subscriptions.delete(registration);
      };
    },
  });
  const dependencies = {
    async createSession(id) {
      state.session = await repo.create({ id }, TODO_CONTEXT);
      return state.session;
    },
    async createHarness(options, context) {
      state.session = options.session;
      if (faults.harnessCreation) throw new Error("Harness creation failed.");
      const { harness } = await AgentHarness.create(options, context);
      state.harness = harness;
      state.lane = await harness.lane("main", context);
      state.settings = await harness.getCompactionSettings(TODO_CONTEXT);
      const hooks = trackRegistrations(harness.hooks);
      const events = trackRegistrations(harness.events);
      const ownedHarness = new Proxy(harness, {
        get(target, property) {
          if (property === "hooks") return hooks;
          if (property === "events") return events;
          if (faults.laneAcquisition && property === "lane") {
            return async () => { throw new Error("Lane acquisition failed."); };
          }
          if (property === "close") return async (closeContext) => {
            state.executionAtClose = await state.lane.inspectExecution(TODO_CONTEXT);
            if (state.executionAtClose.lastOperationId !== null) {
              state.resultAtClose = await state.lane.getResult(state.executionAtClose.lastOperationId, TODO_CONTEXT);
            }
            if (faults.close) throw new Error("Harness close failed.");
            return target.close(closeContext);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const ownedLane = new Proxy(state.lane, {
        get(target, property) {
          if (faults.laneSetup && property === "setActiveTools") {
            return async () => { throw new Error("Lane setup failed."); };
          }
          if (faults.earlyProjection && property === "prompt") {
            return async (...args) => {
              await harness.events.emit({
                type: "handler_error", lane: "main", kind: "hook", hook: "before_payload",
                error: "Projection failed before operation admission.",
              }, TODO_CONTEXT);
              return target.prompt(...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return faults.laneAcquisition ? { harness: ownedHarness } : { harness: ownedHarness, lane: ownedLane };
    },
  };
  if (faults.nativeSession) delete dependencies.createSession;
  const boundary = {
    definitions: [NESTED_TOOL],
    gateway: { has: (name) => name === NESTED_TOOL.name },
    context: { callerAgentId: "parent", traceId: "lifecycle-trace" },
    permission: { callerAgentId: "parent", allowedTools: [NESTED_TOOL.name] },
  };
  const rootBindings = new ToolInvocationBindingTable();
  rootBindings.remember({ providerCallId: "parent-call", invocationId: "parent-invocation" });
  const tool = createDelegatedAgentTool({
    definition: { name: "Delegate", description: "Lifecycle delegation.", inputSchema: { type: "object" } },
    contribution: {
      toolName: "Delegate",
      resolve: async () => ({
        instructions: "Lifecycle contract agent.", input: "Start.",
        callerAgentId: "child", allowedTools: [NESTED_TOOL.name],
      }),
    },
    rootBindings,
    loopInput: {
      tools: boundary, agentTools: [], abortSignal: controller.signal,
      async acceptNestedToolInvocations(calls) {
        if (faults.acceptance) throw new Error("Nested acceptance failed first.");
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(state.executed.length, 0, "tools must wait for owner acceptance");
        return calls.map((call) => ({ ...call, invocationId: `nested:${call.providerCallId}` }));
      },
    },
    options: {
      modelRegistry: models, selectedModel: MODEL, compactionSettings: COMPACTION,
      transformProviderPayload: ({ payload }) => {
        if (faults.payload) throw new Error("Payload projection failed.");
        return payload;
      },
    },
    resultGateway: {
      async deliverResult(result) {
        assert.equal(subscriptions.size, 0, "registrations must be removed before delivery");
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        if (state.session !== undefined) {
          await assert.rejects(() => state.session.getName(TODO_CONTEXT), /closed/);
        }
        state.delivered.push(result);
        return result;
      },
    },
    createMechanicalTool({ definition, bindings, assertAccepted, onToolInvoked }) {
      if (faults.toolSetup) throw new Error("Tool setup failed.");
      return {
        name: definition.name, label: definition.name, description: definition.description,
        parameters: Type.Unsafe(definition.inputSchema),
        async execute(providerCallId, input) {
          const binding = bindings.get(providerCallId);
          assert.ok(binding !== undefined, "no tool may execute without a bound invocation");
          const request = { providerCallId, ...binding, toolName: definition.name, input };
          assertAccepted(request);
          onToolInvoked();
          state.executed.push(request);
          const result = {
            ...request, output: { kind: "text", text: "Tool done." }, status: "completed", durationMs: 0,
          };
          return harnessToolResult(result, MODEL_INPUT, faults.terminateTool === true);
        },
      };
    },
    facts: {
      results: {
        acceptObserved: async (result) => { state.accepted.push(result); },
        acceptForDelivery: async (result) => { state.accepted.push(result); },
        async deliverPendingMessage() {
          if (faults.delivery) throw new Error("Nested result delivery failed first.");
        },
        project: (result, terminate) => harnessToolResult(result, MODEL_INPUT, terminate),
      },
      run: {
        emitToolRequested: () => {},
        observeUsage: () => {},
        recordToolRequestAcceptanceFailure: () => {},
        hasBlockingFailure: () => state.maintenance.length > 0,
        isCancellationRequested: () => controller.signal.aborted,
      },
      maintenance: {
        record(failure) {
          state.maintenance.push(failure);
          if (faults.cancelAfterFailure) controller.abort(new Error("Later user cancellation."));
        },
        fail(code, error) { throw Object.assign(new Error(error), { code }); },
      },
    },
    dependencies,
  });
  state.execute = async () => {
    const projected = await tool.execute("parent-call", {}, controller.signal);
    assert.equal(state.delivered.length, 1);
    assert.deepEqual(projected.details.result, state.delivered[0]);
    return state.delivered[0];
  };
  return state;
}

test("delegated lifecycle: accepted tools finish before delivery and release owned resources", async (t) => {
  const run = createRun(t, [assistant([TOOL_CALL], "toolUse"), text("Final answer.")], { nativeSession: true });
  const result = await run.execute();
  assert.equal(result.status, "completed");
  assert.equal(result.output, "Final answer.");
  assert.equal(result.delegatedExecution.modelRounds, 2);
  assert.equal(result.delegatedExecution.toolCallCount, 1);
  assert.equal(run.executed[0].parentInvocationId, "parent-invocation");
  assert.equal(run.models.requested, 2);
  assert.equal(run.executionAtClose.current, null);
  assert.deepEqual(run.settings, COMPACTION);
  const before = run.maintenance.length;
  await run.harness.events.emit({
    type: "message_end", lane: "main", runId: "late", entryId: "late", message: text("Late output."),
  }, TODO_CONTEXT);
  assert.equal(run.maintenance.length, before, "closed runs must not receive late projections");
});

test("delegated lifecycle: unsupported deferred is aborted and settled without another request", async (t) => {
  const run = createRun(t, [deferred(), text("Must not resume.")]);
  const result = await run.execute();
  assert.equal(result.status, "failed");
  assert.equal(result.errorFacts.code, "deferred_unsupported");
  assert.equal(run.models.requested, 1);
  assert.equal(run.executionAtClose.current, null);
  assert.equal(run.resultAtClose.status, "aborted", "cancellation must be terminal, not just requested");
});

test("delegated lifecycle: first projection failure blocks requests and survives cancellation and cleanup", async (t) => {
  for (const [name, faults, executed, code] of [
    ["acceptance", { acceptance: true }, 0, "runtime_projection_failed"],
    ["result delivery", { delivery: true }, 1, "runtime_projection_failed"],
    ["first error retained", { acceptance: true, cancelAfterFailure: true, close: true }, 0, "runtime_projection_failed"],
    ["payload hook", { payload: true }, 0, "runtime_handler_failed"],
    ["before operation capture", { earlyProjection: true }, 0, "runtime_handler_failed"],
  ]) {
    await t.test(name, { timeout: 5_000 }, async (t) => {
      const run = createRun(t, [assistant([TOOL_CALL], "toolUse"), text("Must not be requested.")], faults);
      const result = await run.execute();
      assert.equal(result.status, "failed");
      assert.equal(result.errorFacts.code, code);
      assert.equal(result.errorDomain, "runtime_error");
      assert.equal(run.models.requested, faults.earlyProjection ? 0 : 1);
      assert.equal(run.executed.length, executed);
      assert.equal(run.executionAtClose.current, null);
      assert.equal(run.resultAtClose.status, "aborted");
      if (faults.close) {
        assert.match(result.error, /Nested acceptance failed first/);
        assert.ok(run.maintenance.some((failure) => failure.code === "sub_agent_cleanup_failed"));
      }
    });
  }
});

test("delegated lifecycle: only a nonempty final answer is successful", async (t) => {
  for (const [name, final, faults, code] of [
    ["empty", assistant([]), {}, "final_assistant_empty"],
    ["whitespace", text(" \n\t "), {}, "final_assistant_empty"],
    ["tool use with stop", assistant([{ type: "text", text: "Intermediate." }, TOOL_CALL]), { terminateTool: true }, "final_assistant_is_tool_use"],
    ["tool use", assistant([TOOL_CALL], "toolUse"), { terminateTool: true }, "final_assistant_is_tool_use"],
    ["truncated", assistant([{ type: "text", text: "Partial." }], "length", {
      usage: { ...assistant([]).usage, output: MODEL.maxTokens, totalTokens: MODEL.maxTokens + 1 },
    }), {}, "output_truncated"],
  ]) {
    await t.test(name, async (t) => {
      const run = createRun(t, [final], faults);
      const result = await run.execute();
      assert.equal(result.status, "failed");
      assert.equal(result.errorFacts.code, code);
      assert.equal(result.output, undefined);
      assert.equal(run.models.requested, 1);
      assert.equal(run.executionAtClose.current, null);
    });
  }
});

test("delegated lifecycle: user cancellation settles and closes the child", async (t) => {
  for (const alreadyAborted of [false, true]) {
    await t.test(alreadyAborted ? "before admission" : "during request", async (t) => {
      const run = createRun(t, [text("Not delivered.")], { cancelDuringRequest: !alreadyAborted });
      if (alreadyAborted) run.controller.abort(new Error("User cancelled."));
      const result = await run.execute();
      assert.equal(result.status, "cancelled");
      assert.equal(result.errorFacts.code, "sub_agent_cancelled");
      assert.equal(result.output, undefined);
      assert.equal(run.models.requested, alreadyAborted ? 0 : 1);
      if (run.executionAtClose !== undefined) assert.equal(run.executionAtClose.current, null);
    });
  }
});

test("delegated lifecycle: partial initialization and cleanup failure cannot leak success", async (t) => {
  for (const [name, faults, error] of [
    ["tool setup", { toolSetup: true }, /Tool setup failed/],
    ["harness creation", { harnessCreation: true }, /Harness creation failed/],
    ["lane acquisition", { laneAcquisition: true }, /Lane acquisition failed/],
    ["lane setup", { laneSetup: true }, /Lane setup failed/],
    ["partial subscriptions", { registration: true }, /Hook registration failed/],
    ["cleanup after completion", { close: true }, /Harness close failed/],
    ["cleanup after provider failure", { close: true, providerFailure: true }, /Provider refused/],
  ]) {
    await t.test(name, async (t) => {
      const response = faults.providerFailure
        ? assistant([], "error", { errorMessage: "Provider refused." })
        : text("Final answer.");
      const run = createRun(t, [response], faults);
      const result = await run.execute();
      assert.equal(result.status, "failed");
      assert.match(result.error, error);
      if (faults.close && !faults.providerFailure) {
        assert.equal(result.errorFacts.code, "sub_agent_cleanup_failed");
      }
      if (!faults.close) assert.equal(run.models.requested, 0);
    });
  }
});
