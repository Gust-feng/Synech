import assert from "node:assert/strict";
import test from "node:test";

import { handlePanelConfigRoute } from "../dist/app/panel-server/settings/config-routes.js";

test("config route keeps the product snapshot at the composition entry", async () => {
  const runtime = configRuntime();
  const response = responseRecorder();

  assert.equal(await handlePanelConfigRoute(
    runtime,
    { method: "GET" },
    response,
    new URL("http://panel.test/api/config"),
  ), true);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.product.defaultEntry, "Workbench");
  assert.equal("runtimeMode" in response.body.product, false);
  assert.equal(response.body.config.profileId, "profile-1");
});

test("config composition delegates model, tool, and MCP GET routes without changing payloads", async () => {
  const runtime = configRuntime();
  const cases = [
    ["/api/config/model-profiles", "profiles", []],
    ["/api/config/tools", "tools", {
      webSearch: runtime.webSearch,
      catalog: runtime.toolCatalog,
    }],
    ["/api/config/mcp", "catalog", runtime.capabilitySnapshot.mcpCatalog],
  ];

  for (const [pathname, key, expected] of cases) {
    const response = responseRecorder();
    assert.equal(await handlePanelConfigRoute(
      runtime,
      { method: "GET" },
      response,
      new URL(`http://panel.test${pathname}`),
    ), true);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body[key], expected);
  }
});

test("config composition leaves unrelated routes untouched", async () => {
  const response = responseRecorder();
  assert.equal(await handlePanelConfigRoute(
    configRuntime(),
    { method: "GET" },
    response,
    new URL("http://panel.test/api/conversations"),
  ), false);
  assert.equal(response.body, undefined);
});

function configRuntime() {
  const profile = {
    profileId: "profile-1",
    providerKind: "openai_compatible",
    protocolKind: "openai_responses",
    baseUrl: "https://example.test/v1",
    defaultAiMode: "openai-responses",
    secretRef: "secret:model-provider:profile-1",
    secretConfigured: true,
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const webSearch = {
    provider: "none",
    maxResults: 5,
    secretConfigured: false,
    status: "no-provider",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const toolCatalog = { scope: "agent-basic", tools: [], allowedTools: [] };
  const capabilitySnapshot = {
    snapshotId: "snapshot-1",
    createdAt: "2026-08-24T00:00:00.000Z",
    activeModel: profile,
    modelCapabilities: {},
    toolCatalog: { scope: "agent-basic", tools: [], allowedTools: [] },
    skillCatalog: [],
    subAgentCatalog: [],
    skillTrigger: {},
    mcpCatalog: [{ serverId: "mcp-1" }],
    executionRoot: "Z:/workspace",
    commandShell: {},
    toolConfirmation: {},
    warnings: [],
  };
  return {
    webSearch,
    toolCatalog,
    capabilitySnapshot,
    configDirectory: "Z:/product/config",
    managedMcpBinDirectory: "Z:/product/state/runtime-tools/mcp/bin",
    productPaths: {
      productHome: "Z:/product",
      state: { runtimeTools: { mcp: { bin: "Z:/product/state/runtime-tools/mcp/bin" } } },
    },
    configCenter: {
      async getModelProviderConfig() { return profile; },
      async listModelProviderProfiles() { return []; },
      async getModelProviderOrder() { return []; },
      async listModelProviderModelCatalogs() { return []; },
      async listModelCapabilityOverrides() { return []; },
      async getInformationAccessConfig() { return {}; },
      async getCommandShellConfig() { return {}; },
      async getToolConfirmationConfig() { return {}; },
      async getOrdinaryAgentPromptConfig() { return {}; },
      async getSkillTriggerConfig() { return {}; },
      async getWebSearchConfig() { return webSearch; },
    },
    capabilityCenter: {
      async snapshot() { return capabilitySnapshot; },
      async toolCatalog() { return toolCatalog; },
      invalidate() {},
    },
  };
}

function responseRecorder() {
  return {
    statusCode: undefined,
    body: undefined,
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(value) {
      this.body = JSON.parse(String(value));
    },
  };
}
