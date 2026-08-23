import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type OpenAICompletionsCompat,
  type OpenAIResponsesCompat,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { OpenAIModelRequestSettings, ProviderProtocolProfileId } from "../../domain/config/index.js";
import type { ModelProtocolKind } from "../../domain/intelligence/index.js";
import { configuredOpenAIParallelToolCalls } from "./openai-request-settings.js";
import {
  applyOpenAICompatibleChatDialectControls,
  applyOpenAICompatibleChatRequestPolicy,
  resolveOpenAICompatibleChatDialect,
} from "./openai-compatible-chat-protocol.js";
import type { ToolDefinition } from "../../domain/tools/index.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const PROVIDER_ID_PREFIX = "synech";

export type ModelProviderBindingOptions = {
  readonly protocol: ModelProtocolKind;
  readonly baseUrl: string;
  readonly model: string;
  /** Stable profile identity used for the Pi provider registry key. */
  readonly profileId: string;
  readonly apiKey?: string;
  readonly resolveApiKey?: () => string | undefined | Promise<string | undefined>;
  readonly providerProfileId?: ProviderProtocolProfileId;
  readonly requestSettings?: OpenAIModelRequestSettings;
  /** Frozen model capability used to advertise image input to Pi. */
  readonly supportsVisionInput?: boolean;
  /** Enables the Responses provider's hosted web-search tool for this frozen run. */
  readonly enableWebSearch?: boolean;
  /** Frozen capability fact; independent from whether this request accepts an effort control. */
  readonly supportsReasoningOutput?: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
};

export type ModelProviderBinding = {
  readonly modelRegistry: Models;
  readonly selectedModel: Model<Api>;
  /** Pi's native thinking control corresponding to the frozen provider setting. */
  readonly thinkingLevel: ThinkingLevel;
  /** Public Pi payload hook used to preserve frozen OpenAI-compatible request settings. */
  readonly transformProviderPayload?: ModelProviderPayloadTransformer;
};

export type ModelProviderPayloadTransformer = (input: {
  readonly model: Model<Api>;
  readonly payload: unknown;
  readonly tools: readonly ToolDefinition[];
}) => unknown;

export type ModelProviderBindingFactories = {
  readonly createChatCompletionsTransport?: () => ProviderStreams;
  readonly createResponsesTransport?: () => ProviderStreams;
};

/**
 * Builds one provider collection from the frozen run configuration.
 * API key resolution stays at the provider boundary and runs for every model request.
 */
export function createModelProviderBinding(
  options: ModelProviderBindingOptions,
  factories: ModelProviderBindingFactories = {},
): ModelProviderBinding {
  const providerApiKind = resolveProviderApiKind(options.protocol);
  const providerId = buildProviderId(options.profileId);
  const configuredModel = createConfiguredProviderModel(options, providerId, providerApiKind);
  const provider = createProvider({
    id: providerId,
    name: options.providerProfileId ?? "OpenAI-compatible",
    baseUrl: options.baseUrl,
    auth: {
      apiKey: {
        name: `${providerId} API key`,
        resolve: async () => {
          const apiKey = options.resolveApiKey === undefined
            ? options.apiKey
            : await options.resolveApiKey();
          return apiKey === undefined || apiKey.trim().length === 0
            ? undefined
            : {
                auth: { apiKey },
                source: options.resolveApiKey === undefined ? "frozen config" : "dynamic resolver",
              };
        },
      },
    },
    models: [configuredModel],
    api: providerApiKind === "openai-completions"
      ? (factories.createChatCompletionsTransport ?? openAICompletionsApi)()
      : (factories.createResponsesTransport ?? openAIResponsesApi)(),
  });
  const modelRegistry = createModels();
  modelRegistry.setProvider(provider);
  const selectedModel = modelRegistry.getModel(providerId, options.model);
  if (selectedModel === undefined) {
    throw new Error(`Provider ${providerId} did not register model ${options.model}.`);
  }
  const transformProviderPayload = options.protocol === "openai_compatible_chat_completions" ||
    options.requestSettings !== undefined ||
    options.enableWebSearch === true
    ? createProviderPayloadTransformer(
        options.requestSettings,
        options.providerProfileId,
        options.baseUrl,
        options.model,
        options.enableWebSearch === true,
      )
    : undefined;
  return {
    modelRegistry,
    selectedModel,
    thinkingLevel: thinkingLevelFromSettings(options.requestSettings?.reasoningEffort),
    ...(transformProviderPayload === undefined ? {} : { transformProviderPayload }),
  };
}

function resolveProviderApiKind(protocol: ModelProtocolKind): "openai-completions" | "openai-responses" {
  return protocol === "openai_compatible_chat_completions"
    ? "openai-completions"
    : "openai-responses";
}

function buildProviderId(profileId: string): string {
  const suffix = profileId.trim();
  if (suffix.length === 0) {
    throw new Error("Model provider profileId must not be blank.");
  }
  return `${PROVIDER_ID_PREFIX}-${suffix}`;
}

