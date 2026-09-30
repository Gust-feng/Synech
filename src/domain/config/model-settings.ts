import type { ModelThinkingLevelName, ResolvedModelCapabilities } from "./model-facts.js";

export type ConfiguredModelRuntimeMode =
  | "none"
  | "anthropic-messages"
  | "openai-compatible"
  | "openai-responses";

export type ConfiguredModelProviderKind = "openai_compatible";

export type ConfiguredModelProtocolKind =
  | "anthropic_messages"
  | "openai_responses"
  | "openai_compatible_chat_completions";

export type ProviderProtocolProfileId =
  | "openai"
  | "deepseek"
  | "moonshot"
  | "glm"
  | "minimax"
  | "openai_compatible";

export type ModelPreferredApiStyle =
  | "chat_completions"
  | "responses"
  | "openai_compatible";

/** 协议层工具调用能力事实（与具体模型无关，由 protocolKind 决定）。 */
export type ProtocolToolCallCapabilities = {
  readonly protocolKind: ConfiguredModelProtocolKind;
  readonly canSendToolDefinitions: boolean;
  readonly canReceiveToolCalls: boolean;
  readonly canRoundTripToolResults: boolean;
};

export type ProviderProtocolProfile = {
  readonly profileId: ProviderProtocolProfileId;
  readonly label: string;
  readonly providerKind: ConfiguredModelProviderKind;
  readonly recommendedProtocolKind: ConfiguredModelProtocolKind;
  readonly supportedProtocolKinds: readonly ConfiguredModelProtocolKind[];
  readonly defaultBaseUrl: string;
  readonly modelsPath: string;
  readonly unsupportedParams: readonly string[];
  readonly ignoredParams: readonly string[];
  readonly dangerousParams: readonly string[];
};

export type ModelStability = "stable" | "preview" | "deprecated" | "unknown";

export type OpenAIReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * 运行级推理档位。
 *
 * 直接派生自 Pi 的档位名，排除 "off"（那是"不请求档位"，用 absence 表达）。
 * 产品**不维护自己的档位集合**：模型实际支持哪几档完全由该模型真实的
 * `thinkingLevelMap` 决定，档位多于此集合的上游 api 由 Pi 自己扩展。
 */
export type ModelRunReasoningEffort = Exclude<ModelThinkingLevelName, "off">;

/** 档位到展示名的映射；新档位必须在这里补一个名字，否则无法在 UI 呈现。 */
export const MODEL_RUN_REASONING_EFFORT_LABELS: Readonly<Record<ModelRunReasoningEffort, string>> = {
  minimal: "极简",
  low: "轻量",
  medium: "标准",
  high: "深入",
  xhigh: "极深",
  max: "最高",
};

export type OpenAIReasoningSummary = "auto" | "concise" | "detailed";

export type OpenAITextVerbosity = "low" | "medium" | "high";

export type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";

export type OpenAITruncationMode = "auto" | "disabled";

export type OpenAIModelRequestSettings = {
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEffort?: OpenAIReasoningEffort;
  readonly reasoningSummary?: OpenAIReasoningSummary;
  readonly textVerbosity?: OpenAITextVerbosity;
  readonly serviceTier?: OpenAIServiceTier;
  readonly truncation?: OpenAITruncationMode;
  readonly parallelToolCalls?: boolean;
  readonly store?: boolean;
};
export type ModelProviderPreset = {
  readonly presetId: string;
  readonly label: string;
  readonly vendor: string;
  readonly description: string;
  readonly providerKind: ConfiguredModelProviderKind;
  readonly protocolKind: ConfiguredModelProtocolKind;
  readonly baseUrl: string;
  readonly modelsPath: string;
  readonly protocolProfileId?: ProviderProtocolProfileId;
  readonly supportedProtocolKinds?: readonly ConfiguredModelProtocolKind[];
  readonly regionLabel?: string;
  readonly docsUrl?: string;
  /**
   * 该预置端点对应的 pi-ai 真实 provider id（如 `openai` / `moonshotai-cn`）。
   * 已知模型的运行事实按此显式声明在 pi 真实目录中精确匹配；未声明（如通用
   * OpenAI 兼容端点）时，该连接的全部模型都按「远程发现、Pi 未识别」处理。
   */
  readonly piProviderId?: string;
  /** Other Pi provider IDs accepted by this preset's Pi-native connection. */
  readonly piProviderIds?: readonly string[];
};

export type ModelProviderModelCatalogItem = {
  readonly id: string;
  readonly displayName: string;
  readonly owner?: string;
  readonly createdAt?: string;
};

export type ModelProviderModelCatalog = {
  readonly profileId: string;
  readonly label?: string;
  readonly baseUrl: string;
  readonly modelsPath: string;
  readonly fetchedAt: string;
  readonly models: readonly ModelProviderModelCatalogItem[];
};

export type ModelCapabilityProfile = {
  readonly profileId: string;
  readonly providerKind: ConfiguredModelProviderKind;
  readonly protocolKind: ConfiguredModelProtocolKind;
  readonly model: string;
  readonly capabilities: ResolvedModelCapabilities;
};

export type ModelProviderProfileSettings = {
  readonly profileId: string;
  readonly label: string;
  readonly logoDataUrl?: string;
  readonly providerKind: ConfiguredModelProviderKind;
  readonly protocolKind: ConfiguredModelProtocolKind;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly openAI?: OpenAIModelRequestSettings;
  /**
   * 连接显式声明的 pi-ai provider id。非空时，已知模型按此 provider 在 pi 真实
   * 目录中精确匹配 modelId；为空时该连接的全部模型按未知发现模型处理。
   */
  readonly piProviderId?: string;
  readonly defaultAiMode: ConfiguredModelRuntimeMode;
  readonly secretRef: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
};

export type SanitizedModelProviderConfig = {
  readonly profileId: string;
  readonly label?: string;
  readonly logoDataUrl?: string;
  readonly providerKind: ModelProviderProfileSettings["providerKind"];
  readonly protocolKind: ModelProviderProfileSettings["protocolKind"];
  readonly baseUrl: string;
  readonly model?: string;
  readonly openAI?: OpenAIModelRequestSettings;
  readonly piProviderId?: string;
  readonly defaultAiMode: ConfiguredModelRuntimeMode;
  readonly secretRef: string;
  readonly enabled?: boolean;
  readonly secretConfigured: boolean;
  readonly secretUpdatedAt?: string;
  readonly updatedAt: string;
};

export type UpdateModelProviderConfigInput = {
  readonly profileId?: string;
  readonly label?: string;
  readonly logoDataUrl?: string;
  readonly clearLogoDataUrl?: boolean;
  readonly providerKind?: ConfiguredModelProviderKind;
  readonly protocolKind?: ConfiguredModelProtocolKind;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly openAI?: OpenAIModelRequestSettings;
  readonly piProviderId?: string;
  readonly clearPiProviderId?: boolean;
  readonly clearModel?: boolean;
  readonly defaultAiMode?: ConfiguredModelRuntimeMode;
  readonly enabled?: boolean;
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
};

export type CreateModelProviderProfileInput = UpdateModelProviderConfigInput & {
  readonly profileId: string;
  readonly label?: string;
};
