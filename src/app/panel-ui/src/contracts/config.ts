export type ConfigResponse = {
  readonly product?: ProductInfo;
  readonly appearance?: AppearanceConfig;
  readonly config?: {
    readonly profileId?: string;
    readonly label?: string;
    readonly logoDataUrl?: string;
    readonly providerKind?: "openai_compatible";
    readonly protocolKind?: "openai_responses" | "openai_compatible_chat_completions";
    readonly baseUrl?: string;
    readonly model?: string;
    readonly defaultAiMode?: "none" | "openai-compatible" | "openai-responses";
    readonly enabled?: boolean;
    readonly secretConfigured?: boolean;
  };
  readonly profile?: ModelProviderProfile;
  readonly profiles?: readonly ModelProviderProfile[];
  readonly modelProviderOrder?: readonly string[];
  readonly modelCatalogs?: readonly ModelProviderModelCatalog[];
  readonly modelCapabilityProfiles?: readonly ModelCapabilityProfile[];
  readonly modelProviderMarket?: {
    readonly presets?: readonly ModelProviderPreset[];
  };
  readonly commandShell?: CommandShellConfig;
  readonly toolConfirmation?: ToolConfirmationConfig;
  readonly ordinaryAgent?: OrdinaryAgentPromptConfig;
  readonly skillTrigger?: SkillTriggerConfig;
  readonly capabilities?: {
    readonly activeModel?: ModelProviderProfile;
    readonly toolConfirmation?: ToolConfirmationConfig;
    readonly skillTrigger?: SkillTriggerConfig;
    readonly modelCapabilities?: ModelCapabilities;
    readonly warnings?: readonly string[];
  };
};

export type ModelProviderProfile = NonNullable<ConfigResponse["config"]>;

export type ModelCapabilityProfile = {
  readonly profileId: string;
  readonly providerKind?: "openai_compatible";
  readonly protocolKind?: "openai_responses" | "openai_compatible_chat_completions";
  readonly model: string;
  readonly capabilities: ModelCapabilities;
};

export type ModelCapabilities = {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly supportsToolCalling?: boolean;
  readonly supportsParallelToolCalls?: boolean;
  readonly supportsStructuredOutputs?: boolean;
  readonly supportsStreaming?: boolean;
  readonly supportsVisionInput?: boolean;
  readonly supportsReasoningEffort?: boolean;
  readonly supportsReasoningOutput?: boolean;
  readonly preferredApiStyle?: string;
  readonly stability?: string;
  readonly lastVerifiedAt?: string;
};

export type ProductInfo = {
  readonly name?: string;
  readonly version?: string;
  readonly defaultEntry?: string;
  readonly runtimeMode?: "agent";
  readonly runtimeModeLabel?: string;
  readonly configDirectory: string;
  readonly productHome: string;
};

export type AppearanceConfig = {
  readonly source?: "builtin_panel_styles" | "user_config" | string;
  readonly themeLabel?: string;
  readonly densityLabel?: string;
  readonly colorScheme?: "light" | "dark" | string;
  readonly configurable?: boolean;
  readonly updatedAt?: string;
};

export type CommandShellKind = "cmd" | "powershell" | "pwsh" | "bash" | "sh";
export type ConfiguredCommandShellKind = CommandShellKind | "auto";

export type ToolConfirmationPolicy = "prompt" | "full_access";

export type ToolConfirmationConfig = {
  readonly policy?: ToolConfirmationPolicy;
  readonly label?: string;
  readonly shellCommandConfirmation?: "prompt" | "skipped_by_full_access";
  readonly shellCommandRequiresConfirmation?: boolean;
  readonly summary?: string;
  readonly riskDisclosure?: string;
  readonly updatedAt?: string;
};

export type OrdinaryAgentPromptConfig = {
  readonly systemPrompt?: string;
  readonly systemPromptVariant?: string;
  readonly promptRef?: string;
  readonly promptVersion?: string;
  readonly updatedAt?: string;
  readonly isDefault?: boolean;
  readonly maxSystemPromptChars?: number;
  readonly variants?: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
};

export type SkillTriggerMode = "keyword" | "model";

export type SkillTriggerConfig = {
  readonly mode?: SkillTriggerMode;
  readonly label?: string;
  readonly modelRouterEnabled?: boolean;
  readonly summary?: string;
  readonly updatedAt?: string;
};

export type CommandShellConfig = {
  readonly configuredKind?: ConfiguredCommandShellKind;
  readonly autoDetected?: boolean;
  readonly kind?: CommandShellKind;
  readonly label?: string;
  readonly executable?: string;
  readonly syntax?: "cmd" | "powershell" | "posix";
  readonly platform?: string;
  readonly invocation?: readonly string[];
  readonly commandLineParameter?: "commandLine";
  readonly notes?: readonly string[];
  readonly availableShells?: readonly CommandShellOption[];
  readonly runtimeTools?: readonly RuntimeEnvironmentTool[];
  readonly updatedAt?: string;
};

export type CommandShellOption = {
  readonly kind?: CommandShellKind;
  readonly label?: string;
  readonly executable?: string;
  readonly syntax?: "cmd" | "powershell" | "posix";
  readonly availability?: "available" | "missing";
  readonly reason?: string;
};

export type RuntimeEnvironmentTool = {
  readonly id?: "node" | "python" | "git-bash";
  readonly label?: string;
  readonly description?: string;
  readonly executable?: string;
  readonly availability?: "available" | "missing";
  readonly reason?: string;
};

export type ModelProviderPreset = {
  readonly presetId: string;
  readonly label: string;
  readonly vendor: string;
  readonly description: string;
  readonly providerKind: "openai_compatible";
  readonly protocolKind: "openai_responses" | "openai_compatible_chat_completions";
  readonly baseUrl: string;
  readonly modelsPath: string;
  readonly defaultModel?: string;
  readonly regionLabel?: string;
  readonly docsUrl?: string;
};

export type ModelProviderModelCatalog = {
  readonly profileId: string;
  readonly label?: string;
  readonly baseUrl: string;
  readonly modelsPath: string;
  readonly fetchedAt: string;
  readonly models: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly owner?: string;
    readonly createdAt?: string;
  }[];
};
