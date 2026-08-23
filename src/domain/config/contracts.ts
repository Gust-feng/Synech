import type {
  ToolCategory,
  ToolConfirmationPolicy,
  ToolFileDisplayOperation,
  ToolInputSchema,
  ToolOperationType,
  ToolRiskLevel,
  ToolRuntimeHint,
} from "../tools/contracts.js";
import type { ToolJsonSchema } from "../tools/schema.js";

export type SubAgentSourceKind = "builtin" | "project" | "user" | "plugin" | "custom";

export type ConfiguredModelRuntimeMode = "none" | "openai-compatible" | "openai-responses";

export type ConfiguredWebSearchProvider =
  | "tavily"
  | "exa"
  | "zai"
  | "metaso"
  | "google"
  | "bing"
  | "model_builtin"
  | "none";

export type ConfiguredWebSearchProviderKind = Exclude<ConfiguredWebSearchProvider, "none" | "model_builtin">;

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

export type ToolStateSettings = {
  readonly name: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
};

export type ConfiguredCommandShellKind = "cmd" | "powershell" | "pwsh" | "bash" | "sh" | "auto";

export type CommandShellSettings = {
  readonly kind: ConfiguredCommandShellKind;
  readonly executable?: string;
  readonly updatedAt: string;
};

export type ToolConfirmationSettings = {
  readonly policy: ToolConfirmationPolicy;
  readonly updatedAt: string;
};

// 桌面根 Agent 内置提示词偏好：决定 built_in 状态下使用哪个内置提示词版本。
// "en" 使用当前英文内置提示词（跟随英文默认提示词线，新英文版本自动生效）；
// 具体变体（如 "zh-v1"）固定使用对应冻结内置提示词。自定义提示词
// （systemPromptMode="custom"）生效时，该偏好只作为恢复默认后的潜在选择，
// 不改变实际提示词。
export type OrdinaryAgentPromptVariant = "en" | "zh-v1";

export type OrdinaryAgentPromptVariantInfo = {
  readonly id: OrdinaryAgentPromptVariant;
  readonly label: string;
  readonly description: string;
};

export type OrdinaryAgentPromptSettings =
  | {
      readonly systemPromptMode: "built_in";
      readonly systemPromptVariant: OrdinaryAgentPromptVariant;
      readonly updatedAt: string;
    }
  | {
      readonly systemPromptMode: "custom";
      readonly systemPrompt: string;
      readonly systemPromptVariant: OrdinaryAgentPromptVariant;
      readonly updatedAt: string;
    };

export type SkillTriggerMode = "keyword" | "model";

export type SkillTriggerSettings = {
  readonly mode: SkillTriggerMode;
  readonly updatedAt: string;
};

export type McpServerTransportKind = "stdio" | "http";

export type McpConfirmationMode = "always" | "unsafe_only" | "never";

export type McpToolExposureMode = "none" | "all" | "selected";

export type McpCachedToolInfo = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: ToolInputSchema;
  readonly outputSchema?: ToolJsonSchema;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly openWorldHint?: boolean;
  };
};

export type McpCachedReferenceInfo = {
  readonly prompts: readonly {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly arguments?: readonly {
      readonly name: string;
      readonly description?: string;
      readonly required?: boolean;
    }[];
  }[];
  readonly resources: readonly {
    readonly uri: string;
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly mimeType?: string;
    readonly size?: number;
  }[];
  readonly resourceTemplates: readonly {
    readonly uriTemplate: string;
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly mimeType?: string;
  }[];
};

