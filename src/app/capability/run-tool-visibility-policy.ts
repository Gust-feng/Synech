import type { AgentCapabilitySnapshot } from "../../domain/config/index.js";
import {
  modelVisibleToolDescription,
  type ToolDefinition,
  type ToolInputSchema,
  type ToolJsonSchema,
} from "../../domain/tools/index.js";
import type { AgentLoopToolVisibilityPlan } from "../model-runtime/agent-loop.js";
import {
  isProgressiveToolVisibilityCostEffective,
  progressiveToolVisibilityCostGate,
  type ModelVisibleToolDefinitionTokenCounter,
} from "../model-runtime/tool-definition-visibility-cost.js";
import {
  LOAD_MCP_TOOLS_CONTROL_NAME,
  SEARCH_MCP_TOOLS_CONTROL_NAME,
  TOOL_VISIBILITY_ACTIVATION_KIND,
} from "../model-runtime/tool-visibility-contract.js";

export {
  LOAD_MCP_TOOLS_CONTROL_NAME,
  SEARCH_MCP_TOOLS_CONTROL_NAME,
} from "../model-runtime/tool-visibility-contract.js";

const CONTROL_TOOL_NAMES = new Set([
  SEARCH_MCP_TOOLS_CONTROL_NAME,
  LOAD_MCP_TOOLS_CONTROL_NAME,
]);
const MAX_CONTROL_TOOL_NAME_CHARS = 128;
const MAX_CONTROL_SOURCE_LABEL_CHARS = 256;

export function resolveMcpFirstToolVisibilityPlan(input: {
  readonly snapshot: AgentCapabilitySnapshot;
  readonly executionAllowedToolNames: readonly string[];
  readonly allowedAgentToolNames: readonly string[];
  readonly frozenDefinitions: readonly ToolDefinition[];
  readonly toolDefinitionTokenCounter?: ModelVisibleToolDefinitionTokenCounter;
}): AgentLoopToolVisibilityPlan | undefined {
  const executionAllowed = new Set(input.executionAllowedToolNames);
  const agentTools = new Set(input.allowedAgentToolNames);
  const allowed = new Set([...executionAllowed, ...agentTools]);
  const frozenDefinitions = input.frozenDefinitions.filter((definition) => allowed.has(definition.name));
  const exposedMcpTools = exposedMcpToolsByName(input.snapshot);
  const deferredToolNames = new Set<string>();
  const deferredTools: AgentLoopToolVisibilityPlan["deferredTools"][number][] = [];

  for (const definition of frozenDefinitions) {
    // Pi AgentTools are feature-owned contributions even if a malformed catalog
    // happens to reuse an MCP canonical name.
    if (!executionAllowed.has(definition.name) || agentTools.has(definition.name)) {
      continue;
    }
    const exposed = exposedMcpTools.get(definition.name);
    if (exposed === undefined) {
      continue;
    }
    const definitionHash = exposed.tool.definitionHash;
    if (
      definitionHash === undefined ||
      definitionHash.trim().length === 0 ||
      definition.name.length > MAX_CONTROL_TOOL_NAME_CHARS ||
      exposed.serverId.length > MAX_CONTROL_TOOL_NAME_CHARS
    ) {
      continue;
    }
    deferredToolNames.add(definition.name);
    deferredTools.push({
      name: definition.name,
      displayName: compactCatalogText(
        exposed.tool.displayName,
        definition.name,
        MAX_CONTROL_SOURCE_LABEL_CHARS,
      ),
      description: modelVisibleToolDescription(definition),
      source: {
        kind: "mcp",
        id: exposed.serverId,
        label: compactCatalogText(
          exposed.serverLabel,
          exposed.serverId,
          MAX_CONTROL_SOURCE_LABEL_CHARS,
        ),
      },
      definitionHash,
    });
  }

  if (deferredTools.length === 0) {
    return undefined;
  }

  // Progressive visibility is only an optimization. A real frozen tool owns
  // its canonical name, so a control-name collision keeps every definition
  // directly visible instead of making run acquisition fail.
  if (frozenDefinitions.some((definition) => CONTROL_TOOL_NAMES.has(definition.name))) {
    return undefined;
  }

  const searchControl = searchMcpToolsDefinition();
  const loadControl = loadMcpToolsDefinition();
  const costGate = progressiveToolVisibilityCostGate(
    input.snapshot.modelCapabilities.contextWindowTokens,
    {
      api: input.snapshot.activeModel.protocolKind === "openai_compatible_chat_completions"
        ? "openai-completions"
        : "openai-responses",
      includeStrict: input.snapshot.modelCapabilities.protocolProfileId !== "deepseek" &&
        input.snapshot.modelCapabilities.protocolProfileId !== "moonshot" &&
        input.snapshot.modelCapabilities.protocolProfileId !== "minimax",
    },
  );
  if (input.toolDefinitionTokenCounter === undefined || costGate === undefined || !isProgressiveToolVisibilityCostEffective({
    directDefinitions: frozenDefinitions,
    deferredDefinitions: frozenDefinitions.filter((definition) => deferredToolNames.has(definition.name)),
    progressiveDefinitions: [
      ...frozenDefinitions.filter((definition) => !deferredToolNames.has(definition.name)),
      searchControl,
      loadControl,
    ],
    costGate,
    countTokens: input.toolDefinitionTokenCounter,
  })) {
    return undefined;
  }

  return {
    policyId: "mcp-progressive/v1",
    snapshotId: input.snapshot.snapshotId,
    costGate,
    initiallyVisibleToolNames: frozenDefinitions
      .filter((definition) => !deferredToolNames.has(definition.name))
      .map((definition) => definition.name),
    deferredTools,
    controls: {
      search: searchControl,
      load: loadControl,
    },
  };
}

