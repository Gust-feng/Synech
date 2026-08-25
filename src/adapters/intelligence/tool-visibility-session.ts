import {
  type AgentHarness,
  type AgentTool,
  type AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentLoopToolVisibilityPlan } from "../../app/model-runtime/agent-loop.js";
import { isProgressiveToolVisibilityCostEffective } from "../../app/model-runtime/tool-definition-visibility-cost.js";
import { TOOL_VISIBILITY_ACTIVATION_KIND } from "../../app/model-runtime/tool-visibility-contract.js";
import {
  modelVisibleToolDescription,
  normalizeToolFactValue,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
  type ToolFactValue,
} from "../../domain/tools/index.js";
import { errorMessage } from "../../kernel/values/index.js";

export type ToolVisibilityToolSet = {
  readonly tools: readonly AgentTool[];
  readonly metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>;
  readonly activeToolNames: readonly string[];
  readonly bind?: (harness: AgentHarness) => void;
};

type VisibilityControlExecutionResult = {
  readonly result: ToolCallResult;
  readonly addedToolNames?: readonly string[];
  readonly rollback?: () => Promise<void>;
};

type VisibilityStateMutation = <T>(operation: () => Promise<T>) => Promise<T>;

type VisibilitySearchInput = {
  readonly query?: string;
  readonly serverId?: string;
  readonly cursor: number;
  readonly limit: number;
};

type VisibilityControlHost = {
  readonly abortSignal: AbortSignal;
  readonly requestScope?: (request: ToolCallRequest) => ToolCallRequest;
  /**
   * Resolves the Synech invocation identity for a provider-issued call id.
   * The visibility-control execute() path uses it instead of minting its own
   * id; the result is the only ToolCallRequest the harness is allowed to
   * dispatch downstream.
   */
  readonly resolveInvocationId: (providerCallId: string) =>
    | { readonly invocationId: string; readonly parentInvocationId?: string }
    | undefined;
  readonly onToolRequested: (request: ToolCallRequest) => void;
  readonly onToolInvoked?: () => void;
  readonly acceptResult: (result: ToolCallResult) => Promise<AgentToolResult<unknown> | undefined>;
  readonly projectResult: (
    result: ToolCallResult,
    terminate: boolean,
    addedToolNames?: readonly string[],
  ) => AgentToolResult<unknown>;
  readonly recordMaintenanceFailure: (failure: { readonly code: string; readonly error: string }) => void;
};

/** Owns progressive tool visibility for one Pi AgentHarness execution. */
export function createToolVisibilitySession(input: {
  readonly tools: readonly AgentTool[];
  readonly metadataByName: ReadonlyMap<string, ToolDefinition["metadata"]>;
  readonly visibilityPlan?: AgentLoopToolVisibilityPlan;
  readonly host: VisibilityControlHost;
}): ToolVisibilityToolSet {
  const baseTools = [...input.tools];
  assertUniqueToolNames(baseTools);
  if (input.visibilityPlan === undefined) {
    return {
      tools: baseTools,
      metadataByName: input.metadataByName,
      activeToolNames: baseTools.map((tool) => tool.name),
    };
  }

  const visibilityPlan = input.visibilityPlan;
  validateToolVisibilityPlan(visibilityPlan, baseTools.map((tool) => tool.name));
  let harness: AgentHarness | undefined;
  let visibilityMutationTail = Promise.resolve();
  const mutateVisibilityState: VisibilityStateMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = visibilityMutationTail;
    let release!: () => void;
    visibilityMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const controlToolNames = [
    visibilityPlan.controls.search.name,
    visibilityPlan.controls.load.name,
  ];
  const allToolNames = [
    ...baseTools.map((tool) => tool.name),
    ...controlToolNames,
  ];
  const deferredTools = [...visibilityPlan.deferredTools];
  const searchTool = createVisibilityControlTool({
    definition: visibilityPlan.controls.search,
    host: input.host,
    execute: async (request) => ({
      result: searchDeferredTools(
        request,
        deferredTools,
        requireBoundHarness(harness).getActiveTools().map((tool) => tool.name),
      ),
    }),
  });
  const loadTool = createVisibilityControlTool({
    definition: visibilityPlan.controls.load,
    host: input.host,
    execute: async (request) => loadDeferredTools({
      request,
      deferredTools,
      controlToolNames,
      harness: requireBoundHarness(harness),
      mutateVisibilityState,
    }),
  });
  const tools = [...baseTools, searchTool, loadTool];
  assertUniqueToolNames(tools);
  const initiallyActive = new Set([
    ...visibilityPlan.initiallyVisibleToolNames,
    ...controlToolNames,
  ]);
  return {
    tools,
    metadataByName: new Map([
      ...input.metadataByName,
      [visibilityPlan.controls.search.name, visibilityPlan.controls.search.metadata] as const,
      [visibilityPlan.controls.load.name, visibilityPlan.controls.load.metadata] as const,
    ]),
    activeToolNames: allToolNames.filter((name) => initiallyActive.has(name)),
    bind: (boundHarness) => {
      if (harness !== undefined && harness !== boundHarness) {
        throw new Error("Progressive tool visibility bundle is already bound to another AgentHarness.");
      }
      harness = boundHarness;
    },
  };
}

