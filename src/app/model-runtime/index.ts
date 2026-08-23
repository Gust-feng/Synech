import type { ModelCapabilities } from "../../domain/config/index.js";
import type { ModelRequest, ModelToolChoice } from "../../domain/intelligence/index.js";
import {
  cloneToolInputSchema,
  cloneToolJsonSchema,
  type ToolDefinition,
  type ToolDefinitionMetadata,
} from "../../domain/tools/index.js";

export {
  fetchModelRuntimeModelCatalog,
  ModelRuntimeConfigurationError,
} from "./factory.js";

export type {
  ModelRuntimeConfigurationIssueCode,
  ModelRuntimeChannelFactory,
  ModelRuntimeEnvironment,
  ModelRuntimeModelCatalogFetch,
  ModelRuntimeSummaryInput,
} from "./factory.js";
export type { ModelRuntimeMode, OrdinaryModelRuntimeMode } from "./contracts.js";
export type {
  AgentLoop,
  AgentLoopContinuation,
  AgentLoopInput,
  AgentLoopAgentTool,
  AgentLoopAgentToolInvocation,
  AgentLoopDeferredToolCatalogEntry,
  AgentLoopResult,
  AgentLoopToolVisibilityPlan,
  AgentLoopToolBoundary,
} from "./agent-loop.js";
export type {
  AgentSessionExecutionRefs,
  AgentSessionEntryRef,
  AgentSessionAssistantEntry,
  AgentSessionRef,
  AgentSessionRepository,
  AgentSessionWriteCheckpoint,
} from "./agent-session.js";
export {
  canonicalToolResultMessage,
} from "./tool-result-message.js";
export {
  isProgressiveToolVisibilityCostEffective,
  progressiveToolVisibilityCostGate,
  serializeModelVisibleToolDefinitions,
  type ModelVisibleToolDefinitionTokenCounter,
  type ProgressiveToolVisibilityCostGate,
} from "./tool-definition-visibility-cost.js";

export type ModelRuntimeRequestPlan = {
  readonly requestId: string;
  readonly toolChoice: ModelToolChoice;
  readonly tools: readonly ToolDefinition[];
  readonly parallelToolCalls: boolean;
  readonly strictToolSchemas: boolean;
  readonly budget: {
    readonly maxInputTokens?: number;
    readonly maxOutputTokens?: number;
    readonly maxTotalTokens?: number;
  };
  readonly warnings: readonly string[];
};

export function createModelRuntimeRequestPlan(input: {
  readonly request: ModelRequest;
  readonly modelCapabilities: ModelCapabilities;
  readonly tools?: readonly ToolDefinition[];
}): ModelRuntimeRequestPlan {
  const usableTools = input.modelCapabilities.supportsToolCalling
    ? (input.tools ?? input.request.tools ?? [])
    : [];
  const strictToolSchemas = input.modelCapabilities.supportsStructuredOutputs;
  const tools = strictToolSchemas ? usableTools.map(toStrictToolDefinition) : usableTools.map(cloneToolDefinition);
  const readOnlyOnly = tools.every((tool) => tool.metadata?.operationType === "read-only");
  const parallelToolCalls = Boolean(
    input.modelCapabilities.supportsParallelToolCalls &&
    tools.length > 0 &&
    readOnlyOnly
  );
  const maxOutputTokens = Math.min(
    input.request.budget.maxOutputTokens ?? input.modelCapabilities.maxOutputTokens,
    input.modelCapabilities.maxOutputTokens
  );
  return {
    requestId: input.request.requestId,
    toolChoice: tools.length === 0 ? "none" : input.request.toolChoice ?? "auto",
    tools,
    parallelToolCalls,
    strictToolSchemas,
    budget: {
      maxInputTokens: input.request.budget.maxInputTokens ?? conservativeInputBudget(input.modelCapabilities),
      maxOutputTokens,
      maxTotalTokens: input.modelCapabilities.contextWindowTokens,
    },
    warnings: requestPlanWarnings(input.modelCapabilities, input.tools ?? input.request.tools ?? [], tools, parallelToolCalls),
  };
}

function toStrictToolDefinition(tool: ToolDefinition): ToolDefinition {
  const cloned = cloneToolDefinition(tool);
  return {
    ...cloned,
    inputSchema: {
      ...cloned.inputSchema,
      additionalProperties: false,
      required: cloned.inputSchema.required,
    },
  };
}

function cloneToolDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: cloneToolInputSchema(tool.inputSchema),
    outputSchema:
      tool.outputSchema === undefined
        ? undefined
        : cloneToolJsonSchema(tool.outputSchema),
    metadata: tool.metadata === undefined ? undefined : {
      ...tool.metadata,
      runtimeHints: cloneRuntimeHints(tool.metadata.runtimeHints),
    },
  };
}

function cloneRuntimeHints(value: ToolDefinitionMetadata["runtimeHints"]): ToolDefinitionMetadata["runtimeHints"] {
  if (value === undefined) {
    return undefined;
  }
  return value.map((hint) => {
    if (hint.kind === "command_shell") {
      return {
        ...hint,
        invocation: [...hint.invocation],
        notes: [...hint.notes],
      };
    }
    return hint;
  });
}

function conservativeInputBudget(capabilities: ModelCapabilities): number {
  const reserved = Math.max(512, Math.min(capabilities.maxOutputTokens, Math.floor(capabilities.contextWindowTokens * 0.25)));
  const safety = Math.max(512, Math.floor(capabilities.contextWindowTokens * 0.05));
  return Math.max(1_000, capabilities.contextWindowTokens - reserved - safety);
}

function requestPlanWarnings(
  capabilities: ModelCapabilities,
  requestedTools: readonly ToolDefinition[],
  plannedTools: readonly ToolDefinition[],
  parallelToolCalls: boolean
): readonly string[] {
  const warnings: string[] = [];
  if (!capabilities.supportsToolCalling && requestedTools.length > 0) {
    warnings.push("当前模型能力未启用工具调用，本轮已关闭工具。");
  }
  if (plannedTools.length > 0 && !parallelToolCalls && plannedTools.some((tool) => tool.metadata?.operationType !== "read-only")) {
    warnings.push("本轮包含写入或执行类工具，已关闭并行工具调用。");
  }
  return warnings;
}
