import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type {
  OpenAIModelRequestSettings,
  ModelConfiguration,
  ProviderProtocolProfileId,
} from "../../domain/config/index.js";
import type { ModelProtocolKind } from "../../domain/intelligence/index.js";
import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS } from "../../domain/config/model-configuration.js";
import { configurePiModel, resolveConfiguredModel } from "./model-catalog-binding.js";
import { configuredOpenAIParallelToolCalls } from "./openai-request-settings.js";
import {
  applyOpenAICompatibleChatRequestPolicy,
  resolveOpenAICompatibleChatDialect,
} from "./openai-compatible-chat-protocol.js";
import type { ToolDefinition } from "../../domain/tools/index.js";
import {
  createNativeModelProviderCollection,
  nativeModelProviderRegistryId,
  type NativeModelProviderCollection,
  type NativeModelProviderOptions,
} from "./native-model-provider.js";

/**
 * 未确认模型使用产品上下文预算；输出按 transport 省略或使用请求默认值。
 * 这些运行默认值不得变成已确认的目录事实。
 */
const UNCONFIRMED_MODEL_MAX_OUTPUT_TOKENS = 0;
// Messages requires a request budget, not a user-declared model capacity.
const DEFAULT_ANTHROPIC_REQUEST_OUTPUT_TOKENS = 4_096;
type ProviderApiKind = "anthropic-messages" | "openai-completions" | "openai-responses";

export type ModelProviderBindingOptions = NativeModelProviderOptions & {
  /** 连接级默认 transport；只有未知发现模型使用它。 */
  readonly protocol: ModelProtocolKind;
  readonly baseUrl: string;
  readonly model: string;
  /** Stable profile identity used for the Pi provider registry key. */
  readonly profileId: string;
  readonly apiKey?: string;
  readonly resolveApiKey?: () => string | undefined | Promise<string | undefined>;
  /**
   * 连接显式声明的目录作用域；未声明时自定义模型逐模型自动匹配。
   */
  readonly piProviderId?: string;
  /** 连接级 vendor 家族（连接显式事实，用于 pi 无 compat 的请求字段策略）。 */
  readonly providerProfileId?: ProviderProtocolProfileId;
  readonly requestSettings?: OpenAIModelRequestSettings;
  readonly modelConfiguration?: ModelConfiguration;
  /** Enables the Responses provider's hosted web-search tool for this frozen run. */
  readonly enableWebSearch?: boolean;
};

export type ModelProviderBinding = {
  readonly modelRegistry: Models;
  /** Native catalog facts stay unmodified even when run-local lookup applies user settings. */
  readonly catalogRegistry?: Models;
  readonly selectedModel: Model<Api>;
  /** 本次冻结请求的思考档位；pi 按模型真实 thinkingLevelMap 翻译并 clamp。 */
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
  readonly createAnthropicMessagesTransport?: () => ProviderStreams;
};

/**
 * Builds one provider collection from the frozen run configuration.
 *
 * Catalog lookup supplies automatic defaults; sparse per-model user settings
 * override them for this connection only. Generic gateways always retain their
 * declared API and exact upstream ID. Native services keep Pi's own transport,
 * authentication and model policy.
 *
 * API key resolution stays at the provider boundary and runs for every model request.
 */
export function createModelProviderBinding(
  options: ModelProviderBindingOptions,
  factories: ModelProviderBindingFactories = {},
): ModelProviderBinding {
  if (options.protocol === "native") {
    const collection = createNativeModelProviderCollection(options);
    const provider = collection.modelRegistry.getProvider(collection.providerId)!;
    if (provider.refreshModels !== undefined || provider.filterModels !== undefined) {
      throw new Error("This native provider requires createModelProviderBindingAsync initialization.");
    }
    return nativeBinding(options, collection);
  }
  if (options.enableWebSearch === true && options.protocol === "anthropic_messages") {
    // 产品内建 Web Search 只在 Responses transport 上有对应物；不静默丢弃开关。
    throw new Error("Built-in web search is not supported by the Anthropic Messages protocol binding.");
  }
  const discovered = resolveConfiguredModel({
    piProviderId: options.piProviderId,
    modelId: options.model,
    protocolKind: options.protocol,
  });
  const providerApiKind = resolveProviderApiKind(options.protocol);
  const providerId = buildProviderId(options.profileId);
  const configuredModel = configurePiModel(
    discovered.status === "known"
      ? knownProviderModel(discovered.model, options, providerId, providerApiKind)
      : unknownProviderModel(options, providerId, providerApiKind),
    options.modelConfiguration,
  );
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
    api: providerStreamsForApi(providerApiKind, factories),
  });
  const modelRegistry = createModels();
  modelRegistry.setProvider(provider);
  const selectedModel = modelRegistry.getModel(providerId, options.model);
  if (selectedModel === undefined) {
    throw new Error(`Provider ${providerId} did not register model ${options.model}.`);
  }
  if (selectedModel.api !== providerApiKind) {
    throw new Error(
      `Model ${options.model} registered Pi api ${JSON.stringify(selectedModel.api)} but protocol ${options.protocol} requires ${providerApiKind}.`,
    );
  }
  // Anthropic Messages 由 pi 直接构建 SDK 请求（含 thinking 字段），没有可覆写的
  // 明文 payload；不套用 OpenAI 方言层的字段策略。
  const usesOpenAIPayloadPolicy =
    providerApiKind !== "anthropic-messages" &&
    (options.requestSettings !== undefined || options.enableWebSearch === true);
  const transformProviderPayload = usesOpenAIPayloadPolicy
    ? createProviderPayloadTransformer(
        options.requestSettings,
        options.providerProfileId,
        options.model,
        options.enableWebSearch === true,
        providerApiKind,
      )
    : undefined;
  return {
    modelRegistry,
    selectedModel,
    // 档位只表达「请求哪一档」；映射与 clamp 由 pi 按模型真实 thinkingLevelMap 完成。
    thinkingLevel: thinkingLevelFromSettings(options.requestSettings?.reasoningEffort),
    ...(transformProviderPayload === undefined ? {} : { transformProviderPayload }),
  };
}

