import assert from "node:assert/strict";
import test from "node:test";

import { LazyMcpToolExecutorProvider } from "../dist/adapters/mcp/mcp-lazy-tool-provider.js";
import { CapabilityCenter } from "../dist/app/capability/capability-center.js";

const now = "2026-01-01T00:00:00.000Z";

test("Capability snapshot and Lazy executor reject the same oversized cached MCP catalog", async () => {
  const server = mcpServer(Array.from({ length: 129 }, (_value, index) => cachedTool(`tool-${index}`)));

  await assert.rejects(
    capabilitySnapshot(server),
    (error) => error?.code === "mcp_catalog_limit_exceeded" && error.unit === "items" && error.observed === 129,
  );
  assert.throws(
    () => new LazyMcpToolExecutorProvider({ servers: [server] }),
    (error) => error?.code === "mcp_catalog_limit_exceeded" && error.unit === "items" && error.observed === 129,
  );
});

test("Capability snapshot and Lazy executor reject duplicate cached MCP tool identities", async () => {
  const server = mcpServer([cachedTool("inspect"), cachedTool("inspect")]);

  await assert.rejects(capabilitySnapshot(server), /duplicate tool server__inspect/u);
  assert.throws(
    () => new LazyMcpToolExecutorProvider({ servers: [server] }),
    /duplicate tool server__inspect/u,
  );
});

function cachedTool(name) {
  return {
    name,
    description: `Call ${name}`,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  };
}

function mcpServer(cachedTools) {
  return {
    serverId: "server",
    label: "Server",
    transport: "stdio",
    command: "node",
    args: [],
    envSecretRefs: [],
    confirmationMode: "never",
    toolExposureMode: "all",
    enabledTools: [],
    autoApprovedTools: [],
    enabled: true,
    cachedTools,
    toolsCachedAt: now,
    updatedAt: now,
  };
}

async function capabilitySnapshot(server) {
  const center = new CapabilityCenter({
    configCenter: {
      getModelProviderConfig: async () => ({
        profileId: "model",
        label: "Model",
        providerKind: "openai_compatible",
        protocolKind: "openai_compatible_chat_completions",
        baseUrl: "https://example.test/v1",
        model: "model",
        defaultAiMode: "openai-compatible",
        secretRef: "secret://model",
        enabled: true,
        secretConfigured: true,
        updatedAt: now,
      }),
      listModelCapabilityOverrides: async () => [],
      listToolStates: async () => [],
      getToolConfirmationConfig: async () => undefined,
      getSkillTriggerConfig: async () => undefined,
      listMcpServers: async () => [server],
      getCommandShellConfig: async () => undefined,
      createModelRuntimeEnvironment: async () => ({}),
      resolveWebSearchRuntimeConfig: async () => undefined,
    },
    skillRoots: [],
    subAgentRoots: [],
    resolveModelCapabilities: () => ({
      contextWindowTokens: 16_384,
      maxOutputTokens: 4_096,
      supportsToolCalling: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutputs: true,
      supportsStreaming: true,
      supportsVisionInput: false,
      supportsReasoningEffort: false,
      preferredApiStyle: "chat_completions",
      stability: "stable",
    }),
  });
  return center.snapshot({ executionRoot: process.cwd() });
}
