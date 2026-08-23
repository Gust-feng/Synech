import type {
  CapabilityToolAvailability,
  ModelCapabilities,
  SanitizedCommandShellConfig,
  ToolStateSettings,
} from "../../domain/config/index.js";
import type { ContextAttachmentRunContext } from "./adapters/context-attachment-access.js";
import type { ToolCategory, ToolExecutor } from "../../domain/tools/index.js";
import type { ProcessTerminator } from "../runtime-guard/index.js";
import {
  createBrowserSnapshotTool,
} from "./adapters/browser-tool.js";
import {
  createContextAttachmentTools,
} from "./adapters/context-attachment-tools.js";
import { attachmentEntries } from "./adapters/context-attachment-access.js";
import type { ContextAttachmentReadAuthorization } from "./adapters/context-attachment-access.js";
import type { LocalWorkspacePathAuthorization } from "./adapters/local-workspace-common.js";
import {
  createHttpRequestTool,
} from "./adapters/http-request-tool.js";
import {
  createLocalEditFileTool,
  createLocalGlobTool,
  createLocalGrepFilesTool,
  createLocalReadFileTool,
  createLocalWriteFileTool,
} from "./adapters/local-workspace-tools.js";
import {
  InMemoryLocalWorkspaceMutationCoordinator,
  type LocalWorkspaceMutationCoordinator,
} from "./adapters/local-workspace-mutation-coordinator.js";
import {
  createDefaultCommandShellConfig,
  createLocalShellCommandTool,
  type LocalCommandProcessRegistry,
} from "./adapters/local-workspace-command-tools.js";
import { createLocalManagedProcessTools } from "./adapters/local-workspace-managed-process-tools.js";
import {
  createLocalWorkspaceSandboxPolicy,
} from "./adapters/local-workspace-sandbox.js";
import { createReadToolOutputTool } from "./adapters/tool-output-read-tool.js";
import { ToolRegistry, type ToolRegistryScope } from "./tool-registry.js";
import type { ToolOutputStore } from "./tool-output-store.js";
import type { ToolOutputTokenCounter } from "./tool-output-limits.js";
import type { ToolExecutionMetricsSink } from "../../domain/tools/index.js";

export type CreateAgentToolRegistryOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: ToolRegistryFetchLike;
  readonly workspaceRoot?: string;
  readonly playwrightAvailable?: boolean;
  readonly toolStates?: readonly ToolStateSettings[];
  readonly toolCatalogNames?: readonly string[];
  readonly toolCatalogAvailability?: readonly CapabilityToolAvailability[];
  readonly baseToolScopes?: readonly ToolRegistryScope[];
  readonly commandShell?: SanitizedCommandShellConfig;
  readonly processRegistry?: LocalCommandProcessRegistry;
  readonly processTerminator?: ProcessTerminator;
  readonly runContext?: ContextAttachmentRunContext;
  readonly modelCapabilities?: ModelCapabilities;
  readonly toolOutputStore?: ToolOutputStore;
  readonly outputTokenCounter?: ToolOutputTokenCounter;
  readonly metricsSink?: ToolExecutionMetricsSink;
  readonly fileMutationCoordinator?: LocalWorkspaceMutationCoordinator;
  readonly resolveManagedAttachmentPath?: (attachmentId: string) => Promise<string | undefined>;
  readonly contextAttachmentReadAuthorization?: ContextAttachmentReadAuthorization;
  readonly workspacePathAuthorization?: LocalWorkspacePathAuthorization;
  /** Host-declared runs keep the attachment tools visible even with zero attachments. */
  readonly exposeContextAttachmentToolsWhenEmpty?: boolean;
};

export type ToolRegistryFetchLike = (
  url: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text?: () => Promise<string>;
}>;