const PROVIDER_API_KIND_BY_PROTOCOL: Partial<Record<ModelProtocolKind, ProviderApiKind>> = {
  openai_compatible_chat_completions: "openai-completions",
  openai_responses: "openai-responses",
  anthropic_messages: "anthropic-messages",
};

function resolveProviderApiKind(protocol: ModelProtocolKind): ProviderApiKind {
  const api: ProviderApiKind | undefined = PROVIDER_API_KIND_BY_PROTOCOL[protocol];
  if (api === undefined) {
    throw new Error(`Model provider binding does not support protocol kind ${JSON.stringify(protocol)}.`);
  }
  return api;
}

function providerStreamsForApi(
  api: ProviderApiKind,
  factories: ModelProviderBindingFactories,
): ProviderStreams {
  switch (api) {
    case "openai-completions":
      return (factories.createChatCompletionsTransport ?? openAICompletionsApi)();
    case "openai-responses":
      return (factories.createResponsesTransport ?? openAIResponsesApi)();
    case "anthropic-messages":
      return (factories.createAnthropicMessagesTransport ?? anthropicMessagesApi)();
  }
}

function buildProviderId(profileId: string): string {
  return nativeModelProviderRegistryId(profileId);
}

export type ModelProviderBindingInitializationOptions = {
  readonly signal?: AbortSignal;
  readonly allowNetwork?: boolean;
  readonly forceRefresh?: boolean;
};

/** Dynamic native catalogs and subscription model policy must settle before selection. */
export async function createModelProviderBindingAsync(
  options: ModelProviderBindingOptions,
  initialization: ModelProviderBindingInitializationOptions = {},
): Promise<ModelProviderBinding> {
  initialization.signal?.throwIfAborted();
  if (options.protocol !== "native") return createModelProviderBinding(options);
  const collection = createNativeModelProviderCollection(options);
  const refresh = await collection.modelRegistry.refresh({
    providers: [collection.providerId],
    allowNetwork: initialization.allowNetwork ?? true,
    force: initialization.forceRefresh,
    signal: initialization.signal,
  });
  initialization.signal?.throwIfAborted();
  const refreshError = refresh.errors.get(collection.providerId);
  if (refreshError !== undefined) throw refreshError;
  if (refresh.aborted) throw new Error("Native provider model initialization was cancelled.");
  const auth = await collection.modelRegistry.getAuth(collection.providerId, {
    signal: initialization.signal,
  });
  if (auth === undefined) throw new Error("The native model connection is not configured.");
  const available = await collection.modelRegistry.getAvailable(collection.providerId, {
    signal: initialization.signal,
  });
  initialization.signal?.throwIfAborted();
  if (!available.some((model) => model.id === options.model)) {
    throw new Error(
      `Native model ${options.model} is unavailable for this connection. ` +
      "Check the account and select a model from the native catalog; " +
      "directory-external models require a custom protocol connection.",
    );
  }
  return nativeBinding(options, collection);
}

