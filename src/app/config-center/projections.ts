import type {
  LocalSettings,
  ConfiguredWebSearchProvider,
  LocalDevSecretStore,
  SanitizedOrdinaryAgentPromptConfig,
  SanitizedInformationAccessConfig,
  SanitizedModelProviderConfig,
  SanitizedWebSearchConfig,
  ModelProviderProfileSettings,
} from "../../domain/config/index.js";
import {
  DEFAULT_MODEL_PROVIDER_BASE_URL,
  normalizeBaseUrl,
} from "./model-provider-settings.js";
import { normalizeInformationAccessSettings, requireActiveModelProfile, webSearchProviderSettings } from "./settings-schema.js";
import { toSanitizedOrdinaryAgentPromptConfig as projectSanitizedOrdinaryAgentPromptConfig } from "./ordinary-agent-prompt-settings.js";

export async function toSanitizedModelProviderConfig(input: {
  readonly settings: LocalSettings;
  readonly secretStore: LocalDevSecretStore;
}): Promise<SanitizedModelProviderConfig> {
  return toSanitizedModelProfile({
    profile: requireActiveModelProfile(input.settings),
    secretStore: input.secretStore,
  });
}

export async function toSanitizedModelProfile(input: {
  readonly profile: ModelProviderProfileSettings;
  readonly secretStore: LocalDevSecretStore;
}): Promise<SanitizedModelProviderConfig> {
  const secret = await input.secretStore.getMetadata(input.profile.secretRef);
  return {
    profileId: input.profile.profileId,
    label: input.profile.label,
    logoDataUrl: input.profile.logoDataUrl,
    providerKind: input.profile.providerKind,
    protocolKind: input.profile.protocolKind,
    baseUrl: normalizeBaseUrl(input.profile.baseUrl) ?? DEFAULT_MODEL_PROVIDER_BASE_URL,
    model: input.profile.model,
    openAI: input.profile.openAI,
    defaultAiMode: input.profile.defaultAiMode,
    secretRef: input.profile.secretRef,
    enabled: input.profile.enabled,
    secretConfigured: secret.configured,
    secretUpdatedAt: secret.updatedAt,
    updatedAt: input.profile.updatedAt,
  };
}

export async function toSanitizedInformationAccessConfig(input: {
  readonly settings: LocalSettings;
  readonly secretStore: LocalDevSecretStore;
}): Promise<SanitizedInformationAccessConfig> {
  const webSearch = await toSanitizedWebSearchConfig(input);
  return {
    web: {
      provider: webSearch.provider,
      providerKind: webSearch.providerKind,
      maxResults: webSearch.maxResults,
      secretRef: webSearch.secretRef,
      secretConfigured: webSearch.secretConfigured,
      secretUpdatedAt: webSearch.secretUpdatedAt,
      endpoint: webSearch.endpoint,
      searchDepth: webSearch.searchDepth,
      searchType: webSearch.searchType,
      searchEngine: webSearch.searchEngine,
      engineId: webSearch.engineId,
      market: webSearch.market,
      status: webSearch.status,
      updatedAt: webSearch.updatedAt,
    },
  };
}

export async function toSanitizedWebSearchConfig(input: {
  readonly settings: LocalSettings;
  readonly secretStore: LocalDevSecretStore;
}): Promise<SanitizedWebSearchConfig> {
  const informationAccess = normalizeInformationAccessSettings(input.settings.informationAccess, input.settings.updatedAt);
  const provider = informationAccess.webSearch.provider;
  const providerSettings = webSearchProviderSettings(informationAccess, provider);
  const secret = providerSettings === undefined
    ? undefined
    : await input.secretStore.getMetadata(providerSettings.secretRef);
  const hasRequiredProviderOptions = providerHasRequiredOptions(provider, providerSettings);
  const secretConfigured = secret?.configured === true;
  return {
    provider,
    providerKind: providerSettings?.providerKind,
    maxResults: providerSettings?.maxResults ?? informationAccess.tavily.maxResults,
    secretRef: providerSettings?.secretRef,
    secretConfigured,
    secretUpdatedAt: secret?.updatedAt,
    endpoint: providerSettings?.endpoint,
    searchDepth: providerSettings?.searchDepth,
    searchType: providerSettings?.searchType,
    searchEngine: providerSettings?.searchEngine,
    engineId: providerSettings?.engineId,
    market: providerSettings?.market,
    status: provider === "none"
      ? "disabled"
      : provider === "model_builtin" || (secretConfigured && hasRequiredProviderOptions)
        ? "ready"
        : "no-provider",
    updatedAt: informationAccess.webSearch.updatedAt,
  };
}

export function toSanitizedOrdinaryAgentPromptConfig(
  settings: LocalSettings
): SanitizedOrdinaryAgentPromptConfig {
  return projectSanitizedOrdinaryAgentPromptConfig(settings.ordinaryAgent, { now: settings.updatedAt });
}

function providerHasRequiredOptions(
  provider: ConfiguredWebSearchProvider,
  settings: ReturnType<typeof webSearchProviderSettings>
): boolean {
  if (provider === "none") {
    return false;
  }
  if (provider === "model_builtin") {
    return true;
  }
  if (provider === "google") {
    return typeof settings?.engineId === "string" && settings.engineId.trim().length > 0;
  }
  return settings !== undefined;
}
