import type {
  LocalSettings,
  ConfiguredModelProtocolKind,
  ConfiguredModelRuntimeMode,
  ModelProviderProfileSettings,
} from "../../domain/config/index.js";
import { listBuiltinModelProviderPresets } from "../../domain/config/index.js";
import {
  normalizeOpenAIModelRequestSettings,
  parseOpenAIModelRequestSettings,
} from "./openai-request-settings.js";
import { ConfigSchemaValidationError, optionalString, safeConfigId } from "./settings-utils.js";
import {
  DEFAULT_MODEL_PROFILE_ID,
  DEFAULT_MODEL_PROVIDER_BASE_URL,
  MODEL_PROVIDER_SECRET_REF,
  normalizeBaseUrl,
  normalizeModelProviderKind,
  normalizeModelProtocolKind,
  normalizeOptionalString,
  normalizeProfileId,
} from "./model-provider-common.js";

const MODEL_PROVIDER_LOGO_FILE_MAX_BYTES = 3 * 1024 * 1024;
const MODEL_PROVIDER_LOGO_DATA_URL_MAX_LENGTH =
  "data:image/svg+xml;base64,".length + Math.ceil(MODEL_PROVIDER_LOGO_FILE_MAX_BYTES / 3) * 4;
const MODEL_PROVIDER_LOGO_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/u;

export function createDefaultModelProviderProfile(now: string): ModelProviderProfileSettings {
  return {
    profileId: DEFAULT_MODEL_PROFILE_ID,
    label: "OpenAI",
    providerKind: "openai_compatible",
    protocolKind: "openai_responses",
    baseUrl: DEFAULT_MODEL_PROVIDER_BASE_URL,
    defaultAiMode: "openai-responses",
    secretRef: MODEL_PROVIDER_SECRET_REF,
    enabled: true,
    updatedAt: now,
  };
}

export function parseModelProfile(
  record: Record<string, unknown>,
  fallbacks: {
    readonly fallbackProfileId?: string;
    readonly fallbackLabel?: string;
    readonly fallbackSecretRef: string;
    readonly fallbackUpdatedAt: string;
  }
): LocalSettings["modelProfiles"][number] {
  const profileId = safeConfigId(optionalString(record.profileId) ?? fallbacks.fallbackProfileId ?? "");
  const providerKind = parseModelProviderKind(record.providerKind);
  const baseUrl = optionalString(record.baseUrl);
  const protocolKind = parseModelProtocolKind(record.protocolKind, {
    profileId,
    baseUrl,
  });
  return {
    profileId,
    label: optionalString(record.label) ?? fallbacks.fallbackLabel ?? profileId,
    logoDataUrl: normalizeLogoDataUrl(record.logoDataUrl),
    providerKind,
    protocolKind,
    baseUrl,
    model: optionalString(record.model),
    openAI: parseOpenAIModelRequestSettings(record.openAI),
    defaultAiMode: normalizeProfileAiModeForProtocol(protocolKind),
    secretRef: optionalString(record.secretRef) ?? fallbacks.fallbackSecretRef,
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    updatedAt: optionalString(record.updatedAt) ?? fallbacks.fallbackUpdatedAt,
  };
}

export function dedupeProfiles(profiles: readonly ModelProviderProfileSettings[]): readonly ModelProviderProfileSettings[] {
  const map = new Map<string, ModelProviderProfileSettings>();
  for (const profile of profiles) {
    map.set(profile.profileId, profile);
  }
  return [...map.values()];
}

