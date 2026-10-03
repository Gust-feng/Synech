import assert from "node:assert/strict";
import test from "node:test";

import { ORDINARY_AGENT } from "../dist/app/agent-prompts/ordinary-agent.js";
import { runAgentDefinitionRef } from "../dist/app/agent-definitions/agent-definition-ref.js";
import { createOrdinaryAgentRunResourceAcquirer } from "../dist/app/panel-server/ordinary/ordinary-agent-run-resources.js";

const MODEL_CONFIG = {
  profileId: "openai",
  providerKind: "openai_compatible",
  protocolKind: "openai_compatible_chat_completions",
  baseUrl: "https://example.invalid/v1",
  model: "test-model",
  defaultAiMode: "openai-compatible",
  secretRef: "test-secret",
  secretConfigured: true,
  updatedAt: "2026-09-02T00:00:00.000Z",
};

// The test model lives on an example.invalid endpoint with no declared pi
// provider, so its capability projection is the unconfirmed two-state fact.
const MODEL_CAPABILITIES = { facts: { status: "unconfirmed", modelId: "test-model" } };

function frozenDefinition() {
  return {
    ...ORDINARY_AGENT,
    prompt: {
      ...ORDINARY_AGENT.prompt,
      systemPrompt: "You are the ordinary Synech agent.",
    },
  };
}

