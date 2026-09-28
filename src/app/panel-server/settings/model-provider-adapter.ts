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
 *   冻结运行事实 + 连接上显式的 `piProviderId` + 取 key 闭包。模型能力事实由
 *   adapter 在 pi 真实 catalog 中精确匹配后直接使用，本文件不传入也不重定义能力。
 * - `createOpenAIAuxiliaryModelChannel` —— 配方之上的无工具单 shot 辅助通道
 *   （固定 `thinkingLevel: "off"`）：研究成稿/核验、记忆整理、会话标题复用。
 */

export type OpenAIAuxiliaryModelChannelInput = {
  readonly resolved: ResolvedOpenAIModelRuntimeConfig;
  readonly profileId: SanitizedModelProviderConfig["profileId"];
  readonly providerKind: ModelProviderKind;
  readonly resolveApiKey: () => Promise<string | undefined>;
  readonly supportedPurposes: readonly OrdinaryModelPurpose[];
  /** 连接显式声明的 pi provider（已知模型事实的匹配作用域）；无声明 = 全部未知。 */
  readonly piProviderId?: string;
};

/** 取 key 需要的 provider 事实（ConfigCenter 投影 → 当前运行时环境 → 解析）。 */
export type ConfigCenterApiKeyProvider = Pick<
  SanitizedModelProviderConfig,
  "profileId" | "baseUrl" | "model" | "openAI" | "secretRef"
>;

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
 * 的冻结运行事实（protocol 只作为未知模型的默认 transport），`piProviderId` 是连接
 * 显式声明的 pi provider——已知模型的 api / compat / input / contextWindow /
 * maxTokens / thinkingLevelMap / reasoning / cost 由 adapter 在 pi 真实 catalog 中
 * 精确匹配后直接使用，调用点不传能力、也不在此重定义模型能力。
 */
export function createFrozenProviderBinding(input: {
  readonly resolved: ResolvedOpenAIModelRuntimeConfig;
  readonly profileId: SanitizedModelProviderConfig["profileId"];
  readonly piProviderId?: string;
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
    ...(input.piProviderId === undefined ? {} : { piProviderId: input.piProviderId }),
    providerProfileId: input.resolved.providerProfileId,
    requestSettings: input.resolved.requestSettings,
    enableWebSearch: input.resolved.enableWebSearch,
  });
}

export function createOpenAIAuxiliaryModelChannel(
  input: OpenAIAuxiliaryModelChannelInput,
): IntelligenceChannel {
  const binding = createFrozenProviderBinding({
    resolved: input.resolved,
    profileId: input.profileId,
    resolveApiKey: input.resolveApiKey,
    apiKey: input.resolved.apiKey,
    ...(input.piProviderId === undefined ? {} : { piProviderId: input.piProviderId }),
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