export function validateToolVisibilityPlan(
  plan: AgentLoopToolVisibilityPlan,
  baseToolNames: readonly string[],
): void {
  const initialNames = [...plan.initiallyVisibleToolNames];
  const deferredNames = plan.deferredTools.map((tool) => tool.name);
  assertUniqueToolNameList(initialNames, "initially visible");
  assertUniqueToolNameList(deferredNames, "deferred");
  if (plan.controls.search.name === plan.controls.load.name) {
    throw new Error(`Progressive tool visibility controls share the name ${plan.controls.search.name}.`);
  }
  const baseNameSet = new Set(baseToolNames);
  const partition = new Set(initialNames);
  for (const name of deferredNames) {
    if (partition.has(name)) {
      throw new Error(`Progressive tool visibility plan places ${name} in both partitions.`);
    }
    partition.add(name);
  }
  const missing = baseToolNames.filter((name) => !partition.has(name));
  const foreign = [...partition].filter((name) => !baseNameSet.has(name));
  if (missing.length > 0 || foreign.length > 0) {
    throw new Error(
      `Progressive tool visibility plan does not partition the frozen run tools (missing: ${missing.join(", ") || "none"}; foreign: ${foreign.join(", ") || "none"}).`,
    );
  }
}

export function searchDeferredToolCatalog(input: {
  readonly search: VisibilitySearchInput;
  readonly deferredTools: AgentLoopToolVisibilityPlan["deferredTools"];
  readonly activeToolNames: readonly string[];
}): ToolFactValue {
  const query = input.search.query?.trim().toLowerCase();
  const serverId = input.search.serverId?.trim();
  const active = new Set(input.activeToolNames);
  const matching = input.deferredTools.filter((tool) => {
    if (serverId !== undefined && tool.source.id !== serverId) return false;
    if (query === undefined) return true;
    return [tool.name, tool.displayName, tool.description, tool.source.id, tool.source.label]
      .some((value) => value.toLowerCase().includes(query));
  });
  const page = matching.slice(input.search.cursor, input.search.cursor + input.search.limit);
  const nextCursor = input.search.cursor + page.length;
  return {
    matches: page.map((tool) => ({
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      source: globalThis.structuredClone(tool.source),
      loaded: active.has(tool.name),
    })),
    totalMatches: matching.length,
    returned: page.length,
    ...(nextCursor < matching.length
      ? {
          continuation: {
            nextInput: {
              ...(input.search.query === undefined ? {} : { query: input.search.query }),
              ...(input.search.serverId === undefined ? {} : { server_id: input.search.serverId }),
              cursor: nextCursor,
              limit: input.search.limit,
            },
          },
        }
      : {}),
  };
}

export function activeToolNamesAfterVisibilityChange(input: {
  readonly activeNames: readonly string[];
  readonly deferredToolNames: readonly string[];
  readonly controlToolNames: readonly string[];
}): string[] {
  const active = new Set(input.activeNames);
  const hasDeferred = input.deferredToolNames.some((name) => !active.has(name));
  const controls = new Set(input.controlToolNames);
  if (!hasDeferred) return input.activeNames.filter((name) => !controls.has(name));
  return [...input.activeNames, ...input.controlToolNames.filter((name) => !active.has(name))];
}

