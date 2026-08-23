import type {
  ConfigResponse,
  ModelProviderModelCatalog,
  ModelProviderPreset,
} from "../contracts/config.js";
import {
  builtinProviderPresetId,
  modelProviderDisplayName,
  modelProviderSortRank,
  resolveModelProviderIdentity,
} from "../model-provider-logos.js";

export type ModelForm = {
  readonly profileId: string;
  readonly label: string;
  readonly logoDataUrl: string;
  readonly logoCleared: boolean;
  readonly baseUrl: string;
  readonly protocolKind: ModelProtocolKind;
  readonly model: string;
  readonly apiKey: string;
  readonly apiKeyCleared: boolean;
};

export type ModelProviderProfileItem = NonNullable<ConfigResponse["profiles"]>[number];
export type ModelProviderModelItem = ModelProviderModelCatalog["models"][number];
export type ModelProtocolKind = "openai_responses" | "openai_compatible_chat_completions";

export type ModelProviderListItem = {
  readonly key: string;
  readonly title: string;
  readonly vendor?: string;
  readonly logoDataUrl?: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly protocolKind: ModelProtocolKind;
  readonly profileId?: string;
  readonly profile?: ModelProviderProfileItem;
  readonly presetId?: string;
  readonly preset?: ModelProviderPreset;
  readonly configured: boolean;
  readonly protectedBuiltin: boolean;
};

export function filterModelCatalogItems(
  models: readonly ModelProviderModelItem[],
  normalizedQuery: string
): readonly ModelProviderModelItem[] {
  if (normalizedQuery.length === 0) return models;
  return models.filter((model) => [model.displayName, model.id, model.owner ?? ""].some((value) => value.toLowerCase().includes(normalizedQuery)));
}

export function formatModelCount(visible: number, total: number, filtered: boolean): string {
  return filtered ? `${visible}/${total}` : String(total);
}

export function modelProviderItems(
  config: ConfigResponse | undefined
): readonly ModelProviderListItem[] {
  const profiles = (config?.profiles ?? []).filter(isSettingsModelProviderProfile);
  const presets = (config?.modelProviderMarket?.presets ?? []).filter(isSettingsModelProviderPreset);
  const activeProfileId = config?.config?.profileId;
  const order = config?.modelProviderOrder ?? [];
  const profileBindings = profiles.map((profile: ModelProviderProfileItem) => ({
    profile,
    // Only the profile id is a stable relationship to a built-in slot. A custom
    // provider may intentionally use the same endpoint as a preset, but must
    // retain its own label and logo object.
    presetId: builtinProviderPresetId({ profileId: profile.profileId }),
  }));
  const boundProfileIds = new Set<string>();
  const presetItems = presets.map((preset: ModelProviderPreset) => {
    const presetIdentity = resolveModelProviderIdentity(preset);
    const bindings = profileBindings.filter((item) => {
      if (item.profile.profileId === preset.presetId) return true;
      return item.presetId === preset.presetId;
    });
    for (const item of bindings) {
      if (item.profile.profileId !== undefined) {
        boundProfileIds.add(item.profile.profileId);
      }
    }
    const binding =
      bindings.find((item) => item.profile.profileId === activeProfileId) ??
      bindings.find((item) => item.profile.profileId === preset.presetId) ??
      bindings[0];
    if (binding?.profile.profileId !== undefined) {
      boundProfileIds.add(binding.profile.profileId);
    }
    const profile = binding?.profile;
    const configuredModel = profile === undefined ? preset.defaultModel ?? "" : profile.model ?? "";
    return {
      key: profile?.profileId === undefined ? `preset:${preset.presetId}` : `profile:${profile.profileId}`,
      title: profile === undefined
        ? presetIdentity === "unknown" ? preset.label : modelProviderDisplayName(presetIdentity)
        : friendlyProfileTitle(profile),
      vendor: preset.vendor,
      logoDataUrl: profile?.logoDataUrl,
      model: configuredModel,
      baseUrl: profile === undefined ? preset.baseUrl : visibleProfileBaseUrl(profile),
      protocolKind: profile?.protocolKind ?? preset.protocolKind,
      profileId: profile?.profileId,
      profile,
      presetId: preset.presetId,
      preset,
      configured: profile !== undefined,
      protectedBuiltin: true,
    } satisfies ModelProviderListItem;
  });
  const customItems = profileBindings
    .filter((item) => item.profile.profileId === undefined || !boundProfileIds.has(item.profile.profileId))
    .map(({ profile }: { readonly profile: ModelProviderProfileItem }) => {
      const configuredModel = profile.model ?? "";
      return {
        key: `profile:${profile.profileId ?? profile.label ?? profile.baseUrl ?? profile.model ?? "custom"}`,
        title: friendlyProfileTitle(profile),
        logoDataUrl: profile.logoDataUrl,
        model: configuredModel,
        baseUrl: visibleProfileBaseUrl(profile),
        protocolKind: profile.protocolKind ?? "openai_compatible_chat_completions",
        profileId: profile.profileId,
        profile,
        configured: true,
        protectedBuiltin: false,
      } satisfies ModelProviderListItem;
    });
  return [...presetItems, ...customItems]
    .map((item: ModelProviderListItem, index: number) => ({ item, index }))
    .sort((left, right) => {
      const leftOrder = orderIndex(order, left.item.key);
      const rightOrder = orderIndex(order, right.item.key);
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      const rankDelta = modelProviderSortRank(left.item) - modelProviderSortRank(right.item);
      return rankDelta === 0 ? left.index - right.index : rankDelta;
    })
    .map(({ item }: { readonly item: ModelProviderListItem }) => item);
}