export function normalizeModelProfile(
  input: Partial<ModelProviderProfileSettings> & { readonly profileId?: string },
  fallback: ModelProviderProfileSettings
): ModelProviderProfileSettings {
  const providerKind = normalizeModelProviderKind(input.providerKind) ?? fallback.providerKind;
  const protocolKind = input.protocolKind === undefined
    ? fallback.protocolKind
    : normalizeModelProtocolKind(input.protocolKind) ?? fallback.protocolKind;
  const normalizedProtocolKind = normalizeProfileProtocol(protocolKind);
  const openAI =
    input.openAI === undefined ? fallback.openAI : normalizeOpenAIModelRequestSettings(input.openAI);
  return {
    profileId: normalizeProfileId(input.profileId ?? fallback.profileId),
    label: normalizeOptionalString(input.label) ?? fallback.label,
    logoDataUrl: input.logoDataUrl === undefined
      ? fallback.logoDataUrl
      : normalizeLogoDataUrl(input.logoDataUrl) ?? fallback.logoDataUrl,
    providerKind,
    protocolKind: normalizedProtocolKind,
    baseUrl: normalizeBaseUrl(input.baseUrl) ?? fallback.baseUrl,
    model: normalizeOptionalString(input.model) ?? fallback.model,
    openAI,
    defaultAiMode: normalizeProfileAiModeForProtocol(normalizedProtocolKind),
    secretRef: normalizeOptionalString(input.secretRef) ?? secretRefForProfile(input.profileId ?? fallback.profileId),
    enabled: input.enabled ?? fallback.enabled,
    updatedAt: normalizeOptionalString(input.updatedAt) ?? fallback.updatedAt,
  };
}

export function normalizeBuiltInModelProviderProfiles(
  profiles: readonly ModelProviderProfileSettings[],
  now: string
): readonly ModelProviderProfileSettings[] {
  return profiles.map((profile) => {
    const preset = builtInPresetForProfile(profile);
    if (preset === undefined) {
      return profile;
    }
    const providerKind = preset.providerKind;
    const protocolKind = normalizeBuiltInProfileProtocol(preset);
    const defaultAiMode = normalizeProfileAiModeForProtocol(protocolKind);
    const baseUrl = normalizeBuiltInProfileBaseUrl(profile, preset);
    // Model validity comes from the profile's /models catalog. Provider
    // identity and Base URL are not model-name inference signals.
    const model = profile.model;
    const clearBuiltInLogo = shouldClearBuiltInProfileLogo(profile, preset.presetId);
    const next: ModelProviderProfileSettings = {
      ...profile,
      logoDataUrl: clearBuiltInLogo ? undefined : profile.logoDataUrl,
      providerKind,
      protocolKind,
      baseUrl,
      model,
      defaultAiMode,
    };
    return sameModelProfile(profile, next) ? profile : { ...next, updatedAt: now };
  });
}

function shouldClearBuiltInProfileLogo(
  profile: ModelProviderProfileSettings,
  presetId: string
): boolean {
  return builtinPresetForProfileId(profile.profileId)?.presetId === presetId;
}

function parseModelProviderKind(value: unknown): ModelProviderProfileSettings["providerKind"] {
  if (value === undefined || value === "openai_compatible") {
    return "openai_compatible";
  }
  throw new ConfigSchemaValidationError(
    "Invalid settings document: model provider kind must be openai_compatible."
  );
}

function parseModelProtocolKind(
  value: unknown,
  input: {
    readonly profileId: string;
    readonly baseUrl?: string;
  }
): ModelProviderProfileSettings["protocolKind"] {
  if (
    value === "openai_responses" ||
    value === "openai_compatible_chat_completions"
  ) {
    return value;
  }
  if (value !== undefined) {
    throw new ConfigSchemaValidationError(
      "Invalid settings document: model protocol must be openai_responses or openai_compatible_chat_completions."
    );
  }
  return defaultProtocolForProfile(input);
}

function normalizeProfileProtocol(
  protocolKind: ConfiguredModelProtocolKind
): ConfiguredModelProtocolKind {
  return protocolKind === "openai_responses"
    ? "openai_responses"
    : "openai_compatible_chat_completions";
}

function normalizeProfileAiModeForProtocol(
  protocolKind: ConfiguredModelProtocolKind
): ConfiguredModelRuntimeMode {
  return protocolKind === "openai_compatible_chat_completions" ? "openai-compatible" : "openai-responses";
}

