import assert from "node:assert/strict";
import test from "node:test";

import { createDelegatedAgentTool } from "../dist/adapters/intelligence/agent-session-loop/delegated-agent-runner.js";
import { ToolInvocationBindingTable } from "../dist/adapters/intelligence/agent-session-tool-bindings.js";
import { mergeModelUsage } from "../dist/adapters/intelligence/agent-session-provider-timing.js";

test("delegated runner rejects a nested execution whose accepted input changed", async () => {
  const fixture = runnerFixture({
    acceptNested(calls) {
      return calls.map((call) => ({ ...call, input: { path: "accepted.md" }, invocationId: "nested-invocation" }));
    },
    async scenario(harness) {
      await harness.emit(nestedAssistantEvent({ path: "actual.md" }));
      await harness.tool("Read").execute("nested-call", { path: "actual.md" });
      return completedAssistant("unreachable");
    },
  });

  const projected = await fixture.execute();
  assert.equal(projected.result.status, "failed");
  assert.equal(projected.result.errorFacts.code, "sub_agent_execution_failed");
  assert.equal(fixture.mechanicalExecutions, 0);
});

test("nested acceptance rejection publishes neither binding nor pending execution", async () => {
  const fixture = runnerFixture({
    acceptNested() { throw new Error("nested acceptance rejected"); },
    async scenario(harness) {
      await assert.rejects(harness.emit(nestedAssistantEvent({ path: "README.md" })), /nested acceptance rejected/u);
      await assert.rejects(
        harness.tool("Read").execute("nested-call", { path: "README.md" }),
        /before owner binding/u,
      );
      await assert.rejects(harness.emit(nestedExecutionEnd()), /without the matching accepted/u);
      throw new Error("nested acceptance rejected");
    },
  });

  const projected = await fixture.execute();
  assert.equal(projected.result.status, "failed");
  assert.equal(fixture.mechanicalExecutions, 0);
  assert.equal(fixture.acceptedObservedResults.length, 0);
});

test("delegated usage accumulates without replacing the parent latest request", async () => {
  const parentLatest = { inputTokens: 7, outputTokens: 3, totalTokens: 10 };
  const fixture = runnerFixture({
    rootUsage: { requestCount: 1, inputTokens: 7, latestAgentRequest: parentLatest },
    async scenario(harness) {
      await harness.emit({ type: "message_end", message: completedAssistant("child") });
      return completedAssistant("done");
    },
  });

  const projected = await fixture.execute();
  assert.equal(projected.result.status, "completed");
  assert.equal(fixture.rootUsage.latestAgentRequest, parentLatest);
  assert.equal(fixture.rootUsage.requestCount, 2);
  assert.equal(fixture.rootUsage.inputTokens, 17);
});

test("delegated abort returns a cancelled fact and removes its listener", async () => {
  const signal = trackedAbortSignal();
  const fixture = runnerFixture({
    signal,
    async scenario() {
      signal.abort("stop child");
      return { ...completedAssistant(""), stopReason: "aborted", errorMessage: "stop child" };
    },
  });

  const projected = await fixture.execute();
  assert.equal(projected.result.status, "cancelled");
  assert.equal(projected.result.errorFacts.code, "sub_agent_cancelled");
  assert.equal(signal.added, 1);
  assert.equal(signal.removed, 1);
});

test("delegated delivery rejection becomes the established delivery failure fact", async () => {
  const fixture = runnerFixture({
    deliverResult() { throw new Error("store unavailable"); },
    async scenario() { return completedAssistant("done"); },
  });

  const projected = await fixture.execute();
  assert.equal(projected.result.status, "failed");
  assert.equal(projected.result.errorFacts.code, "sub_agent_result_delivery_failed");
  assert.match(projected.result.error, /store unavailable/u);
});

