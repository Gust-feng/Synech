import {
  modelVisibleToolDescription,
  type ToolDefinition,
} from "../../domain/tools/index.js";

export type ModelVisibleToolDefinitionTokenCounter = (serializedDefinitions: string) => number;

export type ModelVisibleToolDefinitionSerialization = {
  readonly api: "openai-completions" | "openai-responses";
  /** OpenAI-compatible Chat providers may reject the optional `strict` field. */
  readonly includeStrict: boolean;
};

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

export function progressiveToolVisibilityCostGate(
  contextWindowTokens: number,
  definitionSerialization: ModelVisibleToolDefinitionSerialization,
): ProgressiveToolVisibilityCostGate | undefined {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) return undefined;
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
 * Uses the same definition fields that Pi sends to providers. Output schemas and
 * execution metadata are deliberately absent because they do not consume model
 * context at this boundary.
 */
export function serializeModelVisibleToolDefinitions(
  definitions: readonly ToolDefinition[],
  serialization: ModelVisibleToolDefinitionSerialization,
): readonly Readonly<Record<string, unknown>>[] {
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
  return Number.isSafeInteger(gate.minimumDeferredDefinitionTokens) &&
    gate.minimumDeferredDefinitionTokens >= 0 &&
    Number.isSafeInteger(gate.minimumNetDefinitionSavingsTokens) &&
    gate.minimumNetDefinitionSavingsTokens >= 0 &&
    (gate.definitionSerialization.api === "openai-completions" ||
      gate.definitionSerialization.api === "openai-responses") &&
    typeof gate.definitionSerialization.includeStrict === "boolean";
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
