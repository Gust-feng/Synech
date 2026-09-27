import {
  createModelCollectionChannel,
  createModelProviderBinding,
  fetchOpenAICompatibleModelCatalog,
  type ModelProviderBinding,
} from "../../../adapters/intelligence/index.js";
import type {
  IntelligenceChannel,
  ModelProviderKind,
  OrdinaryModelPurpose,
} from "../../../domain/intelligence/index.js";
import type {
  ModelProviderModelCatalog,
  SanitizedInformationAccessConfig,
  SanitizedModelProviderConfig,
} from "../../../domain/config/index.js";
import {
  ModelRuntimeConfigurationError,
  resolveOpenAIModelRuntimeConfig,
  type OpenAIModelRuntimeMode,
  type ResolvedOpenAIModelRuntimeConfig,
} from "../../model-runtime/openai-runtime-config.js";
import type { ConfigCenter } from "../../config-center/index.js";
import type { PanelModelCatalogFetch } from "../types.js";

/**
 * Host-owned construction of the concrete Pi/provider channel.
 *
 * 本文件是「provider binding 装配」与「动态取 API key」语义的唯一 owner：
 *
 * - `createConfigCenterApiKeyResolver` —— 取 key 闭包：每次请求前按 ConfigCenter
 *   当前环境重新解析 API key；只有配置类错误降级为 `undefined`（当前没有可用 key），
 *   其余错误继续上抛。研究 turn、Ordinary run、研究成稿/核验、记忆整理与会话标题
 *   共用这一份语义，调用点不再各自复制闭包。
 * - `createFrozenProviderBinding` —— 冻结 provider binding 的装配配方：一次解析出的
 *   冻结运行事实 + 调用方从 `resolveModelCapabilities` 取得的能力事实 + 取 key 闭包。
 *   研究 turn 与 Ordinary run 共用同一份配方，调用点不重写配方。
 * - `createOpenAIAuxiliaryModelChannel` —— 配方之上的无工具单 shot 辅助通道
 *   （固定 `thinkingLevel: "off"`）：研究成稿/核验、记忆整理、会话标题复用。
 *
 * 冻结运行事实（protocol / baseUrl / model / requestSettings / providerProfileId /
 * enableWebSearch）只来自 `resolveOpenAIModelRuntimeConfig` 的一次解析结果，本文件
 * 不提供覆盖形参——第二套来源只会在调用点重新漂移。能力事实（视觉输入、推理输出、
 * 上下文窗口、输出上限）由调用方从 `resolveModelCapabilities` 取，本文件不重定义
 * 模型能力。
 */

export type OpenAIAuxiliaryModelChannelInput = {
  readonly resolved: ResolvedOpenAIModelRuntimeConfig;
  readonly profileId: SanitizedModelProviderConfig["profileId"];
  readonly providerKind: ModelProviderKind;
  readonly resolveApiKey: () => Promise<string | undefined>;
  readonly supportsVisionInput: boolean;
  readonly supportsReasoningOutput: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportedPurposes: readonly OrdinaryModelPurpose[];
};

/** 取 key 需要的 provider 事实（ConfigCenter 投影 → 当前运行时环境 → 解析）。 */
export type ConfigCenterApiKeyProvider = Pick<
  SanitizedModelProviderConfig,
  "profileId" | "baseUrl" | "model" | "openAI" | "secretRef"
>;

/**
 * 冻结能力事实：四个字段全部由调用方从 `resolveModelCapabilities` 取得，本文件不重定义
 * 模型能力。
 *
 * 两个 token 上限允许显式 `undefined`（辅助通道的既有入参形状就是可选），但字段必须
 * 在调用点显式出现——静默省略只会落到 Pi 的 DEFAULT 常量，让窗口与输出上限的判断建立
 * 在错数上。视觉输入 / 推理输出沿用 `ModelCapabilities` 的可选与布尔形状。
 */
export type FrozenProviderCapabilities = {
  readonly supportsVisionInput: boolean;
  readonly supportsReasoningOutput?: boolean;
  readonly contextWindowTokens: number | undefined;
  readonly maxOutputTokens: number | undefined;
};