export type McpServerSettings = {
  readonly serverId: string;
  readonly label: string;
  readonly description?: string;
  readonly transport: McpServerTransportKind;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly envSecretRefs: readonly string[];
  readonly headerSecretRefs?: readonly string[];
  readonly bearerTokenSecretRef?: string;
  readonly apiKeySecretRef?: string;
  readonly apiKeyHeaderName?: string;
  readonly confirmationMode: McpConfirmationMode;
  readonly toolExposureMode: McpToolExposureMode;
  readonly enabledTools: readonly string[];
  readonly autoApprovedTools: readonly string[];
  readonly enabled: boolean;
  readonly lastConnectedAt?: string;
  readonly lastError?: string;
  readonly cachedTools?: readonly McpCachedToolInfo[];
  readonly toolsCachedAt?: string;
  readonly cachedReferences?: McpCachedReferenceInfo;
  readonly referencesCachedAt?: string;
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

export type LocalSettings = {
  readonly version: 1;
  readonly activeModelProfileId: string;
  readonly modelProfiles: readonly ModelProviderProfileSettings[];
  readonly modelProviderOrder?: readonly string[];
  readonly modelCatalogs?: readonly ModelProviderModelCatalog[];
  readonly modelCapabilityOverrides?: readonly ModelCapabilityOverrideSettings[];
  readonly toolStates?: readonly ToolStateSettings[];
  readonly toolConfirmation?: ToolConfirmationSettings;
  readonly ordinaryAgent?: OrdinaryAgentPromptSettings;
  readonly skillTrigger?: SkillTriggerSettings;
  readonly commandShell?: CommandShellSettings;
  readonly mcpServers?: readonly McpServerSettings[];
  readonly informationAccess?: InformationAccessSettings;
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

export type UpdateToolStateInput = {
  readonly name: string;
  readonly enabled: boolean;
};

export type SanitizedToolConfirmationConfig = {
  readonly policy: ToolConfirmationPolicy;
  readonly label: string;
  readonly shellCommandConfirmation: "prompt" | "skipped_by_full_access";
  readonly shellCommandRequiresConfirmation: boolean;
  readonly summary: string;
  readonly riskDisclosure: string;
  readonly updatedAt: string;
};

export type UpdateToolConfirmationConfigInput = {
  readonly policy: ToolConfirmationPolicy;
};

export type SanitizedOrdinaryAgentPromptConfig = {
  readonly systemPrompt: string;
  // 解析后的内置提示词偏好；custom 状态下保留为潜在偏好。
  readonly systemPromptVariant: OrdinaryAgentPromptVariant;
  // 当前实际生效提示词的稳定身份，供 AgentDefinition 组装与 run ref 使用。
  readonly promptRef: string;
  readonly promptVersion: string;
  readonly updatedAt: string;
  readonly isDefault: boolean;
  readonly maxSystemPromptChars: number;
  readonly variants: readonly OrdinaryAgentPromptVariantInfo[];
};

export type UpdateOrdinaryAgentPromptConfigInput = {
  readonly systemPrompt?: string;
  readonly resetSystemPrompt?: boolean;
  readonly systemPromptVariant?: OrdinaryAgentPromptVariant;
};

export type SanitizedSkillTriggerConfig = {
  readonly mode: SkillTriggerMode;
  readonly label: string;
  readonly modelRouterEnabled: boolean;
  readonly summary: string;
  readonly updatedAt: string;
};

export type UpdateSkillTriggerConfigInput = {
  readonly mode: SkillTriggerMode;
};

export type UpsertMcpServerInput = {
  readonly serverId: string;
  readonly label?: string;
  readonly description?: string;
  readonly transport?: McpServerTransportKind;
  readonly commandLine?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly envSecretRefs?: readonly string[];
  readonly headerSecretRefs?: readonly string[];
  readonly bearerTokenSecretRef?: string;
  readonly apiKeySecretRef?: string;
  readonly apiKeyHeaderName?: string;
  readonly clearMcpAuth?: boolean;
  readonly confirmationMode?: McpConfirmationMode;
  readonly toolExposureMode?: McpToolExposureMode;
  readonly enabledTools?: readonly string[];
  readonly autoApprovedTools?: readonly string[];
  readonly enabled?: boolean;
};

export type McpServerSecretValueInput = {
  readonly serverId: string;
  readonly secretRef: string;
  readonly value: string;
};

export type SanitizedMcpServerSecretMetadata = SecretMetadata & {
  readonly secretRef: string;
};

/** Runtime tool groups are product-neutral capability facts. */
export type CapabilityToolScope = "agent-basic" | "workspace" | "mcp" | "research";

export type CapabilityToolCatalogItem = {
  readonly name: string;
  readonly displayName: string;
  readonly displayDescription: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly outputSchema?: ToolJsonSchema;
  readonly category: ToolCategory;
  readonly categoryLabel: string;
  readonly riskLevel: ToolRiskLevel;
  readonly riskLabel: string;
  readonly operationType: ToolOperationType;
  readonly fileOperation?: ToolFileDisplayOperation;
  readonly operationLabel: string;
  readonly requiresConfirmation: boolean;
  readonly confirmationLabel: string;
  readonly runtimeHints?: readonly ToolRuntimeHint[];
  readonly definitionHash: string;
  readonly scopes: readonly CapabilityToolScope[];
  readonly enabled: boolean;
  readonly availability: "available" | "unavailable";
  readonly disabledReason?: string;
  /** Definition is intentionally catalog-only and cannot be executed by ToolCenter. */
  readonly catalogOnly?: boolean;
};

export type CapabilityToolAvailability = {
  readonly name: string;
  readonly availability: CapabilityToolCatalogItem["availability"];
  readonly disabledReason?: string;
};

export type CapabilitySkillMetadataValue = string | number | boolean | readonly string[];

export type CapabilitySkillCompatibility = Readonly<Record<string, string | readonly string[]>>;

export type CapabilitySkillProvenanceValue = string | number | boolean | null | readonly (string | number | boolean | null)[];

export type CapabilitySkillProvenance = Readonly<Record<string, CapabilitySkillProvenanceValue>>;

export type CapabilitySkillResourceIndexItem = {
  readonly kind: "script" | "reference" | "asset";
  readonly name: string;
  readonly relativePath?: string;
  readonly sourcePath: string;
  readonly contentHash?: string;
  readonly byteLength?: number;
  readonly loadError?: string;
};

export type CapabilitySkillValidationStatus = "valid" | "invalid" | "load_error";

export type CapabilitySkillCatalogItem = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly sourcePath: string;
  readonly triggers: readonly string[];
  readonly lastUsedAt?: string;
  readonly summary?: string;
  readonly category?: string;
  readonly sourceKind?: "project" | "user" | "plugin" | "admin" | "custom";
  readonly sourceRootId?: string;
  readonly sourcePrecedence?: number;
  readonly stateKey?: string;
  readonly version?: string;
  readonly provenance?: CapabilitySkillProvenance;
  readonly whenToUse?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
  readonly license?: string;
  readonly compatibility?: CapabilitySkillCompatibility;
  readonly metadata?: Readonly<Record<string, CapabilitySkillMetadataValue>>;
  readonly allowedTools?: readonly string[];
  readonly resources?: readonly CapabilitySkillResourceIndexItem[];
  readonly contentHash?: string;
  readonly bodyHash?: string;
  readonly loadError?: string;
  readonly validationStatus?: CapabilitySkillValidationStatus;
  readonly validationErrors?: readonly string[];
};

export type CapabilitySubAgentDiagnostic = {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly path?: string;
};

export type CapabilitySubAgentCatalogItem = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category?: string;
  readonly sourceKind: SubAgentSourceKind;
  readonly sourceRootId: string;
  readonly sourcePrecedence: number;
  readonly enabled: boolean;
  readonly version?: string;
  readonly whenToUse?: readonly string[];
  readonly whenNotToUse?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly diagnostics?: readonly CapabilitySubAgentDiagnostic[];
  readonly contentHash?: string;
  readonly bodyHash?: string;
};

