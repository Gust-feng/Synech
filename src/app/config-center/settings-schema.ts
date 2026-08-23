import type {
  LocalSettings,
  ConfiguredWebSearchProvider,
  ConfiguredWebSearchProviderKind,
  InformationAccessSettings,
  ModelProviderProfileSettings,
  WebSearchProviderSettings,
} from "../../domain/config/index.js";
import { listBuiltinModelProviderPresets } from "../../domain/config/index.js";
import {
  MODEL_PROVIDER_SECRET_REF,
  createDefaultModelProviderProfile,
  dedupeProfiles,
  normalizeBuiltInModelProviderProfiles,
  normalizeModelCapabilityOverrides,
  normalizeModelCatalogs,
  normalizeModelProfile,
  normalizePositiveInteger,
  normalizeProfileId,
  parseModelCapabilityOverrides,
  parseModelCatalogs,
  parseModelProfile,
} from "./model-provider-settings.js";
import {
  normalizeCommandShellSettings,
  parseCommandShellSettings,
} from "./command-shell-settings.js";
import {
  normalizeToolConfirmationSettings,
  parseToolConfirmationSettings,
} from "./tool-confirmation-settings.js";
import {
  normalizeSkillTriggerSettings,
  parseSkillTriggerSettings,
} from "./skill-trigger-settings.js";
import {
  createDefaultOrdinaryAgentPromptSettings,
  normalizeOrdinaryAgentPromptSettings,
  parseOrdinaryAgentPromptSettings,
} from "./ordinary-agent-prompt-settings.js";
import {
  ConfigSchemaValidationError,
  asRecord,
  optionalString,
  requiredString,
} from "./settings-utils.js";
import {
  normalizeMcpServers,
  normalizeToolStates,
  parseMcpServers,
  parseToolStates,
} from "./tool-mcp-settings.js";

export {
  DEFAULT_MODEL_PROVIDER_BASE_URL,
  MODEL_PROVIDER_SECRET_REF,
  normalizeAiMode,
  normalizeBaseUrl,
  normalizeModelProfile,
  normalizeModelProviderKind,
  normalizeModelProtocolKind,
  normalizePositiveInteger,
  normalizeProfileId,
  sanitizeCapabilityOverride,
} from "./model-provider-settings.js";
export { normalizeOpenAIModelRequestSettings } from "./openai-request-settings.js";
export { ConfigSchemaValidationError, normalizeRequiredConfigString } from "./settings-utils.js";
export {
  normalizeCommandShellSettings,
  normalizeCommandShellUpdate,
  toSanitizedCommandShellConfig,
} from "./command-shell-settings.js";
export {
  normalizeToolConfirmationSettings,
  normalizeToolConfirmationUpdate,
  toSanitizedToolConfirmationConfig,
} from "./tool-confirmation-settings.js";
export {
  normalizeSkillTriggerSettings,
  normalizeSkillTriggerUpdate,
  normalizeSkillTriggerMode,
  toSanitizedSkillTriggerConfig,
} from "./skill-trigger-settings.js";
export {
  ORDINARY_AGENT_SYSTEM_PROMPT_MAX_CHARS,
  DEFAULT_ORDINARY_AGENT_SYSTEM_PROMPT,
  normalizeOrdinaryAgentPromptSettings,
  normalizeOrdinaryAgentPromptUpdate,
  toSanitizedOrdinaryAgentPromptConfig,
} from "./ordinary-agent-prompt-settings.js";
export { parseMcpCommandLine, sanitizeMcpArgs } from "./tool-mcp-settings.js";

export const INFORMATION_TAVILY_SECRET_REF = "secret://local-dev/information-source/tavily/default/api-key";
export const INFORMATION_EXA_SECRET_REF = "secret://local-dev/information-source/exa/default/api-key";
export const INFORMATION_ZAI_SECRET_REF = "secret://local-dev/information-source/zai/default/api-key";
export const INFORMATION_METASO_SECRET_REF = "secret://local-dev/information-source/metaso/default/api-key";
export const INFORMATION_GOOGLE_SECRET_REF = "secret://local-dev/information-source/google/default/api-key";
export const INFORMATION_BING_SECRET_REF = "secret://local-dev/information-source/bing/default/api-key";
const DEFAULT_TAVILY_MAX_RESULTS = 5;
const DEFAULT_EXA_MAX_RESULTS = 5;
const DEFAULT_ZAI_MAX_RESULTS = 5;
const DEFAULT_METASO_MAX_RESULTS = 5;
const DEFAULT_GOOGLE_MAX_RESULTS = 5;
const DEFAULT_BING_MAX_RESULTS = 5;

