import type {
  CapabilityMcpCatalogItem,
  CapabilityMcpToolCatalogItem,
  McpServerSettings,
} from "../../domain/config/index.js";
import {
  assertCachedMcpToolCatalogWithinLimits,
  normalizeCachedMcpToolCatalog,
} from "../../domain/mcp/index.js";
import {
  canonicalNamespacedToolName,
  canonicalToolName,
  canonicalToolNamespacePrefix,
  cloneToolInputSchema,
  cloneToolJsonSchema,
} from "../../domain/tools/index.js";
import type { ToolCatalogItem, ToolCatalogSnapshot } from "../tool-center/tool-registry.js";
import {
  capabilityToolCatalogItem,
  toolCatalogItemForDefinition,
} from "./tool-capability-catalog.js";

export function cachedMcpToolCatalog(servers: readonly McpServerSettings[]): ToolCatalogSnapshot {
  const entries = normalizeCachedMcpToolCatalog(servers
    .filter(isMcpServerConnectable)
    .filter(hasUsableMcpToolCache)
    .flatMap((server) => (server.cachedTools ?? []).map((tool) => ({
      server,
      serverId: server.serverId,
      tool,
      confirmationStrategy: {
        confirmationMode: server.confirmationMode,
        autoApprovedTools: server.autoApprovedTools,
      },
    }))));
  assertCachedMcpToolCatalogWithinLimits(
    entries.filter(({ server, definition }) => isMcpToolEnabledForServer(server, definition.name)),
  );
  const tools = entries.map(({ definition }) => toolCatalogItemForDefinition(definition, ["mcp"]));
  return {
    scope: "mcp",
    tools,
    allowedTools: tools.map((tool) => tool.name),
  };
}

export function mcpCatalogItemForServer(
  server: McpServerSettings,
  discoveredMcpTools: readonly ToolCatalogItem[],
  exposedMcpTools: readonly ToolCatalogItem[],
): CapabilityMcpCatalogItem {
  const availability = server.enabled ? mcpAvailability(server) : "disabled";
  const runtimeStatus = mcpRuntimeStatusFor(server, availability);
  const namespacePrefix = canonicalToolNamespacePrefix(server.serverId);
  const discoveredTools = discoveredMcpTools
    .filter((tool) => tool.name.startsWith(namespacePrefix))
    .map((tool) => capabilityMcpToolCatalogItem(server, tool));
  const exposedTools = exposedMcpTools
    .filter((tool) => tool.name.startsWith(namespacePrefix))
    .map((tool) => capabilityMcpToolCatalogItem(server, tool));
  return {
    serverId: server.serverId,
    label: server.label,
    description: server.description,
    transport: server.transport,
    enabled: server.enabled,
    confirmationMode: server.confirmationMode,
    availability,
    runtimeStatus,
    errorSummary: server.lastError,
    commandSummary: commandSummaryFor(server.command, server.args),
    url: isNetworkMcpTransport(server.transport) ? server.url : undefined,
    envSecretRefCount: server.envSecretRefs.length,
    authSecretRefCount: [
      server.bearerTokenSecretRef,
      server.apiKeySecretRef,
      ...(server.headerSecretRefs ?? []),
    ].filter((ref) => ref !== undefined).length,
    toolExposureMode: server.toolExposureMode,
    enabledTools: [...server.enabledTools],
    autoApprovedTools: [...server.autoApprovedTools],
    lastConnectedAt: server.lastConnectedAt,
    lastError: server.lastError,
    toolsCachedAt: server.toolsCachedAt,
    cachedTools: server.cachedTools === undefined ? undefined : server.cachedTools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: cloneToolInputSchema(tool.inputSchema),
      outputSchema: tool.outputSchema === undefined ? undefined : cloneToolJsonSchema(tool.outputSchema),
      annotations: tool.annotations === undefined ? undefined : { ...tool.annotations },
    })),
    promptCount: server.cachedReferences?.prompts.length,
    resourceCount: server.cachedReferences?.resources.length,
    resourceTemplateCount: server.cachedReferences?.resourceTemplates.length,
    referencesCachedAt: server.referencesCachedAt,
    runtimeConfig: availability === "configured" ? {
      transport: server.transport,
      command: server.transport === "stdio" ? server.command : undefined,
      args: server.transport === "stdio" ? [...(server.args ?? [])] : undefined,
      url: isNetworkMcpTransport(server.transport) ? server.url : undefined,
      envSecretRefs: [...server.envSecretRefs],
      headerSecretRefs: [...(server.headerSecretRefs ?? [])],
      bearerTokenSecretRef: server.bearerTokenSecretRef,
      apiKeySecretRef: server.apiKeySecretRef,
      apiKeyHeaderName: server.apiKeyHeaderName,
      confirmationMode: server.confirmationMode,
      toolExposureMode: server.toolExposureMode,
      enabledTools: [...server.enabledTools],
      autoApprovedTools: [...server.autoApprovedTools],
    } : undefined,
    tools: discoveredTools,
    exposedTools,
    updatedAt: server.updatedAt,
  };
}

