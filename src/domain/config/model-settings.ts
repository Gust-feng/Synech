import type { ModelThinkingLevelName, ResolvedModelCapabilities } from "./model-facts.js";
import type { ModelConfiguration } from "./model-configuration.js";

export type ConfiguredModelRuntimeMode =
  | "none"
  | "anthropic-messages"
  | "openai-compatible"
  | "openai-responses"
  | "native";

export type ConfiguredModelProviderKind = "openai_compatible";

export type ConfiguredModelProtocolKind =
  | "anthropic_messages"
  | "openai_responses"
  | "openai_compatible_chat_completions"
  | "native";

export type ModelProviderAuthMode = "api_key" | "oauth" | "ambient";

/** Connection parameters are public configuration, never credentials. */
export type ModelProviderConnectionSettings = {
  readonly authMode: ModelProviderAuthMode;
  readonly cloudProject?: string;
  readonly cloudLocation?: string;
  readonly credentialsPath?: string;
  readonly awsRegion?: string;
  readonly awsProfile?: string;
  readonly azureResource?: string;
  readonly azureApiVersion?: string;
  readonly azureDeployment?: string;
  readonly cloudflareAccountId?: string;
  readonly cloudflareGatewayId?: string;
};

/** Credential shapes are interpreted only by the runtime adapter. */
export type ModelProviderCredentialStorePort = {
  read(options?: { readonly signal?: AbortSignal }): Promise<unknown | undefined>;
  modify(
    update: (current: unknown | undefined) => Promise<unknown | undefined>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown | undefined>;
  delete(options?: { readonly signal?: AbortSignal }): Promise<void>;
};

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
 * 产品提供五档，沿用 Pi 编码；off 用 absence 表达，minimal 不进入产品选项。
 * 默认来自真实 `thinkingLevelMap`，每模型用户设置可以调整支持集合。
 * Adapter 仍使用 Pi 既有的档位名与编码。
 */
export type ModelRunReasoningEffort = Exclude<ModelThinkingLevelName, "off" | "minimal">;

/** 档位到展示名的映射；新档位必须在这里补一个名字，否则无法在 UI 呈现。 */
export const MODEL_RUN_REASONING_EFFORT_LABELS: Readonly<Record<ModelRunReasoningEffort, string>> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
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
  readonly brandId?: string;
  readonly brandLabel?: string;
  readonly serviceLabel?: string;
  readonly connection?: ModelProviderConnectionSettings;
  readonly supportedAuthModes?: readonly ModelProviderAuthMode[];
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
   * 原生/显式目录作用域；自定义连接未声明时按模型独立自动关联。
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
  readonly modelSettings?: Readonly<Record<string, ModelConfiguration>>;
  /**
   * 连接服务身份/显式目录作用域，不是混合网关内所有模型的厂商身份。
   */
  readonly piProviderId?: string;
  readonly connection?: ModelProviderConnectionSettings;
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
  readonly modelSettings?: Readonly<Record<string, ModelConfiguration>>;
  readonly piProviderId?: string;
  readonly connection?: ModelProviderConnectionSettings;
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
  readonly connection?: ModelProviderConnectionSettings;
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
