import type {
  AgentCapabilitySnapshot,
  CapabilityToolAvailability,
  McpServerSettings,
  SanitizedCommandShellConfig,
  SanitizedInformationAccessConfig,
  ToolStateSettings,
} from "../../domain/config/index.js";
import { LazyMcpToolExecutorProvider } from "../../adapters/mcp/index.js";
import type { ModelRuntimeEnvironment } from "../model-runtime/index.js";
import {
  createDefaultToolCenter,
  type AgentToolRegistryContribution,
} from "../tool-center/index.js";
import type { ToolRegistryScope } from "../tool-center/tool-registry.js";
import type { OrdinaryRunContext } from "../../domain/ordinary/index.js";
import type { ContextAttachmentRunContext } from "../tool-center/adapters/context-attachment-access.js";
import type { ConfigCenter } from "../config-center/index.js";
import type { LocalCommandProcessRegistry } from "../tool-center/adapters/local-workspace-command-tools.js";
import type { ToolOutputStore } from "../tool-center/tool-output-store.js";
import type { InMemoryProcessRegistry, ProcessTerminator } from "../runtime-guard/index.js";
import type { PanelProviderFetch } from "./types.js";
import {
  createMcpToolRegistryContribution,
} from "../mcp/mcp-tool-contribution.js";
import type { AgentLoopTokenCounter } from "../context-maintenance/index.js";
import type { ToolExecutionMetricsSink } from "../../domain/tools/index.js";
import type { LocalWorkspaceMutationCoordinator } from "../tool-center/adapters/local-workspace-mutation-coordinator.js";
import type { ContextAttachmentReadAuthorization } from "../tool-center/adapters/context-attachment-access.js";
import type { LocalWorkspacePathAuthorization } from "../tool-center/adapters/local-workspace-common.js";

export type AgentRunResourceHost = {
  readonly configCenter: ConfigCenter;
  readonly providerFetch?: PanelProviderFetch;
  readonly processRegistry: LocalCommandProcessRegistry & Pick<InMemoryProcessRegistry, "cleanupByRun">;
  /** Present when a run-scoped Host lease is allowed to terminate owned processes. */
  readonly processTerminator?: ProcessTerminator;
  readonly toolOutputStore?: ToolOutputStore;
  readonly fileMutationCoordinator?: LocalWorkspaceMutationCoordinator;
  readonly resolveManagedAttachmentPath?: (attachmentId: string) => Promise<string | undefined>;
  readonly managedMcpBinDirectory?: string;
  /** Host-declared attachment tool exposure for a concrete run context. */
  readonly resolveAttachmentToolExposure?: (runContext: Pick<OrdinaryRunContext, "permissionBoundaryRefs">) => boolean;
};

export type AgentHostRunResources<
  TCapabilitySnapshot extends AgentCapabilitySnapshot = AgentCapabilitySnapshot,
> = {
  readonly capabilitySnapshot: TCapabilitySnapshot;
  readonly informationAccess: SanitizedInformationAccessConfig;
  readonly aiEnvironment: ModelRuntimeEnvironment;
  readonly workspaceRoot: string;
  readonly commandShell?: SanitizedCommandShellConfig;
  readonly toolStates: readonly ToolStateSettings[];
  readonly toolCatalogNames: readonly string[];
  readonly toolCatalogAvailability: readonly CapabilityToolAvailability[];
  readonly playwrightAvailable: boolean;
  readonly toolRegistryScopes: readonly ToolRegistryScope[];
  readonly toolContributions: readonly AgentToolRegistryContribution[];
  readonly release: () => Promise<void>;
  readonly processRegistry?: LocalCommandProcessRegistry;
  readonly processTerminator?: ProcessTerminator;
  readonly toolOutputStore?: ToolOutputStore;
  readonly fileMutationCoordinator?: LocalWorkspaceMutationCoordinator;
  readonly resolveManagedAttachmentPath?: (attachmentId: string) => Promise<string | undefined>;
};

