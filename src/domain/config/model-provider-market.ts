import type {
  ConfiguredModelProtocolKind,
  ModelProviderPreset,
  ProviderProtocolProfile,
  ProviderProtocolProfileId,
} from "./model-settings.js";

export const BUILTIN_PROVIDER_PROTOCOL_PROFILES: readonly ProviderProtocolProfile[] = [
  {
    profileId: "openai",
    label: "OpenAI",
    providerKind: "openai_compatible",
    recommendedProtocolKind: "openai_responses",
    supportedProtocolKinds: ["openai_responses", "openai_compatible_chat_completions"],
    defaultBaseUrl: "https://api.openai.com/v1",
    modelsPath: "/models",
    unsupportedParams: [],
    ignoredParams: [],
    dangerousParams: [],
  },
  {
    profileId: "deepseek",
    label: "DeepSeek",
    providerKind: "openai_compatible",
    recommendedProtocolKind: "openai_compatible_chat_completions",
    supportedProtocolKinds: ["openai_compatible_chat_completions"],
    defaultBaseUrl: "https://api.deepseek.com",
    modelsPath: "/models",
    unsupportedParams: ["openai_responses.input", "openai_responses.previous_response_id"],
    ignoredParams: ["temperature_when_thinking", "top_p_when_thinking"],
    dangerousParams: ["tool_choice_when_thinking"],
  },
  {
    profileId: "moonshot",
    label: "Kimi / Moonshot",
    providerKind: "openai_compatible",
    recommendedProtocolKind: "openai_compatible_chat_completions",
    supportedProtocolKinds: ["openai_compatible_chat_completions"],
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    modelsPath: "/models",
    unsupportedParams: ["openai_responses.input", "openai_responses.previous_response_id"],
    ignoredParams: [],
    dangerousParams: [],
  },
  {
    profileId: "glm",
    label: "GLM / Z.AI",
    providerKind: "openai_compatible",
    recommendedProtocolKind: "openai_compatible_chat_completions",
    supportedProtocolKinds: ["openai_compatible_chat_completions"],
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelsPath: "/models",
    unsupportedParams: ["openai_responses.input", "openai_responses.previous_response_id"],
    ignoredParams: [],
    dangerousParams: [],
  },
  {
    profileId: "minimax",
    label: "MiniMax",
    providerKind: "openai_compatible",
    recommendedProtocolKind: "anthropic_messages",
    supportedProtocolKinds: ["anthropic_messages"],
    defaultBaseUrl: "https://api.minimaxi.com/anthropic",
    modelsPath: "/models",
    unsupportedParams: ["openai_responses.input", "openai_responses.previous_response_id"],
    ignoredParams: ["presence_penalty", "frequency_penalty", "logit_bias"],
    dangerousParams: [],
  },
  {
    profileId: "openai_compatible",
    label: "通用 OpenAI 兼容",
    providerKind: "openai_compatible",
    recommendedProtocolKind: "openai_compatible_chat_completions",
    supportedProtocolKinds: ["openai_compatible_chat_completions", "openai_responses"],
    defaultBaseUrl: "https://api.example.com/v1",
    modelsPath: "/models",
    unsupportedParams: [],
    ignoredParams: [],
    dangerousParams: [],
  },
];

export const BUILTIN_MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
  {
    presetId: "openai",
    label: "OpenAI",
    vendor: "OpenAI",
    description: "OpenAI GPT 模型服务，模型列表来自 /v1/models。",
    providerKind: "openai_compatible",
    protocolKind: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    modelsPath: "/models",
    protocolProfileId: "openai",
    supportedProtocolKinds: ["openai_responses", "openai_compatible_chat_completions"],
    regionLabel: "全球",
    docsUrl: "https://platform.openai.com/docs",
    piProviderId: "openai",
  },
  {
    presetId: "deepseek",
    label: "DeepSeek",
    vendor: "DeepSeek",
    description: "DeepSeek OpenAI-compatible 接口，适合通用对话、代码和工具调用场景。",
    providerKind: "openai_compatible",
    protocolKind: "openai_compatible_chat_completions",
    baseUrl: "https://api.deepseek.com",
    modelsPath: "/models",
    protocolProfileId: "deepseek",
    supportedProtocolKinds: ["openai_compatible_chat_completions"],
    regionLabel: "全球",
    docsUrl: "https://api-docs.deepseek.com/",
    piProviderId: "deepseek",
  },
  {
    presetId: "moonshot",
    label: "月之暗面",
    vendor: "Moonshot AI",
    description: "月之暗面 Kimi 国内 OpenAI-compatible 接口。",
    providerKind: "openai_compatible",
    protocolKind: "openai_compatible_chat_completions",
    baseUrl: "https://api.moonshot.cn/v1",
    modelsPath: "/models",
    protocolProfileId: "moonshot",
    supportedProtocolKinds: ["openai_compatible_chat_completions"],
    regionLabel: "国内",
    docsUrl: "https://platform.moonshot.cn/docs/guide/start-using-kimi-api",
    piProviderId: "moonshotai-cn",
  },
  {
    presetId: "glm",
    label: "智谱 AI",
    vendor: "智谱 AI",
    description: "GLM / BigModel OpenAI-compatible 接口。",
    providerKind: "openai_compatible",
    protocolKind: "openai_compatible_chat_completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelsPath: "/models",
    protocolProfileId: "glm",
    supportedProtocolKinds: ["openai_compatible_chat_completions"],
    regionLabel: "国内",
    docsUrl: "https://docs.bigmodel.cn/",
    piProviderId: "zai-coding-cn",
  },
  {
    presetId: "minimax",
    label: "MiniMax",
    vendor: "MiniMax",
    description: "MiniMax 国内 Anthropic Messages 接口，由 Pi 原生 MiniMax Provider 提供模型语义。",
    providerKind: "openai_compatible",
    protocolKind: "anthropic_messages",
    baseUrl: "https://api.minimaxi.com/anthropic",
    modelsPath: "/models",
    protocolProfileId: "minimax",
    supportedProtocolKinds: ["anthropic_messages"],
    regionLabel: "国内",
    docsUrl: "https://platform.minimax.io/docs/api-reference/text-chat-anthropic",
    // pi 的 MiniMax Provider 以 Anthropic Messages 协议指向国内端点，直接映射，
    // 不为它另开一条 OpenAI 兼容特判。
    piProviderId: "minimax-cn",
  },
];

export function listBuiltinModelProviderPresets(): readonly ModelProviderPreset[] {
  return BUILTIN_MODEL_PROVIDER_PRESETS.map((preset) => ({
    ...preset,
    ...(preset.piProviderIds === undefined ? {} : { piProviderIds: [...preset.piProviderIds] }),
  }));
}

export function listBuiltinProviderProtocolProfiles(): readonly ProviderProtocolProfile[] {
  return BUILTIN_PROVIDER_PROTOCOL_PROFILES.map((profile) => ({ ...profile }));
}

export function builtinProviderProtocolProfile(
  profileId: ProviderProtocolProfileId
): ProviderProtocolProfile | undefined {
  return BUILTIN_PROVIDER_PROTOCOL_PROFILES.find((profile) => profile.profileId === profileId);
}

export function recommendedProtocolForProviderProtocolProfile(
  profileId: ProviderProtocolProfileId
): ConfiguredModelProtocolKind | undefined {
  return builtinProviderProtocolProfile(profileId)?.recommendedProtocolKind;
}
