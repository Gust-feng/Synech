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
  ProviderProtocolProfileId,
} from "../../domain/config/index.js";
import type { ModelProtocolKind } from "../../domain/intelligence/index.js";
import { resolveDiscoveredModel } from "./pi-model-facts.js";
import { configuredOpenAIParallelToolCalls } from "./openai-request-settings.js";
import {
  applyOpenAICompatibleChatRequestPolicy,
  resolveOpenAICompatibleChatDialect,
} from "./openai-compatible-chat-protocol.js";
import type { ToolDefinition } from "../../domain/tools/index.js";

/**
 * 未知发现模型的 transport 必需常量。
 *
 * pi 的 Model 类型要求 contextWindow / maxTokens / cost / input 等字段非空，
 * 但这些值**不是产品事实**：未知模型不得伪造上下文窗口、输出上限或能力。常量
 * 只存在于 adapter 内部，绝不得外溢到产品层 DTO / UI；产品层的「未确认」投影
 * 不携带任何数字。
 */
/**
 * 未确认模型的 transport 必需数值。
 *
 * pi 的 `Model` 类型要求这些字段是数字，但「Pi 未识别」意味着 Synech 没有任何
 * 事实可填。这里的取值准则只有一条：**不得让 Synech 的猜测变成对模型的限制**。
 * 因此 contextWindow 取一个明确的「无窗口事实」哨兵，只参与上游溢出判定，
 * 不构成任何承诺；maxTokens 取 0，让 pi 走各自的缺省路径，而不是把 Synech 的
 * 猜测当作输出上限发给上游。产品层看不到这两个常量（未确认投影只带 modelId）。
 */
const UNCONFIRMED_MODEL_CONTEXT_WINDOW = Number.MAX_SAFE_INTEGER;
const UNCONFIRMED_MODEL_MAX_OUTPUT_TOKENS = 0;
const PROVIDER_ID_PREFIX = "synech";
type ProviderApiKind = "anthropic-messages" | "openai-completions" | "openai-responses";

export type ModelProviderBindingOptions = {
  /** 连接级默认 transport；只有未知发现模型使用它。 */
  readonly protocol: ModelProtocolKind;
  readonly baseUrl: string;
  readonly model: string;
  /** Stable profile identity used for the Pi provider registry key. */
  readonly profileId: string;
  readonly apiKey?: string;
  readonly resolveApiKey?: () => string | undefined | Promise<string | undefined>;
  /**
   * 连接显式声明的 pi-ai provider id。非空时已知模型按此 provider 在 pi 真实
   * 目录中精确匹配；为空时该模型的全部运行事实按「Pi 未识别」处理。
   */
  readonly piProviderId?: string;
  /** 连接级 vendor 家族（连接显式事实，用于 pi 无 compat 的请求字段策略）。 */
  readonly providerProfileId?: ProviderProtocolProfileId;
  readonly requestSettings?: OpenAIModelRequestSettings;
  /** Enables the Responses provider's hosted web-search tool for this frozen run. */
  readonly enableWebSearch?: boolean;
};

export type ModelProviderBinding = {
  readonly modelRegistry: Models;
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
 * 二态解析：模型 ID 在连接显式声明的 `piProviderId` 作用域内被 pi 真实 catalog
 * 精确命中时，直接使用真实 Pi Model 的 api / compat / input / contextWindow /
 * maxTokens / thinkingLevelMap / reasoning / cost，只用连接事实覆盖 baseUrl /
 * auth / provider 注册键；未命中时不伪造任何能力，只用连接级默认 transport 把
 * 模型 ID 原样注册，请求是否成功由真实上游决定。
 *
 * API key resolution stays at the provider boundary and runs for every model request.
 */
export function createModelProviderBinding(
  options: ModelProviderBindingOptions,
  factories: ModelProviderBindingFactories = {},
): ModelProviderBinding {
  if (options.enableWebSearch === true && options.protocol === "anthropic_messages") {
    // 产品内建 Web Search 只在 Responses transport 上有对应物；不静默丢弃开关。
    throw new Error("Built-in web search is not supported by the Anthropic Messages protocol binding.");
  }
  const discovered = resolveDiscoveredModel({
    piProviderId: options.piProviderId,
    modelId: options.model,
  });
  const providerApiKind = discovered.status === "known"
    ? supportedPiApiKind(discovered.model.api, options.model)
    : resolveProviderApiKind(options.protocol);
  if (discovered.status === "unknown" && providerApiKind === "anthropic-messages") {
    throw new Error(
      `Model ${options.model} is not present in the declared Pi provider catalog, so the Anthropic ` +
      "Messages transport has no factual max_tokens to send. Configure a known Pi model or choose a " +
      "non-Anthropic transport for this unconfirmed model.",
    );
  }
  const providerId = buildProviderId(options.profileId);
  const configuredModel = discovered.status === "known"
    ? knownProviderModel(discovered.model, options, providerId)
    : unknownProviderModel(options, providerId, providerApiKind);
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

/**
 * 已知模型的 transport 由真实 Pi Model.api 决定；产品为每个已接入 api 提供对应
 * transport。仍未接入的 api 在构造期显式失败，不静默降级、也不回退连接协议。
 */
function supportedPiApiKind(api: Api, modelId: string): ProviderApiKind {
  switch (api) {
    case "openai-completions":
      return "openai-completions";
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic-messages";
    default:
      throw new Error(
        `Pi model ${modelId} declares api ${JSON.stringify(api)}, which this product cannot serve; ` +
        "the connection transport is not silently substituted for the model's real api.",
      );
  }
}

const PROVIDER_API_KIND_BY_PROTOCOL: Record<ModelProtocolKind, ProviderApiKind> = {
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
  const suffix = profileId.trim();
  if (suffix.length === 0) {
    throw new Error("Model provider profileId must not be blank.");
  }
  return `${PROVIDER_ID_PREFIX}-${suffix}`;
}

/** 已知模型：真实 Pi Model 原样保留，只覆盖 provider 注册键与连接 baseUrl。 */
function knownProviderModel(
  model: Model<Api>,
  options: ModelProviderBindingOptions,
  providerId: string,
): Model<Api> {
  return {
    ...model,
    provider: providerId,
    baseUrl: options.baseUrl,
  };
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
    contextWindow: UNCONFIRMED_MODEL_CONTEXT_WINDOW,
    maxTokens: UNCONFIRMED_MODEL_MAX_OUTPUT_TOKENS,
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