function nativeBinding(
  options: ModelProviderBindingOptions,
  collection: NativeModelProviderCollection,
): ModelProviderBinding {
  const catalogModel = collection.modelRegistry.getModel(collection.providerId, options.model);
  if (catalogModel === undefined) {
    throw new Error(
      `Pi native provider ${collection.piProviderId} does not declare model ${options.model}. ` +
      "Use a custom protocol connection for directory-external models.",
    );
  }
  const selectedModel = configurePiModel(catalogModel, options.modelConfiguration);
  if (options.enableWebSearch === true && selectedModel.api !== "openai-responses") {
    throw new Error("Built-in web search requires a native OpenAI Responses model.");
  }
  const payloadApiKind = selectedModel.api === "openai-completions"
    ? "openai-completions"
    : selectedModel.api === "openai-responses" ? "openai-responses" : undefined;
  const usesOpenAIPayloadPolicy = payloadApiKind !== undefined &&
    (options.requestSettings !== undefined || options.enableWebSearch === true);
  const transformProviderPayload = usesOpenAIPayloadPolicy
    ? createProviderPayloadTransformer(
        options.requestSettings,
        options.providerProfileId,
        options.model,
        options.enableWebSearch === true,
        payloadApiKind,
      )
    : undefined;
  return {
    modelRegistry: configuredNativeRegistry(collection.modelRegistry, selectedModel),
    catalogRegistry: collection.modelRegistry,
    selectedModel,
    thinkingLevel: thinkingLevelFromSettings(options.requestSettings?.reasoningEffort),
    ...(transformProviderPayload === undefined ? {} : { transformProviderPayload }),
  };
}

/** Preserve catalog capabilities, but never transplant another API's compat. */
function knownProviderModel(
  model: Model<Api>,
  options: ModelProviderBindingOptions,
  providerId: string,
  api: ProviderApiKind,
): Model<Api> {
  const sameTransport = model.api === api;
  return {
    ...model,
    id: options.model,
    api,
    provider: providerId,
    baseUrl: options.baseUrl,
    // Transport-specific compat values cannot cross API families.
    compat: sameTransport ? model.compat : undefined,
    thinkingLevelMap: sameTransport ? model.thinkingLevelMap : standardThinkingLevelMap(model),
    headers: undefined,
  };
}

function standardThinkingLevelMap(model: Model<Api>): Model<Api>["thinkingLevelMap"] {
  if (model.thinkingLevelMap === undefined) return undefined;
  return Object.fromEntries(Object.entries(model.thinkingLevelMap).map(([level, value]) =>
    [level, value === null ? null : level === "off" ? undefined : level],
  ));
}

/** Harness resolves IDs through the registry; patch only this run's lookup. */
function configuredNativeRegistry(registry: Models, selected: Model<Api>): Models {
  return new Proxy(registry, {
    get(target, property) {
      if (property === "getModel") {
        return (provider: string, id: string) =>
          provider === selected.provider && id === selected.id ? selected : target.getModel(provider, id);
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 未知模型：transport 必需常量 + 保守声明；不伪造任何能力，也不外溢为产品事实。 */
function unknownProviderModel(
  options: ModelProviderBindingOptions,
  providerId: string,
  api: ProviderApiKind,
): Model<Api> {
  return {
    id: options.model,
    name: options.model,
    api,
    provider: providerId,
    baseUrl: options.baseUrl,
    // 未确认模型不声明推理能力：pi 因此不会写任何推理字段。
    reasoning: false,
    // Pi's model.input is the final transport capability gate. An unconfirmed
    // model must never advertise image input.
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
    maxTokens: api === "anthropic-messages"
      ? DEFAULT_ANTHROPIC_REQUEST_OUTPUT_TOKENS
      : UNCONFIRMED_MODEL_MAX_OUTPUT_TOKENS,
  };
}

/** 没有显式 effort 时不请求任何档位；已知模型的档位映射与 clamp 由 pi 完成。 */
function thinkingLevelFromSettings(
  effort: OpenAIModelRequestSettings["reasoningEffort"] | undefined,
): ThinkingLevel {
  if (effort === undefined || effort === "none") return "off";
  return effort;
}

function createProviderPayloadTransformer(
  settings: OpenAIModelRequestSettings | undefined,
  providerProfileId: ProviderProtocolProfileId | undefined,
  modelId: string,
  enableWebSearch: boolean,
  bindingApiKind: Exclude<ProviderApiKind, "anthropic-messages">,
): ModelProviderPayloadTransformer {
  return ({ model, payload, tools }) => {
    const record = asRecord(payload);
    if (record === undefined) return payload;
    switch (model.api) {
      case "openai-completions": {
        const dialect = resolveOpenAICompatibleChatDialect({ providerProfileId });
        const withSettings = withFields(record, {
          temperature: settings?.temperature,
          top_p: settings?.topP,
          parallel_tool_calls: configuredOpenAIParallelToolCalls(tools, settings),
        });
        // Pi's compat writes the reasoning field from the model's real
        // thinkingLevelMap; the app only keeps the provider-specific policy.
        return applyOpenAICompatibleChatRequestPolicy({
          fields: withSettings,
          dialect,
          modelId,
          ...(settings?.reasoningEffort === undefined ? {} : { effort: settings.reasoningEffort }),
        });
      }
      case "openai-responses": {
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
      default:
        throw new Error(
          `Model provider payload transformer cannot serve Pi api ${JSON.stringify(model.api)} for model ${modelId}; ` +
          `the frozen provider binding expects ${bindingApiKind}. An unknown reported api means the protocol is unsupported, ` +
          `a known api different from the binding means the provider configuration is mismatched.`,
        );
    }
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