/**
 * 动态取 API key：每次请求前解析 ConfigCenter 当前环境，配置类错误降级为 undefined。
 *
 * 降级语义必须与调用点原样一致：只有 `ModelRuntimeConfigurationError`（缺 key /
 * 缺模型名等配置缺项）被吞掉并降级为「当前没有可用 key」，其余错误（配置读取、密钥
 * 存储故障）继续上抛，不掩盖 Product Home 完整性问题。
 */
export function createConfigCenterApiKeyResolver(input: {
  readonly configCenter: ConfigCenter;
  readonly provider: ConfigCenterApiKeyProvider;
  readonly mode: OpenAIModelRuntimeMode;
  readonly informationAccess?: Pick<SanitizedInformationAccessConfig, "web">;
}): () => Promise<string | undefined> {
  const { configCenter, provider, mode } = input;
  return async () => {
    try {
      const current = await configCenter.createModelRuntimeEnvironment({
        modelProvider: provider,
        ...(input.informationAccess === undefined ? {} : { informationAccess: input.informationAccess }),
      });
      return resolveOpenAIModelRuntimeConfig({ mode, env: current, modelProvider: provider }).apiKey;
    } catch (error) {
      if (error instanceof ModelRuntimeConfigurationError) return undefined;
      throw error;
    }
  };
}

/**
 * 冻结 provider binding：研究 turn 与 Ordinary run 共用的装配配方。
 *
 * 同一份配方只有一份：`profileId` 决定 Pi provider 注册键，`resolved` 是一次解析出
 * 的冻结运行事实，`capabilities` 是调用方从 `resolveModelCapabilities` 取到的能力
 * 事实，`resolveApiKey` 提供每次请求前的当前 key 解析。调用点不得各自重写配方——
 * 重写只会让冻结语义与字段集合再次漂移。
 */
export function createFrozenProviderBinding(input: {
  readonly resolved: ResolvedOpenAIModelRuntimeConfig;
  readonly profileId: SanitizedModelProviderConfig["profileId"];
  readonly capabilities: FrozenProviderCapabilities;
  readonly resolveApiKey: () => Promise<string | undefined>;
  /**
   * 调用方显式冻结的 API key。既有 adapter 语义下 `resolveApiKey` 存在时该字段不被
   * 读取；调用点是否冻结 key 由自己显式声明，本配方不补齐也不丢弃。
   */
  readonly apiKey?: string;
}): ModelProviderBinding {
  return createModelProviderBinding({
    protocol: input.resolved.protocol,
    baseUrl: input.resolved.baseUrl,
    model: input.resolved.model,
    profileId: input.profileId,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    resolveApiKey: input.resolveApiKey,
    providerProfileId: input.resolved.providerProfileId,
    requestSettings: input.resolved.requestSettings,
    enableWebSearch: input.resolved.enableWebSearch,
    supportsVisionInput: input.capabilities.supportsVisionInput === true,
    supportsReasoningOutput: input.capabilities.supportsReasoningOutput === true,
    contextWindow: input.capabilities.contextWindowTokens,
    maxOutputTokens: input.capabilities.maxOutputTokens,
  });
}

export function createOpenAIAuxiliaryModelChannel(
  input: OpenAIAuxiliaryModelChannelInput,
): IntelligenceChannel {
  const binding = createFrozenProviderBinding({
    resolved: input.resolved,
    profileId: input.profileId,
    capabilities: {
      supportsVisionInput: input.supportsVisionInput,
      supportsReasoningOutput: input.supportsReasoningOutput,
      contextWindowTokens: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
    },
    resolveApiKey: input.resolveApiKey,
    apiKey: input.resolved.apiKey,
  });
  return createModelCollectionChannel({
    modelRegistry: binding.modelRegistry,
    selectedModel: binding.selectedModel,
    transformProviderPayload: binding.transformProviderPayload,
    providerKind: input.providerKind,
    thinkingLevel: "off",
    supportedPurposes: input.supportedPurposes,
  });
}

export async function fetchPanelModelCatalog(input: {
  readonly profile: Pick<SanitizedModelProviderConfig, "profileId" | "label" | "baseUrl">;
  readonly apiKey: string;
  readonly fetch?: PanelModelCatalogFetch;
  readonly abortSignal?: AbortSignal;
}): Promise<ModelProviderModelCatalog> {
  return fetchOpenAICompatibleModelCatalog(input);
}