export function parseLocalSettingsFile(raw: unknown): LocalSettings {
  const record = asRecord(raw);
  if (record.version !== 1) {
    throw new ConfigSchemaValidationError(
      "Settings document is incompatible: expected version 1."
    );
  }
  const updatedAt = requiredString(record.updatedAt, "settings.updatedAt");
  if (!Array.isArray(record.modelProfiles) || record.modelProfiles.length === 0) {
    throw new ConfigSchemaValidationError("settings.modelProfiles must contain at least one profile.");
  }
  const parsedProfiles = record.modelProfiles
    .map((profile) => parseModelProfile(asRecord(profile), {
      fallbackProfileId: undefined,
      fallbackLabel: undefined,
      fallbackSecretRef: MODEL_PROVIDER_SECRET_REF,
      fallbackUpdatedAt: updatedAt,
    }))
    .map((profile) => {
      if (profile.profileId.length === 0) {
        throw new ConfigSchemaValidationError("settings.modelProfiles entries require profileId.");
      }
      return profile;
    });
  const modelProfiles = dedupeProfiles(parsedProfiles);
  if (modelProfiles.length !== parsedProfiles.length) {
    throw new ConfigSchemaValidationError("settings.modelProfiles contains duplicate profileId values.");
  }
  const activeModelProfileId = normalizeProfileId(requiredString(record.activeModelProfileId, "settings.activeModelProfileId"));
  if (!modelProfiles.some((profile) => profile.profileId === activeModelProfileId)) {
    throw new ConfigSchemaValidationError("settings.activeModelProfileId must refer to a configured profile.");
  }
  const informationAccess = asRecord(record.informationAccess);
  const webSearch = asRecord(informationAccess.webSearch);
  const tavily = asRecord(informationAccess.tavily);
  const exa = asRecord(informationAccess.exa);
  const zai = asRecord(informationAccess.zai);
  const metaso = asRecord(informationAccess.metaso);
  const google = asRecord(informationAccess.google);
  const bing = asRecord(informationAccess.bing);
  return normalizeLocalSettings({
    version: 1,
    activeModelProfileId,
    modelProfiles,
    modelProviderOrder: parseModelProviderOrder(record.modelProviderOrder, modelProfiles),
    modelCatalogs: parseModelCatalogs(record.modelCatalogs, updatedAt),
    modelCapabilityOverrides: parseModelCapabilityOverrides(record.modelCapabilityOverrides, updatedAt),
    toolStates: parseToolStates(record.toolStates, updatedAt),
    toolConfirmation: parseToolConfirmationSettings(
      record.toolConfirmation,
      updatedAt
    ),
    ordinaryAgent: parseOrdinaryAgentPromptSettings(record.ordinaryAgent, updatedAt),
    skillTrigger: parseSkillTriggerSettings(record.skillTrigger, updatedAt),
    commandShell: parseCommandShellSettings(record.commandShell, updatedAt),
    mcpServers: parseMcpServers(record.mcpServers, updatedAt),
    informationAccess:
      Object.keys(informationAccess).length === 0
        ? undefined
        : {
            webSearch: {
              provider: parseWebSearchProvider(webSearch.provider),
              updatedAt:
                optionalString(webSearch.updatedAt) ??
                optionalString(tavily.updatedAt) ??
                updatedAt,
            },
            tavily: {
              providerKind: "tavily",
              maxResults: positiveIntegerFromUnknown(tavily.maxResults) ?? DEFAULT_TAVILY_MAX_RESULTS,
              secretRef:
                optionalString(tavily.secretRef) ??
                INFORMATION_TAVILY_SECRET_REF,
              endpoint: optionalString(tavily.endpoint),
              searchDepth: optionalString(tavily.searchDepth) ?? "basic",
              updatedAt: optionalString(tavily.updatedAt) ?? updatedAt,
            },
            exa: {
              providerKind: "exa",
              maxResults: positiveIntegerFromUnknown(exa.maxResults) ?? DEFAULT_EXA_MAX_RESULTS,
              secretRef: optionalString(exa.secretRef) ?? INFORMATION_EXA_SECRET_REF,
              endpoint: optionalString(exa.endpoint),
              searchType: optionalString(exa.searchType) ?? "auto",
              updatedAt: optionalString(exa.updatedAt) ?? updatedAt,
            },
            zai: {
              providerKind: "zai",
              maxResults: positiveIntegerFromUnknown(zai.maxResults) ?? DEFAULT_ZAI_MAX_RESULTS,
              secretRef: optionalString(zai.secretRef) ?? INFORMATION_ZAI_SECRET_REF,
              endpoint: optionalString(zai.endpoint),
              searchEngine: optionalString(zai.searchEngine) ?? "search-prime",
              updatedAt: optionalString(zai.updatedAt) ?? updatedAt,
            },
            metaso: {
              providerKind: "metaso",
              maxResults: positiveIntegerFromUnknown(metaso.maxResults) ?? DEFAULT_METASO_MAX_RESULTS,
              secretRef: optionalString(metaso.secretRef) ?? INFORMATION_METASO_SECRET_REF,
              endpoint: optionalString(metaso.endpoint),
              updatedAt: optionalString(metaso.updatedAt) ?? updatedAt,
            },
            google: {
              providerKind: "google",
              maxResults: positiveIntegerFromUnknown(google.maxResults) ?? DEFAULT_GOOGLE_MAX_RESULTS,
              secretRef: optionalString(google.secretRef) ?? INFORMATION_GOOGLE_SECRET_REF,
              endpoint: optionalString(google.endpoint),
              engineId: optionalString(google.engineId),
              updatedAt: optionalString(google.updatedAt) ?? updatedAt,
            },
            bing: {
              providerKind: "bing",
              maxResults: positiveIntegerFromUnknown(bing.maxResults) ?? DEFAULT_BING_MAX_RESULTS,
              secretRef: optionalString(bing.secretRef) ?? INFORMATION_BING_SECRET_REF,
              endpoint: optionalString(bing.endpoint),
              market: optionalString(bing.market) ?? "en-US",
              updatedAt: optionalString(bing.updatedAt) ?? updatedAt,
            },
          },
    updatedAt,
  });
}