export function narrowToolVisibilityPlan(
  plan: AgentLoopToolVisibilityPlan | undefined,
  allowedToolNames: readonly string[],
  definitions: readonly ToolDefinition[],
  countTokens: ((serializedDefinition: string) => number) | undefined,
): AgentLoopToolVisibilityPlan | undefined {
  if (plan === undefined || countTokens === undefined) return undefined;
  const allowed = new Set(allowedToolNames);
  const deferredTools = plan.deferredTools.filter((tool) => allowed.has(tool.name));
  if (deferredTools.length === 0) return undefined;
  const deferredNames = new Set(deferredTools.map((tool) => tool.name));
  const narrowedDefinitions = definitions.filter((definition) => allowed.has(definition.name));
  const initiallyVisibleDefinitions = narrowedDefinitions.filter((definition) => !deferredNames.has(definition.name));
  if (!isProgressiveToolVisibilityCostEffective({
    directDefinitions: narrowedDefinitions,
    deferredDefinitions: narrowedDefinitions.filter((definition) => deferredNames.has(definition.name)),
    progressiveDefinitions: [
      ...initiallyVisibleDefinitions,
      plan.controls.search,
      plan.controls.load,
    ],
    costGate: plan.costGate,
    countTokens,
  })) {
    return undefined;
  }
  return {
    ...plan,
    initiallyVisibleToolNames: initiallyVisibleDefinitions.map((definition) => definition.name),
    deferredTools,
    controls: {
      search: globalThis.structuredClone(plan.controls.search),
      load: globalThis.structuredClone(plan.controls.load),
    },
  };
}

function createVisibilityControlTool(input: {
  readonly definition: ToolDefinition;
  readonly host: VisibilityControlHost;
  readonly execute: (request: ToolCallRequest) => Promise<VisibilityControlExecutionResult>;
}): AgentTool {
  return {
    name: input.definition.name,
    label: input.definition.name,
    description: modelVisibleToolDescription(input.definition),
    parameters: Type.Unsafe(globalThis.structuredClone(input.definition.inputSchema)),
    executionMode: "parallel",
    async execute(callId, parameters, signal) {
      const startedAt = Date.now();
      let request: ToolCallRequest;
      const binding = input.host.resolveInvocationId(callId);
      if (binding === undefined) {
        // The harness violated the identity contract: every execute() call
        // must be preceded by a binding from the owner. Refuse to fabricate
        // a result; let the harness surface a maintenance failure with the
        // canonical provider call id so Ordinary can report the conflict.
        input.host.recordMaintenanceFailure({
          code: "tool_visibility_invocation_missing",
          error: `Visibility control invoked execute for ${callId} before the owner bound an invocation id.`,
        });
        throw new Error(`Visibility control invoked execute for ${callId} before the owner bound an invocation id.`);
      }
      try {
        const unscopedRequest: ToolCallRequest = {
          providerCallId: callId,
          invocationId: binding.invocationId,
          ...(binding.parentInvocationId === undefined ? {} : { parentInvocationId: binding.parentInvocationId }),
          toolName: input.definition.name,
          input: normalizeToolFactValue(parameters),
        };
        request = input.host.requestScope?.(unscopedRequest) ?? unscopedRequest;
      } catch (error) {
        const unscopedRequest: ToolCallRequest = {
          providerCallId: callId,
          invocationId: binding.invocationId,
          ...(binding.parentInvocationId === undefined ? {} : { parentInvocationId: binding.parentInvocationId }),
          toolName: input.definition.name,
          input: undefined,
        };
        request = input.host.requestScope?.(unscopedRequest) ?? unscopedRequest;
        input.host.onToolRequested(request);
        input.host.onToolInvoked?.();
        const result = visibilityControlFailure(request, errorMessage(error), "tool_visibility_invalid_input", startedAt);
        const acceptanceFailure = await input.host.acceptResult(result);
        return acceptanceFailure ?? input.host.projectResult(result, false);
      }
      input.host.onToolRequested(request);
      input.host.onToolInvoked?.();
      const abortSignal = signal ?? input.host.abortSignal;
      let execution: VisibilityControlExecutionResult;
      if (abortSignal.aborted) {
        execution = {
          result: visibilityControlCancellation(request, abortSignal.reason, startedAt),
        };
      } else {
        try {
          execution = await input.execute(request);
        } catch (error) {
          execution = abortSignal.aborted
            ? { result: visibilityControlCancellation(request, abortSignal.reason ?? error, startedAt) }
            : {
                result: visibilityControlFailure(
                  request,
                  errorMessage(error),
                  "tool_visibility_control_failed",
                  startedAt,
                ),
              };
        }
      }
      const acceptanceFailure = await input.host.acceptResult(execution.result);
      if (acceptanceFailure !== undefined) {
        try {
          await execution.rollback?.();
        } catch (error) {
          input.host.recordMaintenanceFailure({
            code: "tool_visibility_activation_rollback_failed",
            error: `Tool visibility activation could not be rolled back after result acceptance failed: ${errorMessage(error)}`,
          });
        }
        return acceptanceFailure;
      }
      return input.host.projectResult(
        execution.result,
        execution.result.status === "cancelled",
        execution.addedToolNames,
      );
    },
  };
}

