import type { OpenAIModelRequestSettings } from "../../domain/config/index.js";
import type { ToolDefinition } from "../../domain/tools/index.js";

export function configuredOpenAIStream(
  requestedStream: boolean,
  settings: OpenAIModelRequestSettings | undefined,
  options: {
    readonly forceStreaming?: boolean;
  } = {}
): boolean {
  if (!requestedStream) {
    return false;
  }
  if (options.forceStreaming === true) {
    return true;
  }
  return settings?.stream !== false;
}

export function configuredOpenAIOutputTokenLimit(
  requestBudgetMaxOutputTokens: number | undefined,
  settings: OpenAIModelRequestSettings | undefined
): number | undefined {
  const configured = settings?.maxOutputTokens;
  if (configured === undefined) {
    return requestBudgetMaxOutputTokens;
  }
  if (requestBudgetMaxOutputTokens === undefined) {
    return configured;
  }
  return Math.min(requestBudgetMaxOutputTokens, configured);
}

export function buildOpenAIResponsesControlFields(input: {
  readonly requestBudgetMaxOutputTokens?: number;
  readonly settings?: OpenAIModelRequestSettings;
  readonly tools?: readonly ToolDefinition[];
}): Record<string, unknown> | undefined {
  const settings = input.settings;
  return cleanRecord({
    temperature: settings?.temperature,
    top_p: settings?.topP,
    max_output_tokens: configuredOpenAIOutputTokenLimit(input.requestBudgetMaxOutputTokens, settings),
    reasoning: cleanRecord({
      effort: settings?.reasoningEffort,
      summary: configuredOpenAIReasoningSummary(settings),
    }),
    text: cleanRecord({
      verbosity: settings?.textVerbosity,
    }),
    service_tier: settings?.serviceTier,
    truncation: settings?.truncation,
    parallel_tool_calls: configuredOpenAIParallelToolCalls(input.tools, settings, {
      includeWithoutTools: true,
    }),
    store: settings?.store,
  });
}

function configuredOpenAIReasoningSummary(
  settings: OpenAIModelRequestSettings | undefined
): OpenAIModelRequestSettings["reasoningSummary"] | undefined {
  if (settings?.reasoningSummary !== undefined) {
    return settings.reasoningSummary;
  }
  return settings?.reasoningEffort === undefined || settings.reasoningEffort === "none"
    ? undefined
    : "auto";
}

export function buildOpenAIChatCompletionsControlFields(input: {
  readonly requestBudgetMaxOutputTokens?: number;
  readonly settings?: OpenAIModelRequestSettings;
  readonly tools?: readonly ToolDefinition[];
}): Record<string, unknown> | undefined {
  const settings = input.settings;
  return cleanRecord({
    temperature: settings?.temperature,
    top_p: settings?.topP,
    max_completion_tokens: configuredOpenAIOutputTokenLimit(input.requestBudgetMaxOutputTokens, settings),
    reasoning_effort: settings?.reasoningEffort,
    parallel_tool_calls: configuredOpenAIParallelToolCalls(input.tools, settings),
  });
}

export function configuredOpenAIParallelToolCalls(
  tools: readonly ToolDefinition[] | undefined,
  settings: OpenAIModelRequestSettings | undefined,
  options: {
    readonly includeWithoutTools?: boolean;
  } = {}
): boolean | undefined {
  if ((tools === undefined || tools.length === 0) && options.includeWithoutTools !== true) {
    return undefined;
  }
  if (tools !== undefined && tools.length > 0 && tools.some((tool) => tool.metadata?.operationType !== "read-only")) {
    return false;
  }
  return settings?.parallelToolCalls;
}

export function cleanRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  const compacted = entries.filter(([, value]) => !isEmptyPlainRecord(value));
  return compacted.length === 0 ? undefined : Object.fromEntries(compacted);
}

function isEmptyPlainRecord(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0;
}
