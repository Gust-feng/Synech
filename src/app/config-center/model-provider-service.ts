import type {
  ConfiguredModelProviderKind,
  CreateModelProviderProfileInput,
  LocalDevSecretStore,
  LocalSettings,
  ModelCapabilities,
  ModelCapabilityOverrideSettings,
  ModelProviderModelCatalog,
  ModelProviderProfileSettings,
  SanitizedModelProviderConfig,
  UpdateModelProviderConfigInput,
} from "../../domain/config/index.js";
import { listBuiltinModelProviderPresets } from "../../domain/config/index.js";
import { ConfigCenterValidationError } from "./config-center-error.js";
import { builtinPresetForProfileId } from "./model-provider-profile-settings.js";
import {
  DEFAULT_MODEL_PROVIDER_BASE_URL,
  normalizeLocalSettings,
  normalizeModelProfile,
  normalizeModelProviderKind,
  normalizeOptionalString,
  normalizeProfileId,
  normalizeRequiredConfigString,
  requireActiveModelProfile,
  sanitizeCapabilityOverride,
} from "./settings-schema.js";
import {
  toSanitizedModelProfile,
  toSanitizedModelProviderConfig,
} from "./projections.js";

type SettingsChange<T> = {
  readonly settings: LocalSettings;
  readonly result: T;
};

export async function getModelProviderConfig(
  settings: LocalSettings,
  secretStore: LocalDevSecretStore,
): Promise<SanitizedModelProviderConfig> {
  return toSanitizedModelProviderConfig({ settings, secretStore });
}

export async function getModelProviderApiKey(
  settings: LocalSettings,
  secretStore: LocalDevSecretStore,
  profileId?: string,
): Promise<string | undefined> {
  const profile = profileId === undefined
    ? requireActiveModelProfile(settings)
    : settings.modelProfiles.find((candidate) => candidate.profileId === normalizeProfileId(profileId));
  return profile === undefined ? undefined : secretStore.readSecret(profile.secretRef);
}

export async function listModelProviderProfiles(
  settings: LocalSettings,
  secretStore: LocalDevSecretStore,
): Promise<readonly SanitizedModelProviderConfig[]> {
  return Promise.all(settings.modelProfiles.map((profile) =>
    toSanitizedModelProfile({ profile, secretStore })
  ));
}

export function changeModelProviderOrder(
  current: LocalSettings,
  order: readonly string[],
  now: string,
): SettingsChange<readonly string[]> {
  const settings = normalizeLocalSettings({
    ...current,
    version: 1,
    modelProviderOrder: order,
    updatedAt: now,
  });
  return { settings, result: settings.modelProviderOrder ?? [] };
}

export function upsertModelProviderModelCatalog(
  current: LocalSettings,
  catalog: ModelProviderModelCatalog,
  now: string,
): SettingsChange<ModelProviderModelCatalog> {
  const profileId = normalizeProfileId(catalog.profileId);
  if (!current.modelProfiles.some((profile) => profile.profileId === profileId)) {
    throw new ConfigCenterValidationError(`Model profile not found: ${profileId}`);
  }
  const normalized = normalizeLocalSettings({
    ...current,
    version: 1,
    modelCatalogs: [
      ...(current.modelCatalogs ?? []).filter((item) => item.profileId !== profileId),
      { ...catalog, profileId },
    ],
    updatedAt: now,
  });
  const saved = normalized.modelCatalogs?.find((item) => item.profileId === profileId);
  if (saved === undefined) {
    throw new ConfigCenterValidationError(`Model catalog could not be saved: ${profileId}`);
  }
  const withoutEmptyCatalog = saved.models.length === 0
    ? normalizeLocalSettings({
        ...normalized,
        modelCatalogs: (normalized.modelCatalogs ?? []).filter((item) => item.profileId !== profileId),
        updatedAt: now,
      })
    : normalized;
  const settings = normalizeLocalSettings(clearProfileModelOutsideCatalog(withoutEmptyCatalog, saved, now));
  const result = settings.modelCatalogs?.find((item) => item.profileId === profileId);
  if (result === undefined && saved.models.length !== 0) {
    throw new ConfigCenterValidationError(`Model catalog could not be saved: ${profileId}`);
  }
  return { settings, result: result ?? saved };
}

