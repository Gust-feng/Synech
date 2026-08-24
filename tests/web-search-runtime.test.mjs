import assert from "node:assert/strict";
import test from "node:test";

import { toWebSearchRuntimeConfig } from "../dist/app/config-center/projections.js";
import { createAgentToolRegistry } from "../dist/app/tool-center/builtin-tool-runtime.js";

const baseWebConfig = {
  maxResults: 5,
  secretConfigured: false,
  status: "disabled",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("configured external search is catalogued and executable", async () => {
  const runtimeConfig = await toWebSearchRuntimeConfig({
    web: {
      ...baseWebConfig,
      provider: "tavily",
      providerKind: "tavily",
      secretRef: "secret://web/tavily",
      secretConfigured: true,
      status: "ready",
    },
    secretStore: {
      readSecret: async (ref) => ref === "secret://web/tavily" ? "search-key" : undefined,
    },
  });
  assert.ok(runtimeConfig);

  const registry = createAgentToolRegistry({
    webSearch: runtimeConfig,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ title: "Synech", url: "https://example.test", content: "Result" }],
      }),
    }),
  });
  assert.equal(registry.catalog("agent-basic").tools.some((tool) => tool.name === "WebSearch"), true);

  const center = registry.createToolCenter("agent-basic");
  const result = await center.execute(
    { callId: "call-search", toolName: "WebSearch", input: { query: "Synech" } },
    { callerAgentId: "ordinary", traceId: "trace", goalId: "goal" },
    { callerAgentId: "ordinary", allowedTools: ["WebSearch"] },
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output.status, "completed");
  assert.equal(result.output.provider, "tavily");
  assert.equal(result.output.results[0].title, "Synech");
});

for (const provider of ["none", "model_builtin"]) {
  test(`${provider} does not register an external WebSearch executor`, async () => {
    const runtimeConfig = await toWebSearchRuntimeConfig({
      web: { ...baseWebConfig, provider },
      secretStore: { readSecret: async () => undefined },
    });
    assert.equal(runtimeConfig, undefined);
    const registry = createAgentToolRegistry({ webSearch: runtimeConfig });
    assert.equal(registry.catalog("agent-basic").tools.some((tool) => tool.name === "WebSearch"), false);
  });
}