function runnerFixture(options = {}) {
  const rootBindings = new ToolInvocationBindingTable();
  rootBindings.remember({ providerCallId: "outer-call", invocationId: "outer-invocation" });
  let mechanicalExecutions = 0;
  const acceptedObservedResults = [];
  let rootUsage = options.rootUsage ?? {};
  const maintenance = [];
  const signal = options.signal ?? new AbortController().signal;
  let fakeHarness;

  const gateway = {
    has(name) { return name === "Read" || name === "Delegate"; },
    preflight(request) { return { status: "ready", request }; },
    async execute(request) {
      mechanicalExecutions += 1;
      return { ...request, status: "completed", output: { ok: true }, durationMs: 1 };
    },
    async deliverResult(result) {
      return options.deliverResult?.(result) ?? result;
    },
  };
  const tools = {
    definitions: [toolDefinition("Delegate"), toolDefinition("Read")],
    gateway,
    context: { callerAgentId: "root-agent", traceId: "trace-1", goalId: "goal-1" },
    permission: { callerAgentId: "root-agent", allowedTools: ["Delegate", "Read"] },
  };
  const facts = {
    results: {
      async acceptObserved(result) { acceptedObservedResults.push(result); },
      async deliverPendingMessage() {},
      async acceptForDelivery() { return undefined; },
      project(result, terminate) { return { result, terminate }; },
    },
    run: {
      emitToolRequested() {},
      observeUsage(usage) {
        rootUsage = mergeModelUsage(rootUsage, usage, { preserveLatestAgentRequest: true });
      },
      recordToolRequestAcceptanceFailure(error) { maintenance.push(error); },
      hasBlockingFailure() { return maintenance.length > 0; },
      isCancellationRequested() { return signal.aborted; },
    },
    maintenance: {
      record(failure) { maintenance.push(failure); },
      fail(code, error) {
        maintenance.push({ code, error });
        throw new Error(error);
      },
    },
  };
  const tool = createDelegatedAgentTool({
    definition: toolDefinition("Delegate"),
    contribution: {
      toolName: "Delegate",
      async resolve() {
        return {
          agentName: "child",
          instructions: "Handle the delegated work.",
          input: "child input",
          callerAgentId: "child-agent",
          allowedTools: ["Read"],
        };
      },
    },
    loopInput: {
      tools,
      agentTools: [],
      abortSignal: signal,
      acceptNestedToolInvocations: async (calls) => options.acceptNested?.(calls)
        ?? calls.map((call) => ({ ...call, invocationId: "nested-invocation" })),
    },
    options: {
      executionEnvironment: {},
      modelRegistry: {},
      selectedModel: { input: ["text"] },
    },
    rootBindings,
    resultGateway: gateway,
    createMechanicalTool({ definition, bindings, assertAccepted }) {
      return {
        name: definition.name,
        label: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
        executionMode: "parallel",
        async execute(callId, parameters) {
          const binding = bindings.get(callId);
          if (binding === undefined) throw new Error("nested call reached execution before owner binding");
          const request = {
            providerCallId: callId,
            invocationId: binding.invocationId,
            parentInvocationId: binding.parentInvocationId,
            toolName: definition.name,
            input: parameters,
          };
          assertAccepted(request);
          mechanicalExecutions += 1;
          return { content: [{ type: "text", text: "done" }] };
        },
      };
    },
    facts,
    dependencies: {
      async createSession() {
        return { async getLeafId() { return "child-entry-1"; } };
      },
      createHarness(harnessOptions) {
        fakeHarness = new FakeHarness(harnessOptions, options.scenario);
        return fakeHarness;
      },
    },
  });

  return {
    async execute() {
      return await tool.execute("outer-call", { task: "delegate" }, signal);
    },
    get mechanicalExecutions() { return mechanicalExecutions; },
    get acceptedObservedResults() { return acceptedObservedResults; },
    get rootUsage() { return rootUsage; },
  };
}

class FakeHarness {
  constructor(options, scenario) {
    this.options = options;
    this.scenario = scenario;
    this.activeToolNames = [...options.activeToolNames];
    this.hooks = new Map();
  }

  on(name, handler) { this.hooks.set(name, handler); }
  subscribe(handler) { this.subscriber = handler; }
  async setActiveTools(names) { this.activeToolNames = [...names]; }
  getActiveTools() { return this.options.tools.filter((tool) => this.activeToolNames.includes(tool.name)); }
  getModel() { return this.options.model; }
  getThinkingLevel() { return this.options.thinkingLevel; }
  async abort() {}
  async prompt() { return await this.scenario(this); }
  async emit(event) { return await this.subscriber(event); }
  tool(name) { return this.options.tools.find((tool) => tool.name === name); }
}

function toolDefinition(name) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    metadata: { category: "other", riskLevel: "low", operationType: "read-only", requiresConfirmation: false },
  };
}

function nestedAssistantEvent(input) {
  return {
    type: "message_end",
    message: {
      ...completedAssistant(""),
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "nested-call", name: "Read", arguments: input }],
    },
  };
}

function nestedExecutionEnd() {
  return {
    type: "tool_execution_end",
    toolCallId: "nested-call",
    toolName: "Read",
    result: { content: [{ type: "text", text: "done" }], details: undefined },
  };
}

function completedAssistant(text) {
  return {
    role: "assistant",
    content: text.length === 0 ? [] : [{ type: "text", text }],
    stopReason: "stop",
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

function trackedAbortSignal() {
  const listeners = new Set();
  return {
    aborted: false,
    reason: undefined,
    added: 0,
    removed: 0,
    addEventListener(_name, listener) { this.added += 1; listeners.add(listener); },
    removeEventListener(_name, listener) { this.removed += 1; listeners.delete(listener); },
    abort(reason) {
      this.aborted = true;
      this.reason = reason;
      for (const listener of [...listeners]) listener();
    },
  };
}