export function modelCatalogItemsWithConfiguredModel(
  models: readonly ModelProviderModelItem[],
  configuredModel: string | undefined,
  owner: string
): readonly ModelProviderModelItem[] {
  const modelId = configuredModel?.trim();
  if (modelId === undefined || modelId.length === 0 || models.some((model) => model.id === modelId)) {
    return models;
  }
  return [
    {
      id: modelId,
      displayName: modelId,
      owner,
    },
    ...models,
  ];
}

export function modelProviderFormId(item: ModelProviderListItem): string {
  return item.profileId ?? item.presetId ?? item.key;
}

export function modelFormFromProviderItem(item: ModelProviderListItem): ModelForm {
  return {
    profileId: modelProviderFormId(item),
    label: item.title,
    logoDataUrl: item.logoDataUrl ?? "",
    logoCleared: false,
    baseUrl: item.baseUrl,
    protocolKind: item.protocolKind,
    model: item.model,
    apiKey: "",
    apiKeyCleared: false,
  };
}

export function requestPathOptionsForProvider(): readonly { readonly value: string; readonly label: string }[] {
  return [
    { value: "openai_responses", label: "/responses" },
    { value: "openai_compatible_chat_completions", label: "/chat/completions" },
  ];
}

export function modelProtocolKind(value: string): ModelProtocolKind {
  return value === "openai_responses" ? value : "openai_compatible_chat_completions";
}

export function visibleProfileBaseUrl(profile: ModelProviderProfileItem): string {
  const baseUrl = profile.baseUrl ?? "";
  if (profile.profileId === "default" && (baseUrl.length === 0 || baseUrl === "https://api.openai.com")) {
    return "https://api.openai.com/v1";
  }
  return baseUrl;
}

function isSettingsModelProviderPreset(preset: ModelProviderPreset): boolean {
  return preset.providerKind === "openai_compatible" &&
    (preset.protocolKind === "openai_responses" || preset.protocolKind === "openai_compatible_chat_completions");
}

function isSettingsModelProviderProfile(profile: ModelProviderProfileItem): boolean {
  return profile.providerKind === "openai_compatible" &&
    (profile.protocolKind === "openai_responses" || profile.protocolKind === "openai_compatible_chat_completions");
}

function friendlyProfileTitle(profile: ModelProviderProfileItem): string {
  const label = profile.label?.trim();
  if (label !== undefined && label.length > 0) return label;
  const raw = profile.profileId ?? "";
  if (raw.trim().length === 0) return "自定义厂商";
  if (raw.toLowerCase() === "default") return "OpenAI";
  if (raw.toLowerCase() === "custom") return "自定义厂商";
  return raw;
}

function orderIndex(order: readonly string[], key: string): number {
  const index = order.indexOf(key);
  if (index !== -1) return index;
  const fallbackIndex = order.indexOf(alternateProviderKey(key));
  return fallbackIndex === -1 ? Number.MAX_SAFE_INTEGER : fallbackIndex;
}

function alternateProviderKey(key: string): string {
  if (key.startsWith("profile:")) return `preset:${key.slice("profile:".length)}`;
  if (key.startsWith("preset:")) return `profile:${key.slice("preset:".length)}`;
  return key;
}