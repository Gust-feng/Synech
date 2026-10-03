import {
  createModelCollectionChannel,
  createModelProviderBindingAsync,
  createNativeModelProviderCollection,
  publishNativeModelRegistry,
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
  resolveModelRuntimeConfig,
  type ResolvedModelRuntimeMode,
  type ResolvedModelRuntimeConfig,
} from "../../model-runtime/model-runtime-config.js";
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
 * - `createAuxiliaryModelChannel` —— 配方之上的无工具单 shot 辅助通道
 *   （固定 `thinkingLevel: "off"`）：研究成稿/核验、记忆整理、会话标题复用。
 */

export type AuxiliaryModelChannelInput = {
  readonly configCenter?: ConfigCenter;
  readonly abortSignal?: AbortSignal;
  readonly resolved: ResolvedModelRuntimeConfig;
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
  readonly mode: ResolvedModelRuntimeMode;
  readonly informationAccess?: Pick<SanitizedInformationAccessConfig, "web">;
}): () => Promise<string | undefined> {
  const { configCenter, provider, mode } = input;
  return async () => {
    if (mode === "native") return configCenter.getModelProviderApiKey(provider.profileId);
    try {
      const current = await configCenter.createModelRuntimeEnvironment({
        modelProvider: provider,
        ...(input.informationAccess === undefined ? {} : { informationAccess: input.informationAccess }),
      });
      return resolveModelRuntimeConfig({ mode, env: current, modelProvider: provider }).apiKey;
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
export async function createFrozenProviderBinding(input: {
  readonly configCenter?: ConfigCenter;
  readonly abortSignal?: AbortSignal;
  readonly resolved: ResolvedModelRuntimeConfig;
  readonly profileId: SanitizedModelProviderConfig["profileId"];
  readonly piProviderId?: string;
  readonly resolveApiKey: () => Promise<string | undefined>;
  /**
   * 调用方显式冻结的 API key。既有 adapter 语义下 `resolveApiKey` 存在时该字段不被
   * 读取；调用点是否冻结 key 由自己显式声明，本配方不补齐也不丢弃。
   */
  readonly apiKey?: string;
}): Promise<ModelProviderBinding> {
  const credentialStore = input.resolved.protocol === "native" && input.configCenter !== undefined
    ? await input.configCenter.createModelProviderCredentialStore(input.profileId)
    : undefined;
  const binding = await createModelProviderBindingAsync({
    protocol: input.resolved.protocol,
    baseUrl: input.resolved.baseUrl,
    model: input.resolved.model,
    profileId: input.profileId,
    secretUpdatedAt: input.resolved.secretUpdatedAt,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    resolveApiKey: input.resolveApiKey,
    ...(credentialStore === undefined ? {} : { credentialStore }),
    ...(input.resolved.connection === undefined ? {} : { connection: input.resolved.connection }),
    ...((input.piProviderId ?? input.resolved.piProviderId) === undefined
      ? {}
      : { piProviderId: input.piProviderId ?? input.resolved.piProviderId }),
    providerProfileId: input.resolved.providerProfileId,
    requestSettings: input.resolved.requestSettings,
    modelConfiguration: input.resolved.modelConfiguration,
    enableWebSearch: input.resolved.enableWebSearch,
  }, { signal: input.abortSignal });
  if (input.resolved.protocol === "native" && input.configCenter !== undefined) {
    await publishCurrentNativeRegistry(input.configCenter, input.profileId, {
      providerId: binding.selectedModel.provider,
      modelRegistry: binding.catalogRegistry ?? binding.modelRegistry,
    }, input.abortSignal);
  }
  return binding;
}

export async function createAuxiliaryModelChannel(
  input: AuxiliaryModelChannelInput,
): Promise<IntelligenceChannel> {
  const binding = await createFrozenProviderBinding({
    ...(input.configCenter === undefined ? {} : { configCenter: input.configCenter }),
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    resolved: input.resolved,
    profileId: input.profileId,
    resolveApiKey: input.resolveApiKey,
    apiKey: input.resolved.apiKey,
    ...(input.piProviderId === undefined ? {} : { piProviderId: input.piProviderId }),
  });
  return createModelCollectionChannel({
    protocolKind: input.resolved.protocol,
    modelRegistry: binding.modelRegistry,
    selectedModel: binding.selectedModel,
    transformProviderPayload: binding.transformProviderPayload,
    providerKind: input.providerKind,
    thinkingLevel: "off",
    supportedPurposes: input.supportedPurposes,
  });
}

export async function fetchPanelModelCatalog(input: {
  readonly configCenter?: ConfigCenter;
  readonly profile: Pick<SanitizedModelProviderConfig, "profileId" | "label" | "baseUrl" | "piProviderId"> &
    Partial<Pick<SanitizedModelProviderConfig, "protocolKind" | "connection" | "secretUpdatedAt">>;
  readonly apiKey?: string;
  readonly fetch?: PanelModelCatalogFetch;
  readonly abortSignal?: AbortSignal;
}): Promise<ModelProviderModelCatalog> {
  if (input.profile.protocolKind === "native") {
    if (input.configCenter === undefined) throw new Error("Native catalog discovery requires the profile credential owner.");
    const credentialStore = await input.configCenter.createModelProviderCredentialStore(input.profile.profileId);
    const { providerId, modelRegistry } = createNativeModelProviderCollection({
      profileId: input.profile.profileId,
      secretUpdatedAt: input.profile.secretUpdatedAt,
      piProviderId: input.profile.piProviderId,
      baseUrl: input.profile.baseUrl,
      connection: input.profile.connection,
      credentialStore,
    });
    const refreshed = await modelRegistry.refresh({
      providers: [providerId],
      allowNetwork: true,
      force: true,
      signal: input.abortSignal,
    });
    if (refreshed.aborted) throw new Error("Native model discovery was cancelled.");
    const refreshFailure = refreshed.errors.get(providerId);
    if (refreshFailure !== undefined) throw refreshFailure;
    if (await modelRegistry.getAuth(providerId, { signal: input.abortSignal }) === undefined) {
      throw new ModelRuntimeConfigurationError({
        code: "missing_api_key",
        message: "模型服务尚未完成身份验证。",
        summaryInput: { enabled: true, mode: "native", providerId, protocolKind: "native" },
      });
    }
    const available = await modelRegistry.getAvailable(providerId, { signal: input.abortSignal });
    await publishCurrentNativeRegistry(input.configCenter, input.profile.profileId, {
      providerId,
      modelRegistry,
    }, input.abortSignal);
    return {
      profileId: input.profile.profileId,
      label: input.profile.label,
      baseUrl: input.profile.baseUrl,
      modelsPath: "/pi-catalog",
      fetchedAt: new Date().toISOString(),
      models: available.map((model) => ({
        id: model.id,
        displayName: model.name,
        owner: input.profile.piProviderId,
      })),
    };
  }
  if (input.apiKey === undefined) throw new Error("Custom model discovery requires an API key.");
  return fetchOpenAICompatibleModelCatalog({ ...input, apiKey: input.apiKey });
}

async function publishCurrentNativeRegistry(
  configCenter: ConfigCenter,
  profileId: string,
  collection: Pick<ModelProviderBinding, "modelRegistry"> & { readonly providerId: string },
  signal?: AbortSignal,
): Promise<void> {
  const profile = (await configCenter.listModelProviderProfiles()).find((item) => item.profileId === profileId);
  if (profile === undefined) throw new Error("The model connection was removed during model discovery.");
  await publishNativeModelRegistry({
    profileId: profile.profileId,
    piProviderId: profile.piProviderId,
    baseUrl: profile.baseUrl,
    connection: profile.connection,
    secretUpdatedAt: profile.secretUpdatedAt,
  }, collection, { signal });
}