export type CapabilityMcpToolCatalogItem = CapabilityToolCatalogItem & {
  /** Exact method name used by the MCP protocol, configuration, and remote executor. */
  readonly protocolName: string;
};

export type CapabilityMcpCatalogItem = {
  readonly serverId: string;
  readonly label: string;
  readonly description?: string;
  readonly transport: McpServerTransportKind;
  readonly enabled: boolean;
  readonly confirmationMode: McpConfirmationMode;
  readonly availability: "configured" | "disabled" | "unavailable";
  readonly runtimeStatus?: "disabled" | "unavailable" | "configured" | "connecting" | "connected" | "error";
  readonly errorSummary?: string;
  readonly commandSummary?: string;
  readonly url?: string;
  readonly envSecretRefCount: number;
  readonly authSecretRefCount: number;
  readonly toolExposureMode: McpToolExposureMode;
  /** Original MCP protocol method names. They are never canonical model-visible identities. */
  readonly enabledTools: readonly string[];
  /** Original MCP protocol method names approved to bypass confirmation. */
  readonly autoApprovedTools: readonly string[];
  readonly lastConnectedAt?: string;
  readonly lastError?: string;
  readonly toolsCachedAt?: string;
  readonly cachedTools?: readonly McpCachedToolInfo[];
  readonly promptCount?: number;
  readonly resourceCount?: number;
  readonly resourceTemplateCount?: number;
  readonly referencesCachedAt?: string;
  readonly runtimeConfig?: {
    readonly transport: McpServerTransportKind;
    readonly command?: string;
    readonly args?: readonly string[];
    readonly url?: string;
    readonly envSecretRefs: readonly string[];
    readonly headerSecretRefs?: readonly string[];
    readonly bearerTokenSecretRef?: string;
    readonly apiKeySecretRef?: string;
    readonly apiKeyHeaderName?: string;
    readonly confirmationMode: McpConfirmationMode;
    readonly toolExposureMode: McpToolExposureMode;
    readonly enabledTools: readonly string[];
    readonly autoApprovedTools: readonly string[];
  };
  /** `name` is canonical/model-visible; `protocolName` is the exact MCP method name. */
  readonly tools: readonly CapabilityMcpToolCatalogItem[];
  readonly exposedTools: readonly CapabilityMcpToolCatalogItem[];
  readonly updatedAt: string;
};

