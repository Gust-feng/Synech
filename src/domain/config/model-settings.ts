export type ConfiguredModelRuntimeMode = "none" | "openai-compatible" | "openai-responses";

export type ConfiguredModelProviderKind = "openai_compatible";

export type ConfiguredModelProtocolKind =
  | "openai_responses"
  | "openai_compatible_chat_completions";

export type ProviderProtocolProfileId =
  | "openai"
  | "deepseek"
  | "moonshot"
  | "glm"
  | "minimax"
  | "openai_compatible";

export type ModelReasoningControlKind =
  | "none"
  | "openai_responses_reasoning_effort"
  | "openai_chat_reasoning_effort"
  | "deepseek_reasoning_effort"
  | "kimi_k3_reasoning_effort"
  | "thinking_enabled_disabled"
  | "thinking_disabled"
  | "reasoning_split";

export type ModelPreferredApiStyle =
  | "chat_completions"
  | "responses"
  | "openai_compatible";

export type ModelStability = "stable" | "preview" | "deprecated" | "unknown";

export type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModelRunReasoningEffort = "low" | "medium" | "high";

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
  readonly stream?: boolean;
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
  readonly defaultModel?: string;
  readonly regionLabel?: string;
  readonly docsUrl?: string;
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

export type ModelCapabilities = {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsToolCalling: boolean;
  readonly supportsParallelToolCalls: boolean;
  readonly supportsStructuredOutputs: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsVisionInput: boolean;
  /** Provenance-rich image capability fact; Pi model.input remains final transport authority. */
  readonly imageInput?: {
    readonly status: "supported" | "unsupported" | "unknown";
    readonly source: "registry" | "override" | "protocol_default";
    readonly verifiedAt?: string;
  };
  readonly supportsReasoningEffort: boolean;
  readonly supportsReasoningOutput?: boolean;
  readonly preferredApiStyle: ModelPreferredApiStyle;
  readonly stability: ModelStability;
  readonly protocolProfileId?: ProviderProtocolProfileId;
  readonly reasoningControl?: ModelReasoningControlKind;
  readonly lastVerifiedAt?: string;
};

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
  readonly reasoningControl: ModelReasoningControlKind;
  readonly unsupportedParams: readonly string[];
  readonly ignoredParams: readonly string[];
  readonly dangerousParams: readonly string[];
};

export type ModelCapabilityProfile = {
  readonly providerProfileId: ProviderProtocolProfileId;
  readonly providerKind: ConfiguredModelProviderKind;
  readonly protocolKind: ConfiguredModelProtocolKind;
  readonly modelPattern: string;
  readonly label: string;
  readonly capabilities: ModelCapabilities;
  readonly reasoningControl: ModelReasoningControlKind;
  readonly unsupportedParams: readonly string[];
  readonly ignoredParams: readonly string[];
  readonly dangerousParams: readonly string[];
};

export type ModelCapabilityOverrideSettings = {
  readonly profileId?: string;
  readonly providerKind?: ConfiguredModelProviderKind;
  readonly model: string;
  readonly capabilities: Partial<ModelCapabilities>;
  readonly updatedAt: string;
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
