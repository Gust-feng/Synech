import type { McpConfirmationMode } from "../config/index.js";
import {
  canonicalNamespacedToolName,
  cloneToolInputSchema,
  cloneToolJsonSchema,
  type ToolDefinition,
  type ToolDefinitionMetadata,
} from "../tools/index.js";

export type CachedMcpToolDefinition = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
};

export type McpToolConfirmationStrategy = {
  readonly confirmationMode: McpConfirmationMode;
  readonly autoApprovedTools: readonly string[];
};

export const DEFAULT_MCP_MAX_TOOL_CATALOG_ITEMS = 128;
export const DEFAULT_MCP_MAX_TOOL_CATALOG_BYTES = 128 * 1024;

export type McpCatalogLimitUnit = "items" | "serialized_bytes";

export class McpCatalogLimitError extends Error {
  readonly code = "mcp_catalog_limit_exceeded";

  constructor(
    readonly catalogKind: string,
    readonly unit: McpCatalogLimitUnit,
    readonly observed: number,
    readonly limit: number,
  ) {
    super(`MCP ${catalogKind} catalog exceeded ${unit} limit: observed ${observed}, limit ${limit}.`);
    this.name = "McpCatalogLimitError";
  }
}

export type CachedMcpToolCatalogSource = {
  readonly serverId: string;
  readonly tool: CachedMcpToolDefinition;
  readonly confirmationStrategy: McpToolConfirmationStrategy;
};

export type NormalizedCachedMcpToolCatalogEntry<TSource extends CachedMcpToolCatalogSource> =
  TSource & { readonly definition: ToolDefinition };

export const DEFAULT_MCP_TOOL_CONFIRMATION_STRATEGY: McpToolConfirmationStrategy = {
  confirmationMode: "never",
  autoApprovedTools: [],
};

export function createMcpToolDefinition(
  tool: CachedMcpToolDefinition,
  serverId: string,
  confirmationStrategy: McpToolConfirmationStrategy = DEFAULT_MCP_TOOL_CONFIRMATION_STRATEGY,
): ToolDefinition {
  const namespacedName = canonicalNamespacedToolName(serverId, tool.name);
  return {
    name: namespacedName,
    description: mcpToolDescription(tool, serverId),
    inputSchema: cloneToolInputSchema(tool.inputSchema),
    outputSchema: tool.outputSchema === undefined ? undefined : cloneToolJsonSchema(tool.outputSchema),
    metadata: mcpToolMetadata(tool, serverId, confirmationStrategy),
  };
}

export function normalizeCachedMcpToolCatalog<TSource extends CachedMcpToolCatalogSource>(
  sources: readonly TSource[],
): readonly NormalizedCachedMcpToolCatalogEntry<TSource>[] {
  const entries = sources.map((source): NormalizedCachedMcpToolCatalogEntry<TSource> => ({
    ...source,
    definition: createMcpToolDefinition(source.tool, source.serverId, source.confirmationStrategy),
  })).sort((left, right) => left.definition.name.localeCompare(right.definition.name));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]?.definition.name === entries[index]?.definition.name) {
      throw new Error(`MCP cached tool catalog contains duplicate tool ${entries[index]!.definition.name}.`);
    }
  }
  return entries;
}

export function assertMcpCatalogWithinLimits(
  catalogKind: string,
  items: readonly unknown[],
  maxItems = DEFAULT_MCP_MAX_TOOL_CATALOG_ITEMS,
  maxSerializedBytes = DEFAULT_MCP_MAX_TOOL_CATALOG_BYTES,
): void {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new Error("maxCatalogItems must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxSerializedBytes) || maxSerializedBytes < 1) {
    throw new Error("maxCatalogBytes must be a positive safe integer.");
  }
  let serializedBytes = 2;
  for (const [index, item] of items.entries()) {
    const itemCount = index + 1;
    if (itemCount > maxItems) {
      throw new McpCatalogLimitError(catalogKind, "items", itemCount, maxItems);
    }
    const serialized = JSON.stringify(item) ?? "null";
    serializedBytes += Buffer.byteLength(serialized, "utf8") + (itemCount > 1 ? 1 : 0);
    if (serializedBytes > maxSerializedBytes) {
      throw new McpCatalogLimitError(
        catalogKind,
        "serialized_bytes",
        serializedBytes,
        maxSerializedBytes,
      );
    }
  }
}

export function assertCachedMcpToolCatalogWithinLimits(
  entries: readonly { readonly definition: ToolDefinition }[],
): void {
  assertMcpCatalogWithinLimits(
    "model-visible tools",
    entries.map((entry) => entry.definition),
  );
}

function mcpToolDescription(tool: CachedMcpToolDefinition, serverId: string): string {
  const description = normalizedText(tool.description);
  if (description !== undefined) return description;
  const title = normalizedText(tool.title);
  return title ?? `Call MCP tool ${tool.name} on server ${serverId}.`;
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function mcpToolMetadata(
  tool: CachedMcpToolDefinition,
  serverId: string,
  confirmationStrategy: McpToolConfirmationStrategy,
): ToolDefinitionMetadata {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const destructive = tool.annotations?.destructiveHint === true;
  const openWorld = tool.annotations?.openWorldHint === true;
  const riskLevel = destructive || openWorld ? "high" : readOnly ? "low" : "medium";
  const operationType = openWorld ? "external-submit" : destructive ? "read-write" : readOnly ? "read-only" : "execute";
  return {
    category: "mcp",
    riskLevel,
    operationType,
    requiresConfirmation: requiresMcpToolConfirmation({
      toolName: tool.name,
      confirmationStrategy,
      riskLevel,
      operationType,
    }),
    runtimeHints: [{
      kind: "mcp_tool",
      serverId,
      protocolName: tool.name,
      readOnlyHint: tool.annotations?.readOnlyHint,
      destructiveHint: tool.annotations?.destructiveHint,
      idempotentHint: tool.annotations?.idempotentHint,
      openWorldHint: tool.annotations?.openWorldHint,
    }],
  };
}

function requiresMcpToolConfirmation(input: {
  readonly toolName: string;
  readonly confirmationStrategy: McpToolConfirmationStrategy;
  readonly riskLevel: ToolDefinitionMetadata["riskLevel"];
  readonly operationType: ToolDefinitionMetadata["operationType"];
}): boolean {
  if (input.confirmationStrategy.autoApprovedTools.includes(input.toolName)) return false;
  if (input.confirmationStrategy.confirmationMode === "never") return false;
  if (input.confirmationStrategy.confirmationMode === "always") return true;
  if (input.operationType === "read-only") return false;
  return input.riskLevel === "high" || input.operationType === "external-submit";
}