export function createDefaultLocalSettings(now: string = new Date().toISOString()): LocalSettings {
  const defaultProfile = createDefaultModelProviderProfile(now);
  return {
    version: 1,
    activeModelProfileId: defaultProfile.profileId,
    modelProfiles: [defaultProfile],
    modelProviderOrder: [],
    modelCatalogs: [],
    modelCapabilityOverrides: [],
    toolStates: [],
    toolConfirmation: normalizeToolConfirmationSettings(undefined, now),
    ordinaryAgent: createDefaultOrdinaryAgentPromptSettings(now),
    skillTrigger: normalizeSkillTriggerSettings(undefined, now),
    commandShell: normalizeCommandShellSettings(undefined, now),
    mcpServers: [],
    informationAccess: createDefaultInformationAccessSettings(now),
    updatedAt: now,
  };
}

export function shouldRewriteLocalSettingsFile(
  raw: unknown,
  normalized: LocalSettings
): boolean {
  try {
    return JSON.stringify(raw) !== JSON.stringify(normalized);
  } catch {
    return true;
  }
}

export function normalizeLocalSettings(settings: LocalSettings): LocalSettings {
  const now = settings.updatedAt;
  if (settings.modelProfiles.length === 0) {
    throw new ConfigSchemaValidationError("settings.modelProfiles must contain at least one profile.");
  }
  const profileFallback = createDefaultModelProviderProfile(now);
  const parsedProfiles = dedupeProfiles(settings.modelProfiles
    .map((profile) => normalizeModelProfile(profile, profileFallback)));
  if (parsedProfiles.length !== settings.modelProfiles.length) {
    throw new ConfigSchemaValidationError("settings.modelProfiles contains duplicate profileId values.");
  }
  const profiles = normalizeBuiltInModelProviderProfiles(parsedProfiles, now);
  const modelCatalogs = normalizeModelCatalogs(settings.modelCatalogs ?? [], profiles, now);
  const activeModelProfileId = normalizeProfileId(settings.activeModelProfileId);
  if (!profiles.some((profile) => profile.profileId === activeModelProfileId)) {
    throw new ConfigSchemaValidationError("settings.activeModelProfileId must refer to a configured profile.");
  }
  return {
    ...settings,
    version: 1,
    activeModelProfileId,
    modelProfiles: profiles,
    modelProviderOrder: normalizeModelProviderOrder(settings.modelProviderOrder ?? [], profiles),
    modelCatalogs,
    modelCapabilityOverrides: normalizeModelCapabilityOverrides(settings.modelCapabilityOverrides ?? [], now),
    toolStates: normalizeToolStates(settings.toolStates ?? [], now),
    toolConfirmation: normalizeToolConfirmationSettings(settings.toolConfirmation, now),
    ordinaryAgent: normalizeOrdinaryAgentPromptSettings(settings.ordinaryAgent, now),
    skillTrigger: normalizeSkillTriggerSettings(settings.skillTrigger, now),
    commandShell: normalizeCommandShellSettings(settings.commandShell, now),
    mcpServers: normalizeMcpServers(settings.mcpServers ?? [], now),
    informationAccess: normalizeInformationAccessSettings(settings.informationAccess, now),
  };
}