/** Run-born model, tool, MCP, execution-root, and confirmation facts shared by Agent features. */
export type AgentCapabilitySnapshot = {
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly activeModel: SanitizedModelProviderConfig;
  readonly modelCapabilities: ModelCapabilities;
  readonly toolCatalog: {
    readonly scope: "agent-basic";
    readonly tools: readonly CapabilityToolCatalogItem[];
    readonly allowedTools: readonly string[];
  };
  readonly mcpCatalog: readonly CapabilityMcpCatalogItem[];
  readonly executionRoot: string;
  readonly commandShell?: SanitizedCommandShellConfig;
  readonly toolConfirmation?: SanitizedToolConfirmationConfig;
  readonly securitySummary: string;
  readonly warnings: readonly string[];
};

/** Ordinary-owned extension for Skills and Sub-Agent AgentTool contributions. */
export type OrdinaryCapabilitySnapshot = AgentCapabilitySnapshot & {
  readonly skillCatalog: readonly CapabilitySkillCatalogItem[];
  readonly subAgentCatalog: readonly CapabilitySubAgentCatalogItem[];
  readonly skillTrigger?: SanitizedSkillTriggerConfig;
};

export type RunToolExposureReasonCode =
  | "model_tools_unsupported"
  | "tool_disabled"
  | "tool_unavailable"
  | "not_in_run_scope"
  | "permission_denied"
  | "profile_hidden"
  | "available_full_access"
  | "available_requires_confirmation"
  | "available"
  | "no_executable_tool_runner"
  | "executable_tool_missing"
  | "tool_contract_mismatch"
  | "selected_skill_resources_available"
  | "selected_skill_resources_unavailable"
  | "no_enabled_sub_agents";

export type RunToolExposure = {
  readonly name: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly modelVisible: boolean;
  readonly scopes: readonly CapabilityToolScope[];
  readonly availability: CapabilityToolCatalogItem["availability"];
  readonly riskLevel: ToolRiskLevel;
  readonly operationType: ToolOperationType;
  readonly fileOperation?: ToolFileDisplayOperation;
  readonly requiresConfirmation: boolean;
  readonly confirmationPolicy?: ToolConfirmationPolicy;
  readonly reasonCode?: RunToolExposureReasonCode;
  readonly reason: string;
};