function compactCatalogText(value: string, fallback: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim() || fallback;
  if (normalized.length <= maxChars) return normalized;
  const marker = " [truncated]";
  return normalized.slice(0, maxChars - marker.length).trimEnd() + marker;
}

type ExposedMcpTool = {
  readonly serverId: string;
  readonly serverLabel: string;
  readonly tool: AgentCapabilitySnapshot["mcpCatalog"][number]["exposedTools"][number];
};

function exposedMcpToolsByName(
  snapshot: AgentCapabilitySnapshot
): ReadonlyMap<string, ExposedMcpTool> {
  const tools = new Map<string, ExposedMcpTool>();
  for (const server of snapshot.mcpCatalog) {
    // MCP executors connect lazily. A configured frozen server with exposed,
    // execution-allowed definitions is eligible before any live connection;
    // loading a definition must not connect to the server.
    if (!server.enabled || server.availability !== "configured") {
      continue;
    }
    for (const tool of server.exposedTools) {
      if (!tools.has(tool.name)) {
        tools.set(tool.name, {
          serverId: server.serverId,
          serverLabel: server.label,
          tool,
        });
      }
    }
  }
  return tools;
}

function searchMcpToolsDefinition(): ToolDefinition {
  const inputSchema: ToolInputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 200,
      },
      server_id: {
        type: "string",
        minLength: 1,
        maxLength: 128,
      },
      cursor: {
        type: "integer",
        minimum: 0,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 10,
      },
    },
    additionalProperties: false,
  };
  const outputSchema: ToolJsonSchema = {
    type: "object",
    properties: {
      matches: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 128 },
            displayName: { type: "string", minLength: 1, maxLength: 256 },
            description: { type: "string", minLength: 1, maxLength: 512 },
            source: {
              type: "object",
              properties: {
                kind: { const: "mcp" },
                id: { type: "string", minLength: 1, maxLength: 128 },
                label: { type: "string", minLength: 1, maxLength: 256 },
              },
              required: ["kind", "id", "label"],
              additionalProperties: false,
            },
            loaded: { type: "boolean" },
          },
          required: ["name", "displayName", "description", "source", "loaded"],
          additionalProperties: false,
        },
      },
      totalMatches: { type: "integer", minimum: 0 },
      returned: { type: "integer", minimum: 0, maximum: 20 },
      continuation: {
        type: "object",
        properties: {
          nextInput: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1, maxLength: 200 },
              server_id: { type: "string", minLength: 1, maxLength: 128 },
              cursor: { type: "integer", minimum: 0 },
              limit: { type: "integer", minimum: 1, maximum: 20 },
            },
            required: ["cursor", "limit"],
            additionalProperties: false,
          },
        },
        required: ["nextInput"],
        additionalProperties: false,
      },
    },
    required: ["matches", "totalMatches", "returned"],
    additionalProperties: false,
  };
  return {
    name: SEARCH_MCP_TOOLS_CONTROL_NAME,
    description: "Search the frozen MCP tool catalog for this run. This does not connect to an MCP server, load a tool schema, or execute a remote tool.",
    inputSchema,
    outputSchema,
    metadata: {
      category: "mcp",
      riskLevel: "low",
      operationType: "read-only",
      requiresConfirmation: false,
    },
  };
}

function loadMcpToolsDefinition(): ToolDefinition {
  return {
    name: LOAD_MCP_TOOLS_CONTROL_NAME,
    description: "Make complete definitions for authorized frozen MCP tools visible starting with the next model request. This does not execute a remote tool or expand run permissions.",
    inputSchema: {
      type: "object",
      properties: {
        tool_names: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 128,
          },
        },
      },
      required: ["tool_names"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        kind: { const: TOOL_VISIBILITY_ACTIVATION_KIND },
        activatedToolNames: {
          type: "array",
          maxItems: 16,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
        alreadyLoaded: {
          type: "array",
          maxItems: 16,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
        remainingDeferredToolCount: { type: "integer", minimum: 0 },
        availableFrom: { const: "next_model_request" },
      },
      required: [
        "kind",
        "activatedToolNames",
        "alreadyLoaded",
        "remainingDeferredToolCount",
        "availableFrom",
      ],
      additionalProperties: false,
    },
    metadata: {
      category: "mcp",
      riskLevel: "low",
      operationType: "read-write",
      requiresConfirmation: false,
    },
  };
}
