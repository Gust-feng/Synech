import type {
  LocalDevSecretStore,
  LocalSettings,
  McpServerSettings,
  SanitizedInformationAccessConfig,
  SanitizedModelProviderConfig,
  WebSearchRuntimeConfig,
} from "../../domain/config/index.js";
import { collectMcpRuntimeSecretRefs } from "./mcp-settings-service.js";
import {
  toSanitizedInformationAccessConfig,
  toWebSearchRuntimeConfig,
} from "./projections.js";
import {
  DEFAULT_MODEL_PROVIDER_BASE_URL,
  normalizeBaseUrl,
  normalizeInformationAccessSettings,
  requireActiveModelProfile,
} from "./settings-schema.js";

export type ModelRuntimeConfigEnvironment = Readonly<Record<string, string | undefined>>;

export type CreateModelRuntimeEnvironmentInput = {
  readonly modelProvider?: Pick<SanitizedModelProviderConfig, "secretRef" | "model" | "baseUrl">;
  readonly informationAccess?: Pick<SanitizedInformationAccessConfig, "web">;
};

export type CreateMcpRuntimeEnvironmentInput = {
  readonly servers?: readonly Pick<
    McpServerSettings,
    "envSecretRefs" | "headerSecretRefs" | "bearerTokenSecretRef" | "apiKeySecretRef"
  >[];
  readonly baseEnv?: ModelRuntimeConfigEnvironment;
};

export async function createModelRuntimeEnvironment(
  settings: LocalSettings,
  secretStore: LocalDevSecretStore,
  input: CreateModelRuntimeEnvironmentInput,
): Promise<ModelRuntimeConfigEnvironment> {
  const modelProvider = input.modelProvider ?? requireActiveModelProfile(settings);
  const apiKey = await secretStore.readSecret(modelProvider.secretRef);
  const informationAccess = normalizeInformationAccessSettings(settings.informationAccess, settings.updatedAt);
  const webProvider = input.informationAccess?.web.provider ?? informationAccess.webSearch.provider;
  return {
    SYNECH_MODEL_API_KEY: apiKey,
    SYNECH_MODEL_NAME: modelProvider.model,
    SYNECH_MODEL_BASE_URL: normalizeBaseUrl(modelProvider.baseUrl) ?? DEFAULT_MODEL_PROVIDER_BASE_URL,
    SYNECH_MODEL_BUILTIN_WEB_SEARCH: webProvider === "model_builtin" ? "true" : undefined,
    OPENAI_API_KEY: undefined,
  };
}

export async function createMcpRuntimeEnvironment(
  settings: LocalSettings,
  secretStore: LocalDevSecretStore,
  input: CreateMcpRuntimeEnvironmentInput,
): Promise<ModelRuntimeConfigEnvironment> {
  const servers = input.servers ?? settings.mcpServers ?? [];
  const output: Record<string, string | undefined> = { ...(input.baseEnv ?? {}) };
  for (const ref of collectMcpRuntimeSecretRefs(servers)) {
    output[ref] = input.baseEnv?.[ref] ?? await secretStore.readSecret(ref);
  }
  return output;
}

export async function resolveWebSearchRuntimeConfig(
  settings: LocalSettings,
  secretStore: LocalDevSecretStore,
  web?: SanitizedInformationAccessConfig["web"],
): Promise<WebSearchRuntimeConfig | undefined> {
  const effectiveWeb = web ?? (await toSanitizedInformationAccessConfig({ settings, secretStore })).web;
  return toWebSearchRuntimeConfig({ web: effectiveWeb, secretStore });
}