function searchDeferredTools(
  request: ToolCallRequest,
  deferredTools: AgentLoopToolVisibilityPlan["deferredTools"],
  activeToolNames: readonly string[],
): ToolCallResult {
  const startedAt = Date.now();
  let search: VisibilitySearchInput;
  try {
    search = parseVisibilitySearchInput(request.input);
  } catch (error) {
    return visibilityControlFailure(request, errorMessage(error), "tool_visibility_invalid_input", startedAt);
  }
  return {
    ...request,
    output: searchDeferredToolCatalog({ search, deferredTools, activeToolNames }),
    status: "completed",
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

async function loadDeferredTools(input: {
  readonly request: ToolCallRequest;
  readonly deferredTools: AgentLoopToolVisibilityPlan["deferredTools"];
  readonly controlToolNames: readonly string[];
  readonly harness: AgentHarness;
  readonly mutateVisibilityState: VisibilityStateMutation;
}): Promise<VisibilityControlExecutionResult> {
  const startedAt = Date.now();
  let requestedNames: readonly string[];
  try {
    requestedNames = parseVisibilityLoadInput(input.request.input);
  } catch (error) {
    return {
      result: visibilityControlFailure(
        input.request,
        errorMessage(error),
        "tool_visibility_invalid_input",
        startedAt,
      ),
    };
  }
  const loadable = new Set(input.deferredTools.map((tool) => tool.name));
  const invalid = requestedNames.filter((name) => !loadable.has(name));
  if (invalid.length > 0) {
    return {
      result: visibilityControlFailure(
        input.request,
        `Requested MCP tools are not loadable in this frozen run: ${invalid.join(", ")}.`,
        "tool_visibility_tool_not_loadable",
        startedAt,
        { invalidToolNames: invalid },
      ),
    };
  }
  return input.mutateVisibilityState(async () => {
    const activeBeforeNames = input.harness.getActiveTools().map((tool) => tool.name);
    const activeBefore = new Set(activeBeforeNames);
    const activatedToolNames = requestedNames.filter((name) => !activeBefore.has(name));
    const alreadyLoaded = requestedNames.filter((name) => activeBefore.has(name));
    if (activatedToolNames.length > 0) {
      await input.harness.setActiveTools(activeToolNamesAfterVisibilityChange({
        activeNames: [...activeBeforeNames, ...activatedToolNames],
        deferredToolNames: input.deferredTools.map((tool) => tool.name),
        controlToolNames: input.controlToolNames,
      }));
    }
    const activeAfter = new Set(input.harness.getActiveTools().map((tool) => tool.name));
    const output: ToolFactValue = {
      kind: TOOL_VISIBILITY_ACTIVATION_KIND,
      activatedToolNames,
      alreadyLoaded,
      remainingDeferredToolCount: input.deferredTools.filter((tool) => !activeAfter.has(tool.name)).length,
      availableFrom: "next_model_request",
    };
    return {
      result: {
        ...input.request,
        output,
        status: "completed",
        durationMs: Math.max(0, Date.now() - startedAt),
      },
      ...(activatedToolNames.length === 0 ? {} : { addedToolNames: activatedToolNames }),
      ...(activatedToolNames.length === 0
        ? {}
        : {
            rollback: () => input.mutateVisibilityState(async () => {
              const activated = new Set(activatedToolNames);
              const currentNames = input.harness.getActiveTools().map((tool) => tool.name);
              await input.harness.setActiveTools(activeToolNamesAfterVisibilityChange({
                activeNames: currentNames.filter((name) => !activated.has(name)),
                deferredToolNames: input.deferredTools.map((tool) => tool.name),
                controlToolNames: input.controlToolNames,
              }));
            }),
          }),
    };
  });
}

function parseVisibilitySearchInput(value: ToolFactValue | undefined): VisibilitySearchInput {
  const record = requireToolInputRecord(value, "McpSearch");
  const query = record.query;
  const serverId = record.server_id;
  const cursor = record.cursor ?? 0;
  const limit = record.limit ?? 10;
  if (query !== undefined && (typeof query !== "string" || query.trim().length === 0 || query.length > 200)) {
    throw new Error("McpSearch query must be a non-empty string of at most 200 characters.");
  }
  if (serverId !== undefined && (typeof serverId !== "string" || serverId.trim().length === 0 || serverId.length > 128)) {
    throw new Error("McpSearch server_id must be a non-empty string of at most 128 characters.");
  }
  if (!Number.isSafeInteger(cursor) || typeof cursor !== "number" || cursor < 0) {
    throw new Error("McpSearch cursor must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(limit) || typeof limit !== "number" || limit < 1 || limit > 20) {
    throw new Error("McpSearch limit must be a safe integer between 1 and 20.");
  }
  return {
    ...(query === undefined ? {} : { query }),
    ...(serverId === undefined ? {} : { serverId }),
    cursor,
    limit,
  };
}

function parseVisibilityLoadInput(value: ToolFactValue | undefined): readonly string[] {
  const record = requireToolInputRecord(value, "McpLoad");
  const names = record.tool_names;
  if (!Array.isArray(names) || names.length < 1 || names.length > 16 ||
      names.some((name) => typeof name !== "string" || name.trim().length === 0 || name.length > 128)) {
    throw new Error("McpLoad tool_names must contain between 1 and 16 non-empty tool names.");
  }
  const normalized = names as string[];
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("McpLoad tool_names must be unique.");
  }
  return normalized;
}

function requireToolInputRecord(
  value: ToolFactValue | undefined,
  toolName: string,
): Readonly<Record<string, ToolFactValue | undefined>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${toolName} requires an object input.`);
  }
  return value as Readonly<Record<string, ToolFactValue | undefined>>;
}

function requireBoundHarness(harness: AgentHarness | undefined): AgentHarness {
  if (harness === undefined) {
    throw new Error("Progressive tool visibility controller is not bound to its AgentHarness.");
  }
  return harness;
}

function visibilityControlFailure(
  request: ToolCallRequest,
  error: string,
  code: string,
  startedAt: number,
  facts: Readonly<Record<string, string | readonly string[]>> = {},
): ToolCallResult {
  return {
    ...request,
    output: undefined,
    status: "failed",
    error,
    errorDomain: "runtime_error",
    errorFacts: { code, doNotBlindlyRetry: true, ...facts },
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function visibilityControlCancellation(
  request: ToolCallRequest,
  reason: unknown,
  startedAt: number,
): ToolCallResult {
  return {
    ...request,
    output: undefined,
    status: "cancelled",
    error: `Tool visibility control was cancelled: ${abortMessage(reason)}`,
    errorDomain: "runtime_error",
    errorFacts: { code: "tool_visibility_control_cancelled" },
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function assertUniqueToolNameList(names: readonly string[], label: string): void {
  if (new Set(names).size !== names.length) {
    throw new Error(`Progressive tool visibility ${label} names contain duplicates.`);
  }
}

function assertUniqueToolNames(tools: readonly AgentTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Agent session tool name is duplicated: ${tool.name}`);
    names.add(tool.name);
  }
}

function abortMessage(reason: unknown): string {
  return reason === undefined ? "cancelled" : errorMessage(reason);
}
