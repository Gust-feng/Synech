import assert from "node:assert/strict";
import test from "node:test";

import {
  activeToolNamesAfterVisibilityChange,
  createToolVisibilitySession,
  searchDeferredToolCatalog,
  validateToolVisibilityPlan,
} from "../dist/adapters/intelligence/tool-visibility-session.js";

const searchControl = toolDefinition("McpSearch");
const loadControl = toolDefinition("McpLoad");

test("deferred tool catalog search filters, paginates, and reports loaded tools", () => {
  const output = searchDeferredToolCatalog({
    search: { query: "docs", cursor: 0, limit: 1 },
    deferredTools: [
      deferredTool("docs__read", "Read docs", "Read a documentation page", "docs", "Docs"),
      deferredTool("docs__search", "Search docs", "Search documentation", "docs", "Docs"),
      deferredTool("issues__search", "Search issues", "Search issue tracker", "issues", "Issues"),
    ],
    activeToolNames: ["docs__read"],
  });

  assert.deepEqual(output, {
    matches: [{
      name: "docs__read",
      displayName: "Read docs",
      description: "Read a documentation page",
      source: { kind: "mcp", id: "docs", label: "Docs" },
      loaded: true,
    }],
    totalMatches: 2,
    returned: 1,
    continuation: {
      nextInput: { query: "docs", cursor: 1, limit: 1 },
    },
  });
});

test("visibility controls remain until every deferred tool is active", () => {
  const controlToolNames = ["McpSearch", "McpLoad"];

  assert.deepEqual(activeToolNamesAfterVisibilityChange({
    activeNames: ["Read", "RemoteA", ...controlToolNames],
    deferredToolNames: ["RemoteA", "RemoteB"],
    controlToolNames,
  }), ["Read", "RemoteA", "McpSearch", "McpLoad"]);

  assert.deepEqual(activeToolNamesAfterVisibilityChange({
    activeNames: ["Read", "RemoteA", "RemoteB", ...controlToolNames],
    deferredToolNames: ["RemoteA", "RemoteB"],
    controlToolNames,
  }), ["Read", "RemoteA", "RemoteB"]);
});

test("visibility plan must partition the frozen run tool names exactly", () => {
  const plan = visibilityPlan({
    initiallyVisibleToolNames: ["Read"],
    deferredTools: [deferredTool("docs__read", "Read docs", "Read documentation", "docs", "Docs")],
  });
  assert.doesNotThrow(() => validateToolVisibilityPlan(plan, ["Read", "docs__read"]));

  assert.throws(
    () => validateToolVisibilityPlan({
      ...plan,
      initiallyVisibleToolNames: ["Read", "docs__read"],
    }, ["Read", "docs__read"]),
    /places docs__read in both partitions/u,
  );
  assert.throws(
    () => validateToolVisibilityPlan(plan, ["Read", "docs__read", "Write"]),
    /missing: Write/u,
  );
});

test("loading the last deferred tool updates the harness and commits one activation fact", async () => {
  const plan = visibilityPlan({
    initiallyVisibleToolNames: ["Read"],
    deferredTools: [deferredTool("docs__read", "Read docs", "Read documentation", "docs", "Docs")],
  });
  const accepted = [];
  let activeNames;
  const toolSet = createToolVisibilitySession({
    tools: [agentTool("Read"), agentTool("docs__read")],
    metadataByName: new Map(),
    visibilityPlan: plan,
    host: visibilityHost({ accepted }),
  });
  activeNames = [...toolSet.activeToolNames];
  const harness = {
    getActiveTools: () => toolSet.tools.filter((tool) => activeNames.includes(tool.name)),
    setActiveTools: async (names) => { activeNames = [...names]; },
  };
  toolSet.bind(harness);

  const load = toolSet.tools.find((tool) => tool.name === "McpLoad");
  const response = await load.execute("load-1", { tool_names: ["docs__read"] });

  assert.deepEqual(activeNames, ["Read", "docs__read"]);
  assert.deepEqual(response.addedToolNames, ["docs__read"]);
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].output, {
    kind: "tool_visibility_activation",
    activatedToolNames: ["docs__read"],
    alreadyLoaded: [],
    remainingDeferredToolCount: 0,
    availableFrom: "next_model_request",
  });
});

test("an aborted visibility control commits a cancelled result and terminates its tool turn", async () => {
  const abortController = new AbortController();
  abortController.abort(new Error("run stopped"));
  const accepted = [];
  const toolSet = createToolVisibilitySession({
    tools: [agentTool("Read"), agentTool("docs__read")],
    metadataByName: new Map(),
    visibilityPlan: visibilityPlan({
      initiallyVisibleToolNames: ["Read"],
      deferredTools: [deferredTool("docs__read", "Read docs", "Read documentation", "docs", "Docs")],
    }),
    host: visibilityHost({ accepted, abortSignal: abortController.signal }),
  });
  const activeNames = [...toolSet.activeToolNames];
  toolSet.bind({
    getActiveTools: () => toolSet.tools.filter((tool) => activeNames.includes(tool.name)),
    setActiveTools: async () => {},
  });

  const search = toolSet.tools.find((tool) => tool.name === "McpSearch");
  const response = await search.execute("search-1", {});

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].status, "cancelled");
  assert.equal(accepted[0].errorFacts.code, "tool_visibility_control_cancelled");
  assert.equal(response.terminate, true);
  assert.equal(response.details.result.status, "cancelled");
});

function visibilityPlan(overrides) {
  return {
    policyId: "mcp-progressive/v1",
    snapshotId: "snapshot",
    costGate: {},
    initiallyVisibleToolNames: [],
    deferredTools: [],
    controls: { search: searchControl, load: loadControl },
    ...overrides,
  };
}

function deferredTool(name, displayName, description, serverId, serverLabel) {
  return {
    name,
    displayName,
    description,
    source: { kind: "mcp", id: serverId, label: serverLabel },
    definitionHash: `${name}-hash`,
  };
}

function toolDefinition(name) {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    metadata: { operationType: "read" },
  };
}

function agentTool(name) {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  };
}

function visibilityHost({ accepted, abortSignal = new AbortController().signal }) {
  return {
    abortSignal,
    onToolRequested: () => {},
    acceptResult: async (result) => {
      accepted.push(structuredClone(result));
      return undefined;
    },
    projectResult: (result, terminate, addedToolNames) => ({
      content: [],
      details: { kind: "result", result: structuredClone(result) },
      ...(terminate ? { terminate: true } : {}),
      ...(addedToolNames === undefined ? {} : { addedToolNames: [...addedToolNames] }),
    }),
    recordMaintenanceFailure: (failure) => {
      throw new Error(`Unexpected maintenance failure: ${failure.error}`);
    },
  };
}
