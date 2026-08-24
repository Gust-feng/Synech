import type {
  CapabilityToolAvailability,
  ModelCapabilities,
  SanitizedCommandShellConfig,
  ToolStateSettings,
  WebSearchRuntimeConfig,
} from "../../domain/config/index.js";
import type { ToolExecutionGateway } from "../../domain/tools/index.js";
import {
  createAgentToolRegistry,
  type ToolRegistryFetchLike,
} from "./builtin-tool-runtime.js";
import type { ToolRegistryScope } from "./tool-registry.js";
import type { ConfigCenter } from "../config-center/index.js";
import { ToolRegistry, type ToolRegistryEntry } from "./tool-registry.js";
import type { LocalCommandProcessRegistry } from "./adapters/local-workspace-command-tools.js";
import type { ProcessTerminator } from "../runtime-guard/index.js";
import type { ToolOutputStore } from "./tool-output-store.js";
import type { ToolOutputTokenCounter } from "./tool-output-limits.js";
import type { ToolExecutionMetricsSink } from "../../domain/tools/index.js";
import type { LocalWorkspaceMutationCoordinator } from "./adapters/local-workspace-mutation-coordinator.js";
import type { ContextAttachmentReadAuthorization } from "./adapters/context-attachment-access.js";
import type { ContextAttachmentRunContext } from "./adapters/context-attachment-access.js";
import type { LocalWorkspacePathAuthorization } from "./adapters/local-workspace-common.js";

export type AgentToolEnvironment = Readonly<Record<string, string | undefined>>;
export type AgentToolProviderFetch = ToolRegistryFetchLike;
export type AgentToolRegistryContribution = (
  register: (entry: ToolRegistryEntry) => void,
) => void;

export type CreateAgentToolCenterOptions = {
  readonly env?: AgentToolEnvironment;
  readonly fetch?: AgentToolProviderFetch;
  readonly webSearch?: WebSearchRuntimeConfig;
  readonly workspaceRoot?: string;
  readonly playwrightAvailable?: boolean;
  readonly toolStates?: readonly ToolStateSettings[];
  readonly toolCatalogNames?: readonly string[];
  readonly toolCatalogAvailability?: readonly CapabilityToolAvailability[];
  readonly baseToolScopes?: readonly ToolRegistryScope[];
  readonly toolRegistryScopes?: readonly ToolRegistryScope[];
  readonly commandShell?: SanitizedCommandShellConfig;
  readonly processRegistry?: LocalCommandProcessRegistry;
  readonly processTerminator?: ProcessTerminator;
  readonly contributions?: readonly AgentToolRegistryContribution[];
  readonly runContext?: ContextAttachmentRunContext;
  readonly modelCapabilities?: ModelCapabilities;
  readonly toolOutputStore?: ToolOutputStore;
  readonly outputTokenCounter?: ToolOutputTokenCounter;
  readonly metricsSink?: ToolExecutionMetricsSink;
  readonly fileMutationCoordinator?: LocalWorkspaceMutationCoordinator;
  readonly resolveManagedAttachmentPath?: (attachmentId: string) => Promise<string | undefined>;
  readonly contextAttachmentReadAuthorization?: ContextAttachmentReadAuthorization;
  readonly workspacePathAuthorization?: LocalWorkspacePathAuthorization;
  readonly exposeContextAttachmentToolsWhenEmpty?: boolean;
};

export function createDefaultToolCenter(
  input: CreateAgentToolCenterOptions = {}
): ToolExecutionGateway {
  return createToolCenter(input);
}

export async function createConfiguredToolCenter(
  configCenter: ConfigCenter,
  input: CreateAgentToolCenterOptions = {}
): Promise<ToolExecutionGateway> {
  const [env, webSearch] = await Promise.all([
    input.env === undefined ? configCenter.createModelRuntimeEnvironment() : input.env,
    input.webSearch === undefined ? configCenter.resolveWebSearchRuntimeConfig() : input.webSearch,
  ]);
  return createToolCenter({ ...input, env, webSearch });
}

export async function createConfiguredToolCenterFactory(
  configCenter: ConfigCenter,
  input: CreateAgentToolCenterOptions = {}
): Promise<() => ToolExecutionGateway> {
  const [env, webSearch] = await Promise.all([
    input.env === undefined ? configCenter.createModelRuntimeEnvironment() : input.env,
    input.webSearch === undefined ? configCenter.resolveWebSearchRuntimeConfig() : input.webSearch,
  ]);
  return () => createToolCenter({ ...input, env, webSearch });
}

function createToolCenter(input: CreateAgentToolCenterOptions): ToolExecutionGateway {
  const registry = new ToolRegistry({
    toolCenter: {
      outputStore: input.toolOutputStore,
      outputTokenCounter: input.outputTokenCounter,
      metricsSink: input.metricsSink,
    },
  });
  applyAgentToolRegistryContributions(registry, input, input.contributions ?? []);
  createAgentToolRegistry(input, registry);
  return registry.createToolCenterForScopes(
    input.toolRegistryScopes ?? input.baseToolScopes ?? ["agent-basic"]
  );
}

export function applyAgentToolRegistryContributions(
  registry: ToolRegistry,
  input: Pick<
    CreateAgentToolCenterOptions,
    "toolCatalogNames" | "toolStates" | "toolCatalogAvailability"
  >,
  contributions: readonly AgentToolRegistryContribution[],
): void {
  const frozenToolNames = input.toolCatalogNames === undefined
    ? undefined
    : new Set(input.toolCatalogNames);
  for (const contribute of contributions) {
    contribute((entry) => {
      const name = entry.executor.definition.name;
      if (frozenToolNames !== undefined && !frozenToolNames.has(name)) {
        return;
      }
      const state = input.toolStates?.find((item) => item.name === name);
      const frozenAvailability = input.toolCatalogAvailability?.find((item) => item.name === name);
      registry.register({
        ...entry,
        enabledByDefault: state?.enabled ?? entry.enabledByDefault,
        availability: frozenAvailability === undefined
          ? entry.availability
          : frozenAvailability.availability === "available"
            ? { status: "available" }
            : {
                status: "unavailable",
                disabledReason: frozenAvailability.disabledReason ?? "Unavailable in the run capability snapshot.",
              },
      });
    });
  }
}