export function requireActiveModelProfile(settings: LocalSettings): ModelProviderProfileSettings {
  const profile = settings.modelProfiles.find((candidate) => candidate.profileId === settings.activeModelProfileId);
  if (profile === undefined) {
    throw new ConfigSchemaValidationError("settings.activeModelProfileId must refer to a configured profile.");
  }
  return profile;
}

function parseModelProviderOrder(
  raw: unknown,
  profiles: readonly ModelProviderProfileSettings[]
): readonly string[] {
  return Array.isArray(raw) ? normalizeModelProviderOrder(raw, profiles) : [];
}

function normalizeModelProviderOrder(
  order: readonly unknown[],
  profiles: readonly ModelProviderProfileSettings[]
): readonly string[] {
  const profileIds = new Set(profiles.map((profile) => profile.profileId));
  const knownKeys = new Set<string>([
    ...profiles.map((profile) => `profile:${profile.profileId}`),
    ...listBuiltinModelProviderPresets().map((preset) => `preset:${preset.presetId}`),
  ]);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of order) {
    const rawKey = optionalString(value);
    const key = rawKey === undefined ? undefined : normalizeProviderOrderKey(rawKey, profileIds);
    if (key === undefined || !knownKeys.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

function normalizeProviderOrderKey(key: string, profileIds: ReadonlySet<string>): string {
  if (!key.startsWith("preset:")) {
    return key;
  }
  const presetId = key.slice("preset:".length);
  return profileIds.has(presetId) ? `profile:${presetId}` : key;
}

export function createDefaultInformationAccessSettings(now: string): InformationAccessSettings {
  return {
    webSearch: {
      provider: "tavily",
      updatedAt: now,
    },
    tavily: {
      providerKind: "tavily",
      maxResults: DEFAULT_TAVILY_MAX_RESULTS,
      secretRef: INFORMATION_TAVILY_SECRET_REF,
      searchDepth: "basic",
      updatedAt: now,
    },
    exa: {
      providerKind: "exa",
      maxResults: DEFAULT_EXA_MAX_RESULTS,
      secretRef: INFORMATION_EXA_SECRET_REF,
      searchType: "auto",
      updatedAt: now,
    },
    zai: {
      providerKind: "zai",
      maxResults: DEFAULT_ZAI_MAX_RESULTS,
      secretRef: INFORMATION_ZAI_SECRET_REF,
      searchEngine: "search-prime",
      updatedAt: now,
    },
    metaso: {
      providerKind: "metaso",
      maxResults: DEFAULT_METASO_MAX_RESULTS,
      secretRef: INFORMATION_METASO_SECRET_REF,
      updatedAt: now,
    },
    google: {
      providerKind: "google",
      maxResults: DEFAULT_GOOGLE_MAX_RESULTS,
      secretRef: INFORMATION_GOOGLE_SECRET_REF,
      updatedAt: now,
    },
    bing: {
      providerKind: "bing",
      maxResults: DEFAULT_BING_MAX_RESULTS,
      secretRef: INFORMATION_BING_SECRET_REF,
      market: "en-US",
      updatedAt: now,
    },
  };
}

export function normalizeInformationAccessSettings(
  settings: InformationAccessSettings | undefined,
  now: string
): InformationAccessSettings {
  if (settings === undefined) {
    return createDefaultInformationAccessSettings(now);
  }
  return {
    webSearch: {
      provider: normalizeWebSearchProvider(settings.webSearch?.provider) ?? "tavily",
      updatedAt: normalizeOptionalString(settings.webSearch?.updatedAt) ?? settings.tavily?.updatedAt ?? now,
    },
    tavily: {
      providerKind: "tavily",
      maxResults: normalizePositiveInteger(settings.tavily?.maxResults) ?? DEFAULT_TAVILY_MAX_RESULTS,
      secretRef: normalizeOptionalString(settings.tavily?.secretRef) ?? INFORMATION_TAVILY_SECRET_REF,
      endpoint: normalizeOptionalString(settings.tavily?.endpoint),
      searchDepth: normalizeOptionalString(settings.tavily?.searchDepth) ?? "basic",
      updatedAt: normalizeOptionalString(settings.tavily?.updatedAt) ?? now,
    },
    exa: normalizeWebSearchProviderSettings(settings.exa, {
      providerKind: "exa",
      maxResults: DEFAULT_EXA_MAX_RESULTS,
      secretRef: INFORMATION_EXA_SECRET_REF,
      searchType: "auto",
      updatedAt: now,
    }),
    zai: normalizeWebSearchProviderSettings(settings.zai, {
      providerKind: "zai",
      maxResults: DEFAULT_ZAI_MAX_RESULTS,
      secretRef: INFORMATION_ZAI_SECRET_REF,
      searchEngine: "search-prime",
      updatedAt: now,
    }),
    metaso: normalizeWebSearchProviderSettings(settings.metaso, {
      providerKind: "metaso",
      maxResults: DEFAULT_METASO_MAX_RESULTS,
      secretRef: INFORMATION_METASO_SECRET_REF,
      updatedAt: now,
    }),
    google: normalizeWebSearchProviderSettings(settings.google, {
      providerKind: "google",
      maxResults: DEFAULT_GOOGLE_MAX_RESULTS,
      secretRef: INFORMATION_GOOGLE_SECRET_REF,
      updatedAt: now,
    }),
    bing: normalizeWebSearchProviderSettings(settings.bing, {
      providerKind: "bing",
      maxResults: DEFAULT_BING_MAX_RESULTS,
      secretRef: INFORMATION_BING_SECRET_REF,
      market: "en-US",
      updatedAt: now,
    }),
  };
}

export function normalizeOptionalString(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeWebSearchProvider(value: ConfiguredWebSearchProvider | undefined): ConfiguredWebSearchProvider | undefined {
  return isWebSearchProvider(value) ? value : undefined;
}

export function isWebSearchProvider(value: unknown): value is ConfiguredWebSearchProvider {
  return value === "tavily" ||
    value === "exa" ||
    value === "zai" ||
    value === "metaso" ||
    value === "google" ||
    value === "bing" ||
    value === "model_builtin" ||
    value === "none";
}

export function isWebSearchProviderKind(value: unknown): value is ConfiguredWebSearchProviderKind {
  return value === "tavily" ||
    value === "exa" ||
    value === "zai" ||
    value === "metaso" ||
    value === "google" ||
    value === "bing";
}

export function webSearchProviderSettings(
  informationAccess: InformationAccessSettings,
  provider: ConfiguredWebSearchProvider
): WebSearchProviderSettings | undefined {
  if (provider === "none" || provider === "model_builtin") {
    return undefined;
  }
  return informationAccess[provider];
}

function parseWebSearchProvider(
  value: unknown
): NonNullable<LocalSettings["informationAccess"]>["webSearch"]["provider"] {
  return isWebSearchProvider(value) ? value : "tavily";
}

function positiveIntegerFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : undefined;
}

function normalizeWebSearchProviderSettings<T extends ConfiguredWebSearchProviderKind>(
  settings: (WebSearchProviderSettings & { readonly providerKind: T }) | undefined,
  fallback: WebSearchProviderSettings & { readonly providerKind: T }
): WebSearchProviderSettings & { readonly providerKind: T } {
  return {
    providerKind: fallback.providerKind,
    maxResults: normalizePositiveInteger(settings?.maxResults) ?? fallback.maxResults,
    secretRef: normalizeOptionalString(settings?.secretRef) ?? fallback.secretRef,
    endpoint: normalizeOptionalString(settings?.endpoint) ?? fallback.endpoint,
    searchDepth: normalizeOptionalString(settings?.searchDepth) ?? fallback.searchDepth,
    searchType: normalizeOptionalString(settings?.searchType) ?? fallback.searchType,
    searchEngine: normalizeOptionalString(settings?.searchEngine) ?? fallback.searchEngine,
    engineId: normalizeOptionalString(settings?.engineId) ?? fallback.engineId,
    market: normalizeOptionalString(settings?.market) ?? fallback.market,
    updatedAt: normalizeOptionalString(settings?.updatedAt) ?? fallback.updatedAt,
  };
}