test("Ordinary resource acquisition carries standing rules and implicit memory into the final model input", async () => {
  const definition = frozenDefinition();
  let resolverInput;
  let freezeCount = 0;
  let currentBackground = `[Memory — historical background]
- The project uses local durable storage.`;
  let released = 0;
  const loopConfigurations = [];
  const acquirer = createOrdinaryAgentRunResourceAcquirer({
    host: {
      configCenter: {
        async createModelRuntimeEnvironment() { return { SYNECH_MODEL_API_KEY: "test-key" }; },
      },
      processRegistry: { async cleanupByRun() { return { attempted: [], skipped: [] }; } },
    },
    sessionRepository: {
      async acquire(ref) {
        return {
          session: { metadata: { id: ref.sessionId } },
          async revokeTo() {},
          async release() { released += 1; },
        };
      },
    },
    async resolveAgentDefinition() { return definition; },
    async resolveMemoryBackground(input) {
      resolverInput = input;
      const block = currentBackground;
      return {
        initialBlock: block,
        resolvePerFreeze: async () => {
          freezeCount += 1;
          return currentBackground;
        },
      };
    },
    resolveSubAgentRoots: () => [],
  }, {
    async prepareHostResources(_host, input) {
      return {
        capabilitySnapshot: input.capabilitySnapshot,
        informationAccess: input.informationAccess,
        aiEnvironment: { SYNECH_MODEL_API_KEY: "test-key" },
        workspaceRoot: process.cwd(),
        toolStates: [],
        toolCatalogNames: [],
        toolCatalogAvailability: [],
        playwrightAvailable: false,
        toolRegistryScopes: ["agent-basic"],
        toolContributions: [],
        async release() { released += 1; },
      };
    },
    createProviderBinding() {
      return { modelRegistry: {}, selectedModel: {}, thinkingLevel: "off" };
    },
    createSessionLoop(input) {
      loopConfigurations.push(input);
      return {
        async execute() { throw new Error("The model loop must not run during message assembly coverage."); },
        async release() { released += 1; },
      };
    },
    createTokenCounter() {
      return {
        source: "openai_tiktoken",
        model: "test-model",
        tokenizerMatch: "fallback",
        countText: (text) => text.length,
        countMessage: (message) => message.content.length,
        countMessages: (messages) => messages.reduce((total, message) => total + message.content.length, 0),
      };
    },
    resolveToolBoundary() {
      return { allowedTools: [], allowedAgentToolNames: [], toolDefinitions: [] };
    },
  });

  const acquisition = {
    runId: "run-memory-input",
    conversationId: "conversation-memory-input",
    sessionRef: {
      sessionId: "session-memory-input",
      storageKey: "session-memory-input",
      sessionCwd: process.cwd(),
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    birth: {
      instructions: definition.prompt.systemPrompt,
      aiMode: "openai-compatible",
      config: MODEL_CONFIG,
      agentDefinitionRef: runAgentDefinitionRef(definition),
      capabilitySnapshot: {
        snapshotId: "snapshot-memory-input",
        createdAt: "2026-09-02T00:00:00.000Z",
        activeModel: MODEL_CONFIG,
        modelCapabilities: MODEL_CAPABILITIES,
        toolCatalog: { scope: "agent-basic", tools: [], allowedTools: [] },
        mcpCatalog: [],
        executionRoot: process.cwd(),
        warnings: [],
        skillCatalog: [],
        subAgentCatalog: [],
      },
      memoryOwner: { kind: "space", id: "space-memory-input" },
      ownerContext: "[Current conversation owner]\nname=Memory Space",
      collaborationRulesContext: "[Standing collaboration rules]\n- Keep responses concise and executable.",
      informationAccess: { web: { provider: "none", maxResults: 0, secretConfigured: false, status: "no-provider", updatedAt: "2026-09-02T00:00:00.000Z" } },
      accessPolicy: { policy: "ask" },
    },
    runInput: { userMessage: "What is the durable storage decision?" },
    abortSignal: new AbortController().signal,
    async acceptToolInvocations() { return []; },
    async acceptNestedToolInvocations() { return []; },
  };
  const run = await acquirer.acquire(acquisition);

  assert.equal(run.toolMetrics, undefined);
  assert.equal(loopConfigurations[0].onProviderToolDefinitionMetrics, undefined);
  const diagnosticRun = await acquirer.acquire({ ...acquisition, birth: { ...acquisition.birth, recordToolMetrics: true } });
  assert.ok(diagnosticRun.toolMetrics);
  assert.equal(typeof loopConfigurations[1].onProviderToolDefinitionMetrics, "function");
  await diagnosticRun.release();
  await diagnosticRun.releaseSession();
  try {
    // 绑定解析只携带 owner + conversationId（query-independent 的编译期证明）。
    assert.deepEqual(resolverInput, {
      owner: { kind: "space", id: "space-memory-input" },
      conversationId: "conversation-memory-input",
    });
    const modelUserMessage = run.resolvedMessages.find((message) => message.role === "user");
    assert.ok(modelUserMessage);
    const content = modelUserMessage.content;
    const ownerIndex = content.indexOf("[Current conversation owner]");
    const rulesIndex = content.indexOf("[Standing collaboration rules]");
    const requestIndex = content.indexOf("[Current user request]");
    assert.ok(ownerIndex >= 0);
    assert.ok(rulesIndex > ownerIndex);
    assert.ok(requestIndex > rulesIndex);
    assert.ok(content.endsWith("What is the durable storage decision?"));
    // 背景不再拼进 user 消息正文：由 session loop 的 per-freeze 贡献承载。
    assert.ok(!content.includes("[Memory — historical background]"));
    assert.ok(run.resolveMemoryBackgroundBlock, "loop options must carry the per-freeze background resolver");
    const block = await run.resolveMemoryBackgroundBlock();
    assert.ok(block.includes("[Memory — historical background]"));
    assert.ok(freezeCount === 1);
    // The Ordinary adapter follows each per-freeze boundary result without rebuilding
    // the run; actual deletion/revocation semantics are covered by the repository tests.
    currentBackground = block + `
[Memory sources]
source-1: deleted (original text cannot be reopened)`;
    const deletedSourceBlock = await run.resolveMemoryBackgroundBlock();
    assert.ok(deletedSourceBlock.includes("source-1: deleted"));
    assert.ok(deletedSourceBlock.startsWith(block));
    currentBackground = undefined;
    assert.equal(await run.resolveMemoryBackgroundBlock(), undefined);
    assert.equal(freezeCount, 3);
    assert.ok(!run.resolvedMessages.find(message => message.role === "user").content.includes("[Memory — historical background]"));
  } finally {
    await run.release();
  }
  assert.equal(released, 5);
});