export function createAgentToolRegistry(
  options: CreateAgentToolRegistryOptions = {},
  registry?: ToolRegistry,
): ToolRegistry {
  const targetRegistry = registry ?? new ToolRegistry({
    toolCenter: {
      outputStore: options.toolOutputStore,
      outputTokenCounter: options.outputTokenCounter,
      metricsSink: options.metricsSink,
    },
  });
  const env = options.env ?? process.env;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const sandboxPolicy = createLocalWorkspaceSandboxPolicy();
  const mutationCoordinator = options.fileMutationCoordinator ?? new InMemoryLocalWorkspaceMutationCoordinator();
  const commandShell = options.commandShell ?? createDefaultCommandShellConfig(process.platform, env);
  const playwrightAvailable = options.playwrightAvailable ?? isPackageResolvable("playwright");
  const baseToolScopes = options.baseToolScopes ?? ["agent-basic"];
  const executors: readonly ToolExecutor[] = [
    createLocalReadFileTool(workspaceRoot, { sandboxPolicy, outputTokenCounter: options.outputTokenCounter, pathAuthorization: options.workspacePathAuthorization }),
    createLocalGlobTool(workspaceRoot, { sandboxPolicy, outputTokenCounter: options.outputTokenCounter, pathAuthorization: options.workspacePathAuthorization }),
    createLocalGrepFilesTool(workspaceRoot, { sandboxPolicy, outputTokenCounter: options.outputTokenCounter, pathAuthorization: options.workspacePathAuthorization }),
    createLocalWriteFileTool(workspaceRoot, { sandboxPolicy, mutationCoordinator, pathAuthorization: options.workspacePathAuthorization }),
    createLocalEditFileTool(workspaceRoot, { sandboxPolicy, mutationCoordinator, pathAuthorization: options.workspacePathAuthorization }),
    createLocalShellCommandTool(workspaceRoot, { sandboxPolicy, commandShell, processRegistry: options.processRegistry, pathAuthorization: options.workspacePathAuthorization }),
    ...managedProcessExecutors(options, workspaceRoot, sandboxPolicy, commandShell),
    ...contextAttachmentExecutors(options, workspaceRoot),
    createHttpRequestTool({ outputStore: options.toolOutputStore }),
    createBrowserSnapshotTool({ outputStore: options.toolOutputStore }),
    ...(options.toolOutputStore === undefined ? [] : [createReadToolOutputTool(options.toolOutputStore, {
      outputTokenCounter: options.outputTokenCounter,
    })]),
  ];
  const toolCatalogNames =
    options.toolCatalogNames === undefined ? undefined : new Set(options.toolCatalogNames);
  const toolCatalogAvailability = toolAvailabilityByName(options.toolCatalogAvailability);
  for (const executor of executors) {
    if (toolCatalogNames !== undefined && !toolCatalogNames.has(executor.definition.name)) {
      continue;
    }
    const state = options.toolStates?.find((item) => item.name === executor.definition.name);
    const enabledByDefault = state?.enabled ?? true;
    const frozenAvailability = toolCatalogAvailability.get(executor.definition.name);
    const currentAvailability =
      executor.definition.name === "WebFetch" && !playwrightAvailable
        ? { status: "unavailable" as const, disabledReason: "Playwright is not installed in this workspace." }
        : executor.definition.name === "AttachmentReadImage" && options.modelCapabilities?.supportsVisionInput === false
          ? { status: "unavailable" as const, disabledReason: "Current model does not support vision input." }
          : { status: "available" as const };
    targetRegistry.register({
      executor,
      scopes: [...baseToolScopes, toolScopeFor(executor.definition.metadata?.category)],
      enabledByDefault,
      availability: frozenAvailability ?? currentAvailability,
    });
  }
  return targetRegistry;
}

/**
 * Context attachment tools are run-scoped capabilities.  The generic capability
 * catalog is assembled without a concrete run context and therefore keeps their definitions,
 * but a concrete run with no user-visible attachment must not expose executors
 * that can only return an empty attachment index or an authorization error.
 * A Host-declared run (e.g. a Space-owned run that may gain references) keeps
 * them visible so the model can discover that no attachment is available yet.
 */
function contextAttachmentExecutors(
  options: CreateAgentToolRegistryOptions,
  workspaceRoot: string,
): readonly ToolExecutor[] {
  if (options.runContext !== undefined
    && attachmentEntries(options.runContext).length === 0
    && options.exposeContextAttachmentToolsWhenEmpty !== true) {
    return [];
  }
  return createContextAttachmentTools({
    runContext: options.runContext,
    workspaceRoot,
    supportsVisionInput: options.modelCapabilities?.supportsVisionInput,
    resolveManagedAttachmentPath: options.resolveManagedAttachmentPath,
    readAuthorization: options.contextAttachmentReadAuthorization,
  });
}

/**
 * Managed process tools are only executable when the Host supplied the registry
 * operations they require. The context-free form is used while building the
 * generic capability catalog, so it deliberately retains all definitions there.
 */
function managedProcessExecutors(
  options: CreateAgentToolRegistryOptions,
  workspaceRoot: string,
  sandboxPolicy: ReturnType<typeof createLocalWorkspaceSandboxPolicy>,
  commandShell: SanitizedCommandShellConfig,
): readonly ToolExecutor[] {
  const tools = createLocalManagedProcessTools(workspaceRoot, {
    sandboxPolicy,
    commandShell,
    pathAuthorization: options.workspacePathAuthorization,
    processRegistry: options.processRegistry,
    processTerminator: options.processTerminator,
  });
  if (options.runContext === undefined) {
    return tools;
  }
  return tools.filter((tool) => {
    if (tool.definition.name === "ProcessRead") {
      return options.processRegistry?.get !== undefined && options.processRegistry.listAll !== undefined;
    }
    if (tool.definition.name === "ProcessStop") {
      return options.processRegistry?.get !== undefined &&
        options.processRegistry.stopOwned !== undefined &&
        options.processTerminator !== undefined;
    }
    return true;
  });
}

function toolAvailabilityByName(
  items: readonly CapabilityToolAvailability[] | undefined
): ReadonlyMap<string, { readonly status: "available" } | { readonly status: "unavailable"; readonly disabledReason: string }> {
  const result = new Map<string, { readonly status: "available" } | { readonly status: "unavailable"; readonly disabledReason: string }>();
  for (const item of items ?? []) {
    result.set(item.name, item.availability === "available"
      ? { status: "available" }
      : { status: "unavailable", disabledReason: item.disabledReason ?? "Unavailable in the run capability snapshot." });
  }
  return result;
}

function toolScopeFor(category: ToolCategory | undefined): ToolRegistryScope {
  if (category === "research" || category === "web") {
    return "research";
  }
  if (category === "filesystem" || category === "terminal" || category === "workspace") {
    return "workspace";
  }
  return "agent-basic";
}

function isPackageResolvable(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}