export type CapabilityDraft = {
  readonly draftId: string;
  readonly source: "mcp";
  readonly label: string;
  readonly availability: CapabilityMcpCatalogItem["availability"];
  readonly enabled: boolean;
  readonly reason: string;
};

export type RunEnabledSkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  readonly summary?: string;
  readonly category?: string;
  readonly sourceKind?: "project" | "user" | "plugin" | "admin" | "custom";
  readonly sourceRootId?: string;
  readonly sourcePrecedence?: number;
  readonly stateKey?: string;
  readonly version?: string;
  readonly provenance?: CapabilitySkillProvenance;
  readonly whenToUse?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
  readonly metadata?: Readonly<Record<string, CapabilitySkillMetadataValue>>;
  readonly allowedTools?: readonly string[];
  readonly contentHash?: string;
  readonly bodyHash?: string;
};

export type RunCapabilityResolution = {
  readonly resolutionId: string;
  readonly snapshotId: string;
  readonly runMode: "agent";
  readonly agentId: string;
  readonly agentDisplayName: string;
  readonly toolVisibilityProfileId: string;
  readonly capabilityPlan: RunCapabilityPlan;
  readonly allowedTools: readonly string[];
  readonly toolExposures: readonly RunToolExposure[];
  readonly enabledSkills: readonly RunEnabledSkill[];
  readonly mcpDrafts: readonly CapabilityDraft[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
};

/**
 * Ordinary feature view of a run capability resolution. The persisted bridge
 * keeps `RunCapabilityResolution` for archived/deferred records; current
 * Ordinary code should prefer this narrowed form when it does not need to
 * reason about deferred modes.
 */
export type OrdinaryRunCapabilityResolution = Omit<RunCapabilityResolution, "runMode"> & {
  readonly runMode: "agent";
};

export type RunCapabilityPlanToolPolicy = {
  readonly canExposeToModel: boolean;
  readonly allowedTools: readonly string[];
};

export type RunCapabilityPlanFilePolicy = {
  readonly canReadWorkspace: boolean;
  readonly canWriteWorkspace: boolean;
  readonly canDeleteWorkspace: boolean;
  readonly canExecuteCommands: boolean;
};

export type RunCapabilityPlanUiPolicy = {
  readonly canShowStreamingOutput: boolean;
  readonly canShowToolCards: boolean;
  readonly visibleToolNames: readonly string[];
};

export type RunCapabilityPlan = {
  readonly protocolToolCallCapabilities: ProtocolToolCallCapabilities;
  readonly modelCapabilities: ModelCapabilities;
  readonly canExposeModelTools: boolean;
  readonly tools?: RunCapabilityPlanToolPolicy;
  readonly fileOperations?: RunCapabilityPlanFilePolicy;
  readonly uiDisplay?: RunCapabilityPlanUiPolicy;
  readonly allowedTools: readonly string[];
  readonly warnings: readonly string[];
};

export type RunAgentDefinitionRef = {
  readonly agentId: string;
  readonly agentDisplayName: string;
  readonly promptRef: string;
  readonly promptVersion: string;
  readonly outputContractId: string;
  readonly toolVisibilityProfileId: string;
  readonly definitionHash?: string;
};

export type InformationAccessSettings = {
  readonly webSearch: {
    readonly provider: ConfiguredWebSearchProvider;
    readonly updatedAt: string;
  };
  readonly tavily: WebSearchProviderSettings & { readonly providerKind: "tavily" };
  readonly exa: WebSearchProviderSettings & { readonly providerKind: "exa" };
  readonly zai: WebSearchProviderSettings & { readonly providerKind: "zai" };
  readonly metaso: WebSearchProviderSettings & { readonly providerKind: "metaso" };
  readonly google: WebSearchProviderSettings & { readonly providerKind: "google" };
  readonly bing: WebSearchProviderSettings & { readonly providerKind: "bing" };
};

export type WebSearchProviderSettings = {
  readonly providerKind: ConfiguredWebSearchProviderKind;
  readonly maxResults: number;
  readonly secretRef: string;
  readonly endpoint?: string;
  readonly searchDepth?: string;
  readonly searchType?: string;
  readonly searchEngine?: string;
  readonly engineId?: string;
  readonly market?: string;
  readonly updatedAt: string;
};

export type SanitizedInformationAccessConfig = {
  readonly web: {
    readonly provider: ConfiguredWebSearchProvider;
    readonly providerKind?: ConfiguredWebSearchProviderKind;
    readonly maxResults: number;
    readonly secretRef?: string;
    readonly secretConfigured: boolean;
    readonly secretUpdatedAt?: string;
    readonly endpoint?: string;
    readonly searchDepth?: string;
    readonly searchType?: string;
    readonly searchEngine?: string;
    readonly engineId?: string;
    readonly market?: string;
    readonly status: "ready" | "no-provider" | "disabled";
    readonly updatedAt: string;
  };
};

export type SanitizedWebSearchConfig = {
  readonly provider: ConfiguredWebSearchProvider;
  readonly providerKind?: ConfiguredWebSearchProviderKind;
  readonly maxResults: number;
  readonly secretRef?: string;
  readonly secretConfigured: boolean;
  readonly secretUpdatedAt?: string;
  readonly endpoint?: string;
  readonly searchDepth?: string;
  readonly searchType?: string;
  readonly searchEngine?: string;
  readonly engineId?: string;
  readonly market?: string;
  readonly status: "ready" | "no-provider" | "disabled";
  readonly updatedAt: string;
};

export type UpdateInformationAccessConfigInput = {
  readonly provider?: ConfiguredWebSearchProvider;
  readonly apiKey?: string;
  readonly maxResults?: number;
  readonly engineId?: string;
};

export type UpdateWebSearchConfigInput = {
  readonly provider?: ConfiguredWebSearchProvider;
  readonly apiKey?: string;
  readonly maxResults?: number;
  readonly engineId?: string;
};

export type CommandShellAvailability = "available" | "missing";

export type SanitizedCommandShellOption = {
  readonly kind: Exclude<ConfiguredCommandShellKind, "auto">;
  readonly label: string;
  readonly executable?: string;
  readonly syntax: "cmd" | "powershell" | "posix";
  readonly availability: CommandShellAvailability;
  readonly reason?: string;
};

export type SanitizedRuntimeEnvironmentTool = {
  readonly id: "node" | "python" | "git-bash";
  readonly label: string;
  readonly description: string;
  readonly executable?: string;
  readonly availability: CommandShellAvailability;
  readonly reason?: string;
};

export type SanitizedCommandShellConfig = {
  readonly configuredKind: ConfiguredCommandShellKind;
  readonly autoDetected: boolean;
  readonly kind: Exclude<ConfiguredCommandShellKind, "auto">;
  readonly label: string;
  readonly executable: string;
  readonly syntax: "cmd" | "powershell" | "posix";
  readonly platform: NodeJS.Platform;
  readonly invocation: readonly string[];
  readonly commandLineParameter: "commandLine";
  readonly notes: readonly string[];
  readonly availableShells: readonly SanitizedCommandShellOption[];
  readonly runtimeTools: readonly SanitizedRuntimeEnvironmentTool[];
  readonly updatedAt: string;
};

export type UpdateCommandShellConfigInput = {
  readonly kind: ConfiguredCommandShellKind;
  readonly executable?: string;
};

export type SettingsStore = {
  readSettings(): Promise<unknown | undefined>;
  writeSettings(settings: LocalSettings): Promise<void>;
};

export type SecretMetadata = {
  readonly configured: boolean;
  readonly updatedAt?: string;
};

export type LocalDevSecretStore = {
  getMetadata(secretRef: string): Promise<SecretMetadata>;
  readSecret(secretRef: string): Promise<string | undefined>;
  writeSecret(secretRef: string, value: string): Promise<SecretMetadata>;
  deleteSecret(secretRef: string): Promise<SecretMetadata>;
};
