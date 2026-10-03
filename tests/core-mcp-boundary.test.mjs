import assert from "node:assert/strict";
import test from "node:test";

import { McpCatalogLimitError } from "../dist/adapters/mcp/index.js";
import { LazyMcpToolExecutorProvider } from "../dist/adapters/mcp/mcp-lazy-tool-provider.js";

test("MCP catalog limit errors remain structured", () => {
  const error = new McpCatalogLimitError("tools", "items", 11, 10);
  assert.equal(error.code, "mcp_catalog_limit_exceeded");
  assert.equal(error.catalogKind, "tools");
  assert.equal(error.observed, 11);
  assert.equal(error.limit, 10);
});

const cachedTool = {
  name: "inspect", inputSchema: { type: "object", properties: { value: { type: "string" } } },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const context = { callerAgentId: "ordinary", traceId: "mcp-run", goalId: "mcp-goal",
  invocationId: "mcp-invocation", providerCallId: "mcp-call" };

function lazyFixture() {
  let connected = false;
  const state = { catalog: [structuredClone(cachedTool)], connects: 0, catalogs: 0, calls: 0 };
  const client = {
    isConnected: () => connected,
    async connect() { state.connects += 1; connected = true; },
    async disconnect() { connected = false; },
    async listTools() { state.catalogs += 1; return structuredClone(state.catalog); },
    async callTool() { state.calls += 1; return { content: [{ type: "text", text: "ok" }] }; },
  };
  const provider = new LazyMcpToolExecutorProvider({ servers: [{
    serverId: "local-test", enabled: true, transport: "stdio", command: "unused",
    cachedTools: [cachedTool], confirmationMode: "auto", autoApprovedTools: [],
    toolExposureMode: "all", enabledTools: [], envSecretRefs: [],
  }] }, { createClient: () => client });
  return { state, client, provider, tool: provider.getToolsForRegistry()[0] };
}

test("lazy MCP shares live catalog validation and revalidates after reconnect", async () => {
  const { state, client, provider, tool } = lazyFixture();
  try {
    await Promise.all([tool.execute({ value: "first" }, context), tool.execute({ value: "second" }, context)]);
    assert.equal(state.connects, 1);
    assert.equal(state.catalogs, 1);
    assert.equal(state.calls, 2);
    await client.disconnect();
    state.catalog[0].annotations.readOnlyHint = false;
    await assert.rejects(tool.execute({}, context), (error) => error.code === "mcp_tool_contract_changed");
    assert.equal(state.connects, 2);
    assert.equal(state.catalogs, 2);
    assert.equal(state.calls, 2);
  } finally { await provider.disconnectAll(); }
});

test("lazy MCP rejects a changed or missing frozen contract before execution", async (t) => {
  for (const kind of ["schema", "effect", "missing"]) await t.test(kind, async () => {
    const { state, provider, tool } = lazyFixture();
    if (kind === "schema") state.catalog[0].inputSchema.properties.value = { type: "number" };
    if (kind === "effect") state.catalog[0].annotations.destructiveHint = true;
    if (kind === "missing") state.catalog = [];
    try {
      await assert.rejects(tool.execute({}, context), (error) =>
        error.code === "mcp_tool_contract_changed" && error.facts.sourceExecutionStatus === "not_started");
      assert.equal(state.calls, 0);
    } finally { await provider.disconnectAll(); }
  });
});

test("unrelated MCP catalog changes do not invalidate the selected tool", async () => {
  const { state, provider, tool } = lazyFixture();
  state.catalog.push({ name: "unrelated", inputSchema: { type: "object", properties: {} } });
  try {
    const result = await tool.execute({}, context);
    assert.equal(result.output.content[0].text, "ok");
    assert.equal(state.calls, 1);
  } finally { await provider.disconnectAll(); }
});
