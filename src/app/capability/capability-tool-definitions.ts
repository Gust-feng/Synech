import type { AgentCapabilitySnapshot, CapabilityToolCatalogItem } from "../../domain/config/index.js";
import {
  cloneToolInputSchema,
  cloneToolJsonSchema,
  type ToolDefinition,
  type ToolInputSchema,
} from "../../domain/tools/index.js";

export function frozenToolDefinitionsForRun(input: {
  readonly snapshot: AgentCapabilitySnapshot | undefined;
  readonly allowedTools: readonly string[];
}): readonly ToolDefinition[] {
  if (input.snapshot === undefined || input.allowedTools.length === 0) {
    return [];
  }
  const allowed = new Set(input.allowedTools);
  return input.snapshot.toolCatalog.tools
    .filter((tool) => allowed.has(tool.name))
    .map(toolDefinitionFromCapabilityTool);
}

export function toolDefinitionFromCapabilityTool(tool: CapabilityToolCatalogItem): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: cloneInputSchema(tool),
    outputSchema:
      tool.outputSchema === undefined
        ? undefined
        : cloneToolJsonSchema(tool.outputSchema),
    metadata: {
      category: tool.category,
      riskLevel: tool.riskLevel,
      operationType: tool.operationType,
      fileOperation: tool.fileOperation,
      requiresConfirmation: tool.requiresConfirmation,
      runtimeHints:
        tool.runtimeHints === undefined
          ? undefined
          : globalThis.structuredClone(tool.runtimeHints),
    },
  };
}

function cloneInputSchema(tool: CapabilityToolCatalogItem): ToolInputSchema {
  if (tool.inputSchema === undefined) {
    throw new Error(`Frozen tool ${tool.name} is missing its input schema.`);
  }
  return cloneToolInputSchema(tool.inputSchema);
}