export function filteredMcpToolCatalog<T extends {
  readonly tools: readonly ToolCatalogItem[];
  readonly allowedTools: readonly string[];
}>(catalog: T, servers: readonly McpServerSettings[]): T {
  const configuredServers = canonicalMcpServerMap(servers);
  const tools = catalog.tools.filter((tool) => {
    const server = serverForNamespacedTool(configuredServers, tool.name);
    return server === undefined ? false : isMcpToolEnabledForServer(server, tool.name);
  });
  const allowedToolNames = new Set(tools.map((tool) => tool.name));
  return {
    ...catalog,
    tools,
    allowedTools: catalog.allowedTools.filter((name) => allowedToolNames.has(name)),
  };
}

function hasUsableMcpToolCache(server: McpServerSettings): boolean {
  return server.lastError === undefined && (server.cachedTools?.length ?? 0) > 0;
}

function serverForNamespacedTool(
  servers: ReadonlyMap<string, McpServerSettings>,
  toolName: string,
): McpServerSettings | undefined {
  const separator = toolName.indexOf("__");
  return separator <= 0 ? undefined : servers.get(toolName.slice(0, separator));
}

function canonicalMcpServerMap(
  servers: readonly McpServerSettings[],
): ReadonlyMap<string, McpServerSettings> {
  const result = new Map<string, McpServerSettings>();
  for (const server of servers) {
    const namespace = canonicalToolName(server.serverId);
    const existing = result.get(namespace);
    if (existing !== undefined && existing.serverId !== server.serverId) {
      throw new Error(
        `MCP servers ${existing.serverId} and ${server.serverId} share canonical tool namespace ${namespace}.`,
      );
    }
    result.set(namespace, server);
  }
  return result;
}

function isMcpToolEnabledForServer(server: McpServerSettings, namespacedToolName: string): boolean {
  if (server.toolExposureMode === "none") return false;
  if (server.toolExposureMode === "all") return true;
  const protocolName = mcpProtocolNameForCatalogTool(server, namespacedToolName);
  return protocolName !== undefined && server.enabledTools.includes(protocolName);
}

function capabilityMcpToolCatalogItem(
  server: McpServerSettings,
  tool: ToolCatalogItem,
): CapabilityMcpToolCatalogItem {
  const protocolName = mcpProtocolNameForCatalogTool(server, tool.name);
  if (protocolName === undefined) {
    throw new Error(`MCP catalog tool ${tool.name} has no matching protocol identity on server ${server.serverId}.`);
  }
  return { ...capabilityToolCatalogItem(tool), protocolName };
}

function mcpProtocolNameForCatalogTool(
  server: McpServerSettings,
  namespacedToolName: string,
): string | undefined {
  return server.cachedTools?.find((tool) =>
    canonicalNamespacedToolName(server.serverId, tool.name) === namespacedToolName)?.name;
}

function mcpAvailability(server: {
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly url?: string;
}): CapabilityMcpCatalogItem["availability"] {
  if (server.transport === "stdio") return server.command === undefined ? "unavailable" : "configured";
  return server.url === undefined ? "unavailable" : "configured";
}

function mcpRuntimeStatusFor(
  server: McpServerSettings,
  availability: CapabilityMcpCatalogItem["availability"],
): NonNullable<CapabilityMcpCatalogItem["runtimeStatus"]> {
  if (!server.enabled) return "disabled";
  if (availability === "unavailable") return "unavailable";
  if (server.lastError !== undefined) return "error";
  return "configured";
}

function isMcpServerConnectable(server: McpServerSettings): boolean {
  return server.enabled && mcpAvailability(server) === "configured";
}

function isNetworkMcpTransport(transport: McpServerSettings["transport"]): boolean {
  return transport === "http";
}

function commandSummaryFor(command: string | undefined, args: readonly string[] | undefined): string | undefined {
  if (command === undefined) return undefined;
  let previousWasSensitiveFlag = false;
  const safeArgs = (args ?? []).slice(0, 6).map((arg) => {
    const sensitiveFlag = /^--?(?:api[_-]?key|token|secret|password|passwd|bearer)$/i.test(arg);
    const sensitiveKeyValue = /(?:api[_-]?key|token|secret|password|passwd|bearer)\s*[=:]/i.test(arg);
    if (previousWasSensitiveFlag || sensitiveFlag || sensitiveKeyValue || arg.includes("=")) {
      previousWasSensitiveFlag = sensitiveFlag;
      return "[arg]";
    }
    previousWasSensitiveFlag = false;
    return arg;
  });
  return [command, ...safeArgs].join(" ");
}