export async function createModelProviderProfile(
  current: LocalSettings,
  secretStore: LocalDevSecretStore,
  input: CreateModelProviderProfileInput,
  now: string,
): Promise<SettingsChange<SanitizedModelProviderConfig>> {
  const profileId = normalizeProfileId(input.profileId);
  if (current.modelProfiles.some((profile) => profile.profileId === profileId)) {
    throw new ConfigCenterValidationError(`Model profile already exists: ${profileId}`);
  }
  const label = normalizeOptionalString(input.label) ?? profileId;
  const profile = normalizeModelProfile({
    ...input,
    profileId,
    label,
    updatedAt: now,
  }, createModelProviderProfileFallback(profileId, label, requireActiveModelProfile(current), now));
  const settings = normalizeLocalSettings({
    ...current,
    version: 1,
    modelProfiles: [...current.modelProfiles, profile],
    updatedAt: now,
  });
  const apiKey = normalizeOptionalString(input.apiKey);
  if (apiKey !== undefined) {
    await secretStore.writeSecret(profile.secretRef, apiKey);
  }
  const saved = settings.modelProfiles.find((candidate) => candidate.profileId === profileId) ?? profile;
  return {
    settings,
    result: await toSanitizedModelProfile({ profile: saved, secretStore }),
  };
}

export async function activateModelProviderProfile(
  current: LocalSettings,
  secretStore: LocalDevSecretStore,
  profileId: string,
  now: string,
): Promise<SettingsChange<SanitizedModelProviderConfig>> {
  const normalized = normalizeProfileId(profileId);
  const profile = current.modelProfiles.find((candidate) => candidate.profileId === normalized);
  if (profile === undefined) {
    throw new ConfigCenterValidationError(`Model profile not found: ${normalized}`);
  }
  if (!profile.enabled) {
    throw new ConfigCenterValidationError(`Model profile is disabled: ${normalized}`);
  }
  const settings = normalizeLocalSettings({
    ...current,
    version: 1,
    activeModelProfileId: profile.profileId,
    updatedAt: now,
  });
  return {
    settings,
    result: await toSanitizedModelProfile({ profile: requireActiveModelProfile(settings), secretStore }),
  };
}

export async function deleteModelProviderProfile(
  current: LocalSettings,
  secretStore: LocalDevSecretStore,
  profileId: string,
  now: string,
): Promise<SettingsChange<readonly SanitizedModelProviderConfig[]>> {
  const normalized = normalizeProfileId(profileId);
  if (current.activeModelProfileId === normalized) {
    throw new ConfigCenterValidationError("Cannot delete the active model profile.");
  }
  const deletedProfile = current.modelProfiles.find((profile) => profile.profileId === normalized);
  if (deletedProfile === undefined) {
    throw new ConfigCenterValidationError(`Model profile not found: ${normalized}`);
  }
  const settings = normalizeLocalSettings({
    ...current,
    version: 1,
    modelProfiles: current.modelProfiles.filter((profile) => profile.profileId !== normalized),
    modelCatalogs: (current.modelCatalogs ?? []).filter((catalog) => catalog.profileId !== normalized),
    updatedAt: now,
  });
  await secretStore.deleteSecret(deletedProfile.secretRef);
  return {
    settings,
    result: await listModelProviderProfiles(settings, secretStore),
  };
}