function toolStatesFromCapabilitySnapshot(snapshot: AgentCapabilitySnapshot): readonly ToolStateSettings[] {
  return snapshot.toolCatalog.tools.map((tool) => ({
    name: tool.name,
    enabled: tool.enabled,
    updatedAt: snapshot.createdAt,
  }));
}

function toolCatalogNamesFromCapabilitySnapshot(snapshot: AgentCapabilitySnapshot): readonly string[] {
  return snapshot.toolCatalog.tools.map((tool) => tool.name);
}

function toolCatalogAvailabilityFromCapabilitySnapshot(snapshot: AgentCapabilitySnapshot): readonly CapabilityToolAvailability[] {
  return snapshot.toolCatalog.tools.map((tool) => ({
    name: tool.name,
    availability: tool.availability,
    disabledReason: tool.disabledReason,
  }));
}

/**
 * Acquires Host-owned tools, MCP connections, and execution settings without
 * constructing a model runtime. Ordinary uses this boundary because its model
 * loop is provided by the Pi Session adapter. The local Desktop composition
 * uses this boundary only for Host-owned tools, MCP connections, and path
 * permissions; model execution remains in the Ordinary Session adapter.
 */
export async function prepareAgentHostRunResources<
  TCapabilitySnapshot extends AgentCapabilitySnapshot,
>(
  runtime: AgentRunResourceHost,
  input: {
    readonly capabilitySnapshot: TCapabilitySnapshot;
    readonly informationAccess: SanitizedInformationAccessConfig;
  },
): Promise<AgentHostRunResources<TCapabilitySnapshot>> {
  const aiEnvironment = await runtime.configCenter.createModelRuntimeEnvironment({
    modelProvider: input.capabilitySnapshot.activeModel,
    informationAccess: input.informationAccess,
  });
  return prepareAgentHostRunResourcesWithEnvironment(runtime, input, aiEnvironment);
}

async function prepareAgentHostRunResourcesWithEnvironment<
  TCapabilitySnapshot extends AgentCapabilitySnapshot,
>(
  runtime: AgentRunResourceHost,
  input: {
    readonly capabilitySnapshot: TCapabilitySnapshot;
    readonly informationAccess: SanitizedInformationAccessConfig;
  },
  aiEnvironment: ModelRuntimeEnvironment,
): Promise<AgentHostRunResources<TCapabilitySnapshot>> {
  const capabilitySnapshot = input.capabilitySnapshot;
  const mcpManager = await mcpManagerFromCapabilitySnapshot(runtime, capabilitySnapshot, aiEnvironment);
  return {
    capabilitySnapshot,
    informationAccess: input.informationAccess,
    aiEnvironment,
    workspaceRoot: capabilitySnapshot.executionRoot,
    commandShell: capabilitySnapshot.commandShell,
    toolStates: toolStatesFromCapabilitySnapshot(capabilitySnapshot),
    toolCatalogNames: toolCatalogNamesFromCapabilitySnapshot(capabilitySnapshot),
    toolCatalogAvailability: toolCatalogAvailabilityFromCapabilitySnapshot(capabilitySnapshot),
    playwrightAvailable: capabilitySnapshot.toolCatalog.tools.some(
      (tool) => tool.name === "WebFetch" && tool.availability === "available"
    ),
    toolRegistryScopes: mcpManager === undefined ? ["agent-basic"] : ["agent-basic", "mcp"],
    toolContributions: mcpManager === undefined
      ? []
      : [createMcpToolRegistryContribution(mcpManager, { useDiscoveredTools: false })],
    release: async () => {
      await mcpManager?.disconnectAll?.();
    },
    processRegistry: runtime.processRegistry,
    processTerminator: runtime.processTerminator,
    toolOutputStore: runtime.toolOutputStore,
    fileMutationCoordinator: runtime.fileMutationCoordinator,
    resolveManagedAttachmentPath: runtime.resolveManagedAttachmentPath,
  };
}

async function mcpManagerFromCapabilitySnapshot(
  runtime: AgentRunResourceHost,
  snapshot: AgentCapabilitySnapshot,
  env: Readonly<Record<string, string | undefined>>
): Promise<LazyMcpToolExecutorProvider | undefined> {
  const servers = snapshot.mcpCatalog
    .filter((server) => server.enabled && server.availability === "configured" && server.runtimeConfig !== undefined)
    .filter((server) => server.exposedTools.length > 0)
    .map((server): McpServerSettings => ({
      serverId: server.serverId,
      label: server.label,
      transport: server.runtimeConfig!.transport,
      command: server.runtimeConfig!.command,
      args: server.runtimeConfig!.args,
      url: server.runtimeConfig!.url,
      envSecretRefs: server.runtimeConfig!.envSecretRefs,
      headerSecretRefs: server.runtimeConfig!.headerSecretRefs,
      bearerTokenSecretRef: server.runtimeConfig!.bearerTokenSecretRef,
      apiKeySecretRef: server.runtimeConfig!.apiKeySecretRef,
      apiKeyHeaderName: server.runtimeConfig!.apiKeyHeaderName,
      confirmationMode: server.runtimeConfig!.confirmationMode,
      toolExposureMode: server.runtimeConfig!.toolExposureMode,
      enabledTools: server.runtimeConfig!.enabledTools,
      autoApprovedTools: server.runtimeConfig!.autoApprovedTools,
      enabled: true,
      cachedTools: server.cachedTools ?? [],
      toolsCachedAt: server.toolsCachedAt ?? snapshot.createdAt,
      updatedAt: server.updatedAt,
    }));
  if (servers.length === 0) {
    return undefined;
  }
  const mcpEnv =
    typeof runtime.configCenter.createMcpRuntimeEnvironment === "function"
      ? await runtime.configCenter.createMcpRuntimeEnvironment({ servers, baseEnv: env })
      : env;
  return new LazyMcpToolExecutorProvider({
    servers,
    env: mcpEnv,
    managedBinDirectory: runtime.managedMcpBinDirectory,
  });
}

export function createAgentToolCenterFactory(
  providerFetch: PanelProviderFetch | undefined,
  resources: AgentHostRunResources
) {
  return (context?: {
    readonly contributions?: readonly AgentToolRegistryContribution[];
    readonly runContext?: ContextAttachmentRunContext;
    readonly outputTokenCounter?: AgentLoopTokenCounter;
    readonly metricsSink?: ToolExecutionMetricsSink;
    readonly contextAttachmentReadAuthorization?: ContextAttachmentReadAuthorization;
    readonly workspacePathAuthorization?: LocalWorkspacePathAuthorization;
    readonly exposeContextAttachmentToolsWhenEmpty?: boolean;
  }) => createDefaultToolCenter({
    env: resources.aiEnvironment,
    fetch: providerFetch,
    workspaceRoot: resources.workspaceRoot,
    commandShell: resources.commandShell,
    toolStates: resources.toolStates,
    toolCatalogNames: resources.toolCatalogNames,
    toolCatalogAvailability: resources.toolCatalogAvailability,
    baseToolScopes: ["agent-basic"],
    playwrightAvailable: resources.playwrightAvailable,
    toolRegistryScopes: resources.toolRegistryScopes,
    processRegistry: resources.processRegistry,
    processTerminator: resources.processTerminator,
    contributions: [...resources.toolContributions, ...(context?.contributions ?? [])],
    runContext: context?.runContext,
    modelCapabilities: resources.capabilitySnapshot.modelCapabilities,
    toolOutputStore: resources.toolOutputStore,
    outputTokenCounter: context?.outputTokenCounter,
    metricsSink: context?.metricsSink,
    fileMutationCoordinator: resources.fileMutationCoordinator,
    resolveManagedAttachmentPath: resources.resolveManagedAttachmentPath,
    contextAttachmentReadAuthorization: context?.contextAttachmentReadAuthorization,
    workspacePathAuthorization: context?.workspacePathAuthorization,
    exposeContextAttachmentToolsWhenEmpty: context?.exposeContextAttachmentToolsWhenEmpty,
  });
}
