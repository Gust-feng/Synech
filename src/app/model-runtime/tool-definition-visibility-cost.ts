import type { ConfiguredModelProtocolKind } from "../../domain/config/index.js";
import {
  modelVisibleToolDescription,
  type ToolDefinition,
} from "../../domain/tools/index.js";

export type ModelVisibleToolDefinitionTokenCounter = (serializedDefinitions: string) => number;

export type ModelVisibleToolDefinitionSerialization = {
  readonly api: "anthropic-messages" | "openai-completions" | "openai-responses";
  /** OpenAI-compatible Chat providers may reject the optional `strict` field. */
  readonly includeStrict: boolean;
  readonly anthropicEagerInput?: boolean;
};

export function toolDefinitionSerializationApiForProtocol(
  protocolKind: ConfiguredModelProtocolKind,
): ModelVisibleToolDefinitionSerialization["api"] | undefined {
  switch (protocolKind) {
    case "native":
      return undefined;
    case "anthropic_messages":
      return "anthropic-messages";
    case "openai_compatible_chat_completions":
      return "openai-completions";
    case "openai_responses":
      return "openai-responses";
    default: {
      const unsupportedProtocolKind: never = protocolKind;
      throw new Error(`Model visible tool definitions do not support protocol kind ${JSON.stringify(unsupportedProtocolKind)}.`);
    }
  }
}

const MAX_DIRECT_TOOL_DEFINITION_CONTEXT_SHARE = 0.1;
const MAX_DIRECT_TOOL_DEFINITION_TOKENS = 20_000;
const MIN_NET_SAVINGS_CONTEXT_SHARE = 0.0025;
const MIN_NET_SAVINGS_TOKENS = 256;
const MAX_NET_SAVINGS_TOKENS = 1_024;

export type ProgressiveToolVisibilityCostGate = {
  readonly minimumDeferredDefinitionTokens: number;
  readonly minimumNetDefinitionSavingsTokens: number;
  readonly definitionSerialization: ModelVisibleToolDefinitionSerialization;
};

/**
 * Progressive tool visibility uses the frozen effective context budget, including
 * an explicit user setting or the product default for an unconfirmed model.
 * It changes exposure cost, not the authorized tool set or catalog facts.
 */
export function progressiveToolVisibilityCostGate(
  contextWindowTokens: number | undefined,
  definitionSerialization: ModelVisibleToolDefinitionSerialization,
): ProgressiveToolVisibilityCostGate | undefined {
  if (contextWindowTokens === undefined || !Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) return undefined;
  return {
    minimumDeferredDefinitionTokens: Math.min(
      MAX_DIRECT_TOOL_DEFINITION_TOKENS,
      Math.ceil(contextWindowTokens * MAX_DIRECT_TOOL_DEFINITION_CONTEXT_SHARE),
    ),
    minimumNetDefinitionSavingsTokens: Math.min(
      MAX_NET_SAVINGS_TOKENS,
      Math.max(
        MIN_NET_SAVINGS_TOKENS,
        Math.ceil(contextWindowTokens * MIN_NET_SAVINGS_CONTEXT_SHARE),
      ),
    ),
    definitionSerialization: { ...definitionSerialization },
  };
}

/**
 * Pre-request cost estimate for Synech's non-constrained tools. Runtime metrics
 * use the assembled provider payload instead. Cache/auth decorations are not
 * inferred here; capability and schema fields follow the frozen Pi model.
 */
export function serializeModelVisibleToolDefinitions(
  definitions: readonly ToolDefinition[],
  serialization: ModelVisibleToolDefinitionSerialization,
): readonly Readonly<Record<string, unknown>>[] {
  assertSupportedDefinitionSerializationApi(serialization.api);
  if (serialization.api === "anthropic-messages") {
    return definitions.map((definition) => ({
      name: definition.name,
      description: modelVisibleToolDescription(definition),
      ...(serialization.anthropicEagerInput === false ? {} : { eager_input_streaming: true }),
      input_schema: {
        type: "object",
        properties: definition.inputSchema.properties ?? {},
        required: definition.inputSchema.required ?? [],
      },
    }));
  }
  if (serialization.api === "openai-completions") {
    return definitions.map((definition) => ({
      type: "function",
      function: {
        name: definition.name,
        description: modelVisibleToolDescription(definition),
        parameters: definition.inputSchema,
        ...(serialization.includeStrict ? { strict: false } : {}),
      },
    }));
  }
  return definitions.map((definition) => ({
    type: "function",
    name: definition.name,
    description: modelVisibleToolDescription(definition),
    parameters: definition.inputSchema,
    strict: false,
  }));
}

/**
 * Progressive visibility is an optimization, so uncertainty keeps the complete
 * authorized definition set visible. The gate requires a material share of the
 * model window, caps that threshold for very large windows, and prevents control
 * tools from costing more than the definitions they replace.
 */
export function isProgressiveToolVisibilityCostEffective(input: {
  readonly directDefinitions: readonly ToolDefinition[];
  readonly deferredDefinitions: readonly ToolDefinition[];
  readonly progressiveDefinitions: readonly ToolDefinition[];
  readonly costGate: ProgressiveToolVisibilityCostGate;
  readonly countTokens: ModelVisibleToolDefinitionTokenCounter;
}): boolean {
  if (!validCostGate(input.costGate)) {
    return false;
  }
  try {
    const directTokens = countDefinitionSetTokens(
      input.directDefinitions,
      input.costGate.definitionSerialization,
      input.countTokens,
    );
    const deferredTokens = countDefinitionSetTokens(
      input.deferredDefinitions,
      input.costGate.definitionSerialization,
      input.countTokens,
    );
    const progressiveTokens = countDefinitionSetTokens(
      input.progressiveDefinitions,
      input.costGate.definitionSerialization,
      input.countTokens,
    );
    if (directTokens === undefined || deferredTokens === undefined || progressiveTokens === undefined) return false;
    if (deferredTokens < input.costGate.minimumDeferredDefinitionTokens) {
      return false;
    }
    return directTokens - progressiveTokens >= input.costGate.minimumNetDefinitionSavingsTokens;
  } catch {
    return false;
  }
}

function validCostGate(gate: ProgressiveToolVisibilityCostGate): boolean {
  assertSupportedDefinitionSerializationApi(gate.definitionSerialization.api);
  return Number.isSafeInteger(gate.minimumDeferredDefinitionTokens) &&
    gate.minimumDeferredDefinitionTokens >= 0 &&
    Number.isSafeInteger(gate.minimumNetDefinitionSavingsTokens) &&
    gate.minimumNetDefinitionSavingsTokens >= 0 &&
    typeof gate.definitionSerialization.includeStrict === "boolean";
}

function assertSupportedDefinitionSerializationApi(
  api: ModelVisibleToolDefinitionSerialization["api"],
): void {
  switch (api) {
    case "openai-completions":
    case "openai-responses":
    case "anthropic-messages":
      return;
    default: {
      const unsupportedApi: never = api;
      throw new Error(`Model visible tool definitions do not support api ${JSON.stringify(unsupportedApi)}.`);
    }
  }
}

function countDefinitionSetTokens(
  definitions: readonly ToolDefinition[],
  serialization: ModelVisibleToolDefinitionSerialization,
  countTokens: ModelVisibleToolDefinitionTokenCounter,
): number | undefined {
  if (definitions.length === 0) return 0;
  const value = countTokens(JSON.stringify(serializeModelVisibleToolDefinitions(definitions, serialization)));
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
