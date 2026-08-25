import type { ConfigResponse } from "@panel-api/config";
import { sameStringList } from "./settings-list-equality";
import {
  modelFormFromProviderItem,
  modelProviderFormId,
  type ModelForm,
  type ModelProviderListItem,
  type ModelProviderProfileItem,
} from "./settings-projection";

export type ModelProviderProjectionDraft = {
  readonly createdProfiles: readonly ModelProviderProfileItem[];
  readonly editedProfiles: readonly ModelProviderProfileItem[];
  readonly removedProfileIds: readonly string[];
  readonly activeProfile?: ModelProviderProfileItem;
  readonly order?: readonly string[];
};

export function nextCustomProfileId(
  items: readonly ModelProviderListItem[],
  createdProfiles: readonly ModelProviderProfileItem[],
): string {
  const existingIds = new Set([
    ...items.map((item) => item.profileId).filter((id): id is string => id !== undefined),
    ...createdProfiles.map((profile) => profile.profileId).filter((id): id is string => id !== undefined),
  ]);
  let profileId = "";
  do {
    profileId = `custom_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
  } while (existingIds.has(profileId));
  return profileId;
}

export function applyModelProviderProjectionDraft(
  config: ConfigResponse | undefined,
  draft: ModelProviderProjectionDraft,
): ConfigResponse | undefined {
  if (
    config === undefined ||
    (draft.createdProfiles.length === 0 &&
      draft.editedProfiles.length === 0 &&
      draft.removedProfileIds.length === 0 &&
      draft.activeProfile === undefined &&
      draft.order === undefined)
  ) {
    return config;
  }
  const removedProfileIds = new Set(draft.removedProfileIds);
  const profiles = new Map<string, ModelProviderProfileItem>();
  for (const profile of config.profiles ?? []) {
    if (profile.profileId !== undefined && !removedProfileIds.has(profile.profileId)) {
      profiles.set(profile.profileId, profile);
    }
  }
  for (const profile of draft.createdProfiles) {
    if (profile.profileId !== undefined && !removedProfileIds.has(profile.profileId)) {
      profiles.set(profile.profileId, profile);
    }
  }
  for (const profile of draft.editedProfiles) {
    if (profile.profileId !== undefined && !removedProfileIds.has(profile.profileId)) {
      profiles.set(profile.profileId, profile);
    }
  }
  const nextProfiles = [...profiles.values()];
  const currentProfileId = config.config?.profileId;
  const currentConfigRemoved = currentProfileId !== undefined && removedProfileIds.has(currentProfileId);
  const activeProfile =
    draft.activeProfile ??
    (currentConfigRemoved
      ? nextProfiles[0]
      : currentProfileId === undefined
        ? config.config
        : profiles.get(currentProfileId) ?? config.config) ??
    nextProfiles[0];
  return {
    ...config,
    config: activeProfile,
    profile: activeProfile,
    profiles: nextProfiles,
    modelProviderOrder: draft.order ?? config.modelProviderOrder,
    modelCatalogs: config.modelCatalogs?.filter((catalog) => !removedProfileIds.has(catalog.profileId)),
  };
}

export function reconcileModelProviderProjectionDraft(
  draft: ModelProviderProjectionDraft,
  config: ConfigResponse | undefined,
): ModelProviderProjectionDraft {
  if (config === undefined) return draft;
  const serverProfileIds = new Set((config.profiles ?? []).map((profile) => profile.profileId).filter(isDefinedString));
  const serverProfilesById = new Map((config.profiles ?? [])
    .filter((profile): profile is ModelProviderProfileItem & { readonly profileId: string } => profile.profileId !== undefined)
    .map((profile) => [profile.profileId, profile]));
  const nextCreatedProfiles = draft.createdProfiles.filter((profile) => profile.profileId === undefined || !serverProfileIds.has(profile.profileId));
  const nextEditedProfiles = draft.editedProfiles.filter((profile) => {
    if (profile.profileId === undefined) return false;
    const serverProfile = serverProfilesById.get(profile.profileId);
    return serverProfile === undefined || !sameProjectedProfile(serverProfile, profile);
  });
  const nextRemovedProfileIds = draft.removedProfileIds.filter((profileId) => serverProfileIds.has(profileId));
  const nextActiveProfile = draft.activeProfile?.profileId === config.config?.profileId ? undefined : draft.activeProfile;
  const nextOrder = sameStringList(draft.order, config.modelProviderOrder) ? undefined : draft.order;
  if (
    sameProfileList(nextCreatedProfiles, draft.createdProfiles) &&
    sameProfileList(nextEditedProfiles, draft.editedProfiles) &&
    sameStringList(nextRemovedProfileIds, draft.removedProfileIds) &&
    nextActiveProfile === draft.activeProfile &&
    nextOrder === draft.order
  ) {
    return draft;
  }
  return {
    createdProfiles: nextCreatedProfiles,
    editedProfiles: nextEditedProfiles,
    removedProfileIds: nextRemovedProfileIds,
    activeProfile: nextActiveProfile,
    order: nextOrder,
  };
}

export function profileFromModelForm(
  form: ModelForm,
  defaultAiMode: ModelProviderProfileItem["defaultAiMode"] | undefined,
): ModelProviderProfileItem {
  return {
    profileId: form.profileId,
    label: form.label.trim() || form.profileId,
    logoDataUrl: logoDataUrlFromModelForm(form),
    providerKind: "openai_compatible",
    protocolKind: form.protocolKind || "openai_compatible_chat_completions",
    baseUrl: form.baseUrl,
    model: form.model,
    defaultAiMode,
    secretConfigured: form.apiKey.length > 0 ? true : undefined,
  };
}

export function profileDraftFromModelForm(
  form: ModelForm,
  item: ModelProviderListItem,
  selectedSecretConfigured: boolean,
): ModelProviderProfileItem {
  const fallback = item.profile;
  const profileId = item.profileId || modelProviderFormId(item);
  return {
    profileId,
    label: form.label.trim() || fallback?.label || item.title || profileId,
    logoDataUrl: item.protectedBuiltin ? item.logoDataUrl : logoDataUrlFromModelForm(form),
    providerKind: fallback?.providerKind ?? item.preset?.providerKind ?? "openai_compatible",
    protocolKind: form.protocolKind || fallback?.protocolKind || item.protocolKind,
    baseUrl: form.baseUrl || fallback?.baseUrl || item.baseUrl,
    model: form.model,
    defaultAiMode: fallback?.defaultAiMode,
    secretConfigured: form.apiKeyCleared
      ? false
      : form.apiKey.length > 0
        ? true
        : fallback?.secretConfigured ?? selectedSecretConfigured,
  };
}

export function modelFormForProviderItem(form: ModelForm, item: ModelProviderListItem): ModelForm {
  return form.profileId === modelProviderFormId(item) ? form : modelFormFromProviderItem(item);
}

export function upsertProfileDraft(
  profiles: readonly ModelProviderProfileItem[],
  nextProfile: ModelProviderProfileItem,
): readonly ModelProviderProfileItem[] {
  return [
    ...profiles.filter((profile) => profile.profileId !== nextProfile.profileId),
    nextProfile,
  ];
}

export function removeCreatedProfileDraft(
  draft: ModelProviderProjectionDraft,
  profileId: string,
): ModelProviderProjectionDraft {
  const profileKey = `profile:${profileId}`;
  const order = draft.order?.filter((key) => key !== profileKey);
  return {
    ...draft,
    createdProfiles: draft.createdProfiles.filter((profile) => profile.profileId !== profileId),
    editedProfiles: draft.editedProfiles.filter((profile) => profile.profileId !== profileId),
    activeProfile: draft.activeProfile?.profileId === profileId ? undefined : draft.activeProfile,
    order: order === undefined || order.length === 0 ? undefined : order,
  };
}

export function addProviderKey(
  currentKeys: readonly string[],
  previousKey: string | undefined,
  nextKey: string,
): readonly string[] {
  const withoutAddedKey = currentKeys.filter((key) => key !== nextKey && key !== previousKey);
  return [...withoutAddedKey, nextKey];
}

function logoDataUrlFromModelForm(form: ModelForm): string | undefined {
  if (form.logoCleared) return undefined;
  return form.logoDataUrl.trim().length > 0 ? form.logoDataUrl : undefined;
}

function sameProfileList(
  left: readonly ModelProviderProfileItem[],
  right: readonly ModelProviderProfileItem[],
): boolean {
  return left.length === right.length && left.every((profile, index) => profile === right[index]);
}

function sameProjectedProfile(left: ModelProviderProfileItem, right: ModelProviderProfileItem): boolean {
  return left.profileId === right.profileId &&
    left.label === right.label &&
    left.logoDataUrl === right.logoDataUrl &&
    left.providerKind === right.providerKind &&
    left.protocolKind === right.protocolKind &&
    left.baseUrl === right.baseUrl &&
    left.model === right.model &&
    left.defaultAiMode === right.defaultAiMode;
}

function isDefinedString(value: string | undefined): value is string {
  return value !== undefined;
}