function builtInPresetForProfile(profile: ModelProviderProfileSettings): ReturnType<typeof listBuiltinModelProviderPresets>[number] | undefined {
  return builtinPresetForProfileId(profile.profileId);
}

/**
 * Resolves the built-in slot from its stable profile identity only.
 * Base URLs are transport configuration and must never turn a custom
 * profile into a protected built-in profile.
 */
export function builtinPresetForProfileId(
  profileId: string
): ReturnType<typeof listBuiltinModelProviderPresets>[number] | undefined {
  if (isGeneratedCustomProfileId(profileId)) return undefined;
  const normalized = profileId.trim().toLowerCase();
  const presetId = normalized === DEFAULT_MODEL_PROFILE_ID ? "openai" : normalized;
  if (!["openai", "deepseek", "moonshot", "glm", "minimax"].includes(presetId)) return undefined;
  return listBuiltinModelProviderPresets().find((preset) => preset.presetId === presetId);
}

function isGeneratedCustomProfileId(profileId: string): boolean {
  return profileId.startsWith("custom_");
}

function defaultProtocolForProfile(input: {
  readonly profileId: string;
  readonly baseUrl?: string;
}): ConfiguredModelProtocolKind {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (input.profileId === DEFAULT_MODEL_PROFILE_ID || input.profileId === "openai") {
    return baseUrl === undefined || isOfficialOpenAIBaseUrl(baseUrl)
      ? "openai_responses"
      : "openai_compatible_chat_completions";
  }
  const preset = builtinPresetForProfileId(input.profileId);
  if (preset !== undefined) return preset.protocolKind;
  return "openai_compatible_chat_completions";
}

function normalizeBuiltInProfileProtocol(
  preset: ReturnType<typeof listBuiltinModelProviderPresets>[number]
): ConfiguredModelProtocolKind {
  // Protocol selection belongs to custom profiles. Built-in profiles expose
  // the protocol declared by their preset, regardless of a custom Base URL.
  return normalizeProfileProtocol(preset.protocolKind);
}

function normalizeBuiltInProfileBaseUrl(
  profile: ModelProviderProfileSettings,
  preset: ReturnType<typeof listBuiltinModelProviderPresets>[number]
): string {
  const canonicalBaseUrl = normalizeBaseUrl(preset.baseUrl) ?? preset.baseUrl;
  const currentBaseUrl = normalizeBaseUrl(profile.baseUrl);
  if (currentBaseUrl === undefined) {
    return canonicalBaseUrl;
  }
  return currentBaseUrl;
}

function isOfficialOpenAIBaseUrl(baseUrl: string): boolean {
  return baseUrl === "https://api.openai.com" || baseUrl === "https://api.openai.com/v1";
}

function sameModelProfile(left: ModelProviderProfileSettings, right: ModelProviderProfileSettings): boolean {
  return left.profileId === right.profileId &&
    left.label === right.label &&
    left.logoDataUrl === right.logoDataUrl &&
    left.providerKind === right.providerKind &&
    left.protocolKind === right.protocolKind &&
    left.baseUrl === right.baseUrl &&
    left.model === right.model &&
    JSON.stringify(left.openAI ?? {}) === JSON.stringify(right.openAI ?? {}) &&
    left.defaultAiMode === right.defaultAiMode &&
    left.secretRef === right.secretRef &&
    left.enabled === right.enabled;
}

function secretRefForProfile(profileId: string): string {
  return "secret://local-dev/model-provider/" + normalizeProfileId(profileId) + "/api-key";
}

export function normalizeLogoDataUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MODEL_PROVIDER_LOGO_DATA_URL_MAX_LENGTH) {
    return undefined;
  }
  return MODEL_PROVIDER_LOGO_DATA_URL_PATTERN.test(normalized) ? normalized : undefined;
}