export async function updateModelProviderConfig(
  current: LocalSettings,
  secretStore: LocalDevSecretStore,
  input: UpdateModelProviderConfigInput,
  now: string,
): Promise<SettingsChange<SanitizedModelProviderConfig>> {
  const profileId = input.profileId === undefined
    ? current.activeModelProfileId
    : normalizeProfileId(input.profileId);
  const existing = current.modelProfiles.find((profile) => profile.profileId === profileId);
  if (existing === undefined) {
    throw new ConfigCenterValidationError(`Model profile not found: ${profileId}`);
  }
  const protectedBuiltInProfile = builtinPresetForProtectedProfile({ profileId });
  const effectiveInput = protectedBuiltInProfile === undefined
    ? input
    : { ...input, label: undefined, logoDataUrl: undefined, clearLogoDataUrl: undefined };
  const normalizedProfile = normalizeModelProfile({
    ...existing,
    ...effectiveInput,
    profileId,
    updatedAt: now,
  }, existing);
  const updatedProfile = {
    ...normalizedProfile,
    ...(protectedBuiltInProfile === undefined
      ? {}
      : { label: protectedBuiltInProfile.label, logoDataUrl: undefined }),
    ...(effectiveInput.clearModel === true ? { model: undefined } : {}),
    ...(effectiveInput.clearLogoDataUrl === true ? { logoDataUrl: undefined } : {}),
  };
  const settings = normalizeLocalSettings({
    ...current,
    version: 1,
    modelProfiles: current.modelProfiles.map((profile) =>
      profile.profileId === updatedProfile.profileId ? updatedProfile : profile
    ),
    updatedAt: now,
  });
  const apiKey = normalizeOptionalString(input.apiKey);
  if (input.clearApiKey === true) {
    await Promise.all([...new Set([existing.secretRef, updatedProfile.secretRef])]
      .map((secretRef) => secretStore.deleteSecret(secretRef)));
  } else if (apiKey !== undefined) {
    await secretStore.writeSecret(updatedProfile.secretRef, apiKey);
  }
  const saved = settings.modelProfiles.find((profile) => profile.profileId === updatedProfile.profileId) ?? updatedProfile;
  return {
    settings,
    result: await toSanitizedModelProfile({ profile: saved, secretStore }),
  };
}

export function updateModelCapabilityOverride(
  current: LocalSettings,
  input: {
    readonly profileId?: string;
    readonly model: string;
    readonly providerKind?: ConfiguredModelProviderKind;
    readonly capabilities: Partial<ModelCapabilities>;
  },
  now: string,
): SettingsChange<readonly ModelCapabilityOverrideSettings[]> {
  const profileId = input.profileId === undefined ? undefined : normalizeProfileId(input.profileId);
  const nextOverride: ModelCapabilityOverrideSettings = {
    ...(profileId === undefined ? {} : { profileId }),
    providerKind: normalizeModelProviderKind(input.providerKind),
    model: normalizeRequiredConfigString(input.model, "model"),
    capabilities: sanitizeCapabilityOverride(input.capabilities),
    updatedAt: now,
  };
  const existing = current.modelCapabilityOverrides ?? [];
  const settings = normalizeLocalSettings({
    ...current,
    version: 1,
    modelCapabilityOverrides: [
      ...existing.filter((item) => !sameCapabilityOverrideScope(item, nextOverride)),
      nextOverride,
    ],
    updatedAt: now,
  });
  return { settings, result: settings.modelCapabilityOverrides ?? [] };
}

function createModelProviderProfileFallback(
  profileId: string,
  label: string,
  current: ModelProviderProfileSettings,
  now: string,
): ModelProviderProfileSettings {
  return {
    profileId,
    label,
    providerKind: "openai_compatible",
    protocolKind: "openai_compatible_chat_completions",
    baseUrl: DEFAULT_MODEL_PROVIDER_BASE_URL,
    defaultAiMode: current.defaultAiMode === "none" ? "none" : "openai-compatible",
    secretRef: `secret://local-dev/model-provider/${profileId}/api-key`,
    enabled: true,
    updatedAt: now,
  };
}

function builtinPresetForProtectedProfile(
  profile: Pick<ModelProviderProfileSettings, "profileId">,
): ReturnType<typeof listBuiltinModelProviderPresets>[number] | undefined {
  return builtinPresetForProfileId(profile.profileId);
}

function clearProfileModelOutsideCatalog(
  settings: LocalSettings,
  catalog: ModelProviderModelCatalog,
  now: string,
): LocalSettings {
  const savedModelIds = new Set(catalog.models.map((model) => model.id));
  const modelProfiles = settings.modelProfiles.map((profile) =>
    profile.profileId === catalog.profileId && profile.model !== undefined && !savedModelIds.has(profile.model)
      ? { ...profile, model: undefined, updatedAt: now }
      : profile
  );
  return { ...settings, modelProfiles, updatedAt: now };
}

function sameCapabilityOverrideScope(
  left: ModelCapabilityOverrideSettings,
  right: ModelCapabilityOverrideSettings,
): boolean {
  return left.profileId === right.profileId &&
    left.providerKind === right.providerKind &&
    left.model === right.model;
}