function createConfiguredProviderModel(
  options: ModelProviderBindingOptions,
  providerId: string,
  api: "openai-completions" | "openai-responses",
): Model<typeof api> {
  const compat = createProviderCompat(options, api);
  return {
    id: options.model,
    name: options.model,
    api,
    provider: providerId,
    baseUrl: options.baseUrl,
    reasoning: options.supportsReasoningOutput ??
      (options.requestSettings?.reasoningEffort !== undefined && options.requestSettings.reasoningEffort !== "none"),
    // Pi's model.input is the final transport capability gate. An omitted
    // declaration is unknown, so never advertise image input by default.
    input: options.supportsVisionInput === true ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: positiveInteger(options.contextWindow, DEFAULT_CONTEXT_WINDOW, "contextWindow"),
    maxTokens: positiveInteger(
      options.maxOutputTokens ?? options.requestSettings?.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS,
      "maxOutputTokens",
    ),
    ...(compat === undefined ? {} : { compat }),
  };
}

function createProviderCompat(
  options: ModelProviderBindingOptions,
  api: "openai-completions" | "openai-responses",
): OpenAICompletionsCompat | OpenAIResponsesCompat | undefined {
  if (api === "openai-responses") {
    // Provider identity does not prove that the selected model supports native
    // tool search. Keep it disabled until the frozen model capability says so.
    return undefined;
  }

  const dialect = resolveOpenAICompatibleChatDialect({
    providerProfileId: options.providerProfileId,
    baseUrl: options.baseUrl,
    model: options.model,
  });
  switch (dialect.profileId) {
    case "openai":
      return {
        supportsStore: true,
        supportsDeveloperRole: true,
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
        normalizeCumulativeDeltas: false,
        thinkingFormat: "openai",
      };
    case "deepseek":
      return {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
        normalizeCumulativeDeltas: false,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      };
    case "moonshot":
      return {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        normalizeCumulativeDeltas: false,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
        thinkingFormat: "deepseek",
        ...(options.model.toLowerCase().includes("kimi-k3")
          ? {
              requiresReasoningContentOnAssistantMessages: true,
            }
          : {}),
      };
    case "glm":
      return {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        // Z.AI returns usage on the terminal stream chunk without requiring
        // the OpenAI stream_options request extension.
        supportsUsageInStreaming: false,
        normalizeCumulativeDeltas: false,
        thinkingFormat: "zai",
        ...(dialect.reasoningControl === "thinking_enabled_disabled"
          ? { zaiToolStream: true }
          : {}),
      };
    case "minimax":
      return {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: true,
        normalizeCumulativeDeltas: true,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
        thinkingFormat: "openai",
      };
    default:
      return undefined;
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Model ${name} must be a positive safe integer.`);
  }
  return value;
}

function thinkingLevelFromSettings(
  effort: OpenAIModelRequestSettings["reasoningEffort"] | undefined,
): ThinkingLevel {
  switch (effort) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return effort;
    case "none":
    case undefined:
      return "off";
  }
}

function createProviderPayloadTransformer(
  settings: OpenAIModelRequestSettings | undefined,
  providerProfileId: ProviderProtocolProfileId | undefined,
  baseUrl: string,
  modelId: string,
  enableWebSearch: boolean,
): ModelProviderPayloadTransformer {
  return ({ model, payload, tools }) => {
    const record = asRecord(payload);
    if (record === undefined) return payload;
    if (model.api === "openai-completions") {
      const dialect = resolveOpenAICompatibleChatDialect({
        providerProfileId,
        baseUrl,
        model: modelId,
      });
      const withSettings = withFields(record, {
        stream: settings?.stream,
        temperature: settings?.temperature,
        top_p: settings?.topP,
        reasoning_effort: settings?.reasoningEffort,
        parallel_tool_calls: configuredOpenAIParallelToolCalls(tools, settings),
      });
      return applyOpenAICompatibleChatRequestPolicy({
        fields: applyOpenAICompatibleChatDialectControls({
          fields: withSettings,
          dialect,
          settings,
        }),
        dialect,
      });
    }
    if (model.api === "openai-responses") {
      const reasoningSummary = settings?.reasoningSummary ??
        (settings?.reasoningEffort === undefined || settings.reasoningEffort === "none" ? undefined : "auto");
      const text = withFields(asRecord(record.text) ?? {}, {
        verbosity: settings?.textVerbosity,
      });
      const reasoning = withFields(asRecord(record.reasoning) ?? {}, {
        summary: reasoningSummary,
      });
      const providerTools = providerToolsWithHostedWebSearch(record.tools, enableWebSearch);
      return withFields(record, {
        stream: settings?.stream,
        temperature: settings?.temperature,
        top_p: settings?.topP,
        service_tier: settings?.serviceTier,
        truncation: settings?.truncation,
        parallel_tool_calls: configuredOpenAIParallelToolCalls(tools, settings, { includeWithoutTools: true }),
        store: settings?.store,
        text: Object.keys(text).length === 0 ? undefined : text,
        reasoning: Object.keys(reasoning).length === 0 ? undefined : reasoning,
        tools: providerTools,
      });
    }
    return payload;
  };
}

function providerToolsWithHostedWebSearch(
  value: unknown,
  enabled: boolean,
): readonly unknown[] | undefined {
  if (!enabled) return undefined;
  const tools = Array.isArray(value) ? [...value] : [];
  const alreadyIncluded = tools.some((tool) => asRecord(tool)?.type === "web_search");
  return alreadyIncluded
    ? tools
    : [...tools, { type: "web_search", search_context_size: "medium" }];
}

function withFields(
  source: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result = { ...source };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
