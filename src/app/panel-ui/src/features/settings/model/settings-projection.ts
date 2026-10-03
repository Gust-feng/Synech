import type {
  ConfigResponse,
  ModelProviderModelCatalog,
  ModelProviderPreset,
} from "@panel-api/config";
import {
  builtinProviderPresetId,
  modelProviderSortRank,
} from "./provider-logos.js";

export type ModelForm = {
  readonly profileId: string;
  readonly presetId?: string;
  readonly label: string;
  readonly logoDataUrl: string;
  readonly logoCleared: boolean;
  readonly baseUrl: string;
  readonly protocolKind: ModelProtocolKind;
  readonly piProviderId: string;
  readonly connection?: ModelProviderPreset["connection"];
  readonly model: string;
  readonly apiKey: string;
  readonly apiKeyCleared: boolean;
};

export type ModelProviderProfileItem = NonNullable<ConfigResponse["profiles"]>[number];
export type ModelProviderModelItem = ModelProviderModelCatalog["models"][number];
export type ModelProtocolKind = NonNullable<ModelProviderProfileItem["protocolKind"]>;

export type ModelProviderListItem = {
  readonly key: string;
  readonly title: string;
  readonly brandId?: string;
  readonly brandLabel?: string;
  readonly serviceLabel?: string;
  readonly vendor?: string;
  readonly logoDataUrl?: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly protocolKind: ModelProtocolKind;
  readonly piProviderId?: string;
  readonly profileId?: string;
  readonly profile?: ModelProviderProfileItem;
  readonly presetId?: string;
  readonly preset?: ModelProviderPreset;
  readonly connection?: ModelProviderPreset["connection"];
  readonly configured: boolean;
  readonly protectedBuiltin: boolean;
  readonly active?: boolean;
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
  const profileItems = profiles.map((profile: ModelProviderProfileItem) => {
      const slotId = builtinProviderPresetId({ profileId: profile.profileId });
      // Template metadata can describe an explicitly declared provider, but
      // connection identity always remains the independent profileId.
      const preset = presets.find((candidate) =>
        profile.piProviderId !== undefined && candidate.piProviderId === profile.piProviderId
      ) ?? presets.find((candidate) => candidate.presetId === slotId);
      const configuredModel = profile.model ?? "";
      return {
        key: `profile:${profile.profileId ?? profile.label ?? profile.baseUrl ?? profile.model ?? "custom"}`,
        title: friendlyProfileTitle(profile),
        brandId: preset?.brandId ?? preset?.presetId,
        brandLabel: preset?.brandLabel ?? preset?.label,
        serviceLabel: preset?.serviceLabel ?? preset?.label,
        vendor: preset?.vendor,
        logoDataUrl: profile.logoDataUrl,
        model: configuredModel,
        baseUrl: visibleProfileBaseUrl(profile),
        protocolKind: profile.protocolKind ?? "openai_compatible_chat_completions",
        piProviderId: profile.piProviderId,
        profileId: profile.profileId,
        profile,
        presetId: preset?.presetId,
        preset,
        connection: profile.connection,
        configured: true,
        protectedBuiltin: PROTECTED_BUILTIN_PROFILE_IDS.has(profile.profileId ?? ""),
        active: profile.profileId !== undefined && profile.profileId === activeProfileId,
      } satisfies ModelProviderListItem;
    });
  return profileItems
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

const PROTECTED_BUILTIN_PROFILE_IDS: ReadonlySet<string> = new Set(["default", "deepseek", "moonshot", "glm", "minimax"]);

export function modelProviderPresetItems(config: ConfigResponse | undefined): readonly ModelProviderListItem[] {
  return (config?.modelProviderMarket?.presets ?? [])
    .filter(isSettingsModelProviderPreset)
    .map((preset) => ({
      key: `preset:${preset.presetId}`,
      title: preset.label,
      brandId: preset.brandId ?? preset.presetId,
      brandLabel: preset.brandLabel ?? preset.label,
      serviceLabel: preset.serviceLabel ?? preset.label,
      vendor: preset.vendor,
      model: "",
      baseUrl: preset.baseUrl,
      protocolKind: preset.protocolKind,
      piProviderId: preset.piProviderId,
      presetId: preset.presetId,
      preset,
      connection: preset.connection,
      configured: false,
      protectedBuiltin: false,
    }));
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
    presetId: item.presetId,
    label: item.title,
    logoDataUrl: item.logoDataUrl ?? "",
    logoCleared: false,
    baseUrl: item.baseUrl,
    protocolKind: item.protocolKind,
    piProviderId: item.piProviderId ?? "",
    connection: item.connection,
    model: item.model,
    apiKey: "",
    apiKeyCleared: false,
  };
}

export function modelProtocolOptions(): readonly { readonly value: ModelProtocolKind; readonly label: string }[] {
  return [
    { value: "openai_compatible_chat_completions", label: "/chat/completions" },
    { value: "openai_responses", label: "/responses" },
    { value: "anthropic_messages", label: "/messages" },
  ];
}

export function modelProtocolKind(value: string): ModelProtocolKind {
  if (value === "anthropic_messages" || value === "openai_responses" || value === "native") return value;
  return "openai_compatible_chat_completions";
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
    isSettingsModelProtocol(preset.protocolKind);
}

function isSettingsModelProviderProfile(profile: ModelProviderProfileItem): boolean {
  return profile.providerKind === "openai_compatible" &&
    isSettingsModelProtocol(profile.protocolKind);
}

/**
 * Protocols the model settings surface can list and edit.
 *
 * Native services are listed alongside generic connections, but only the
 * three generic protocols appear in the user-editable protocol selector.
 */
const SETTINGS_MODEL_PROTOCOLS: ReadonlySet<ModelProtocolKind> = new Set<ModelProtocolKind>([
  "anthropic_messages",
  "openai_responses",
  "openai_compatible_chat_completions",
  "native",
]);

function isSettingsModelProtocol(
  value: ModelProtocolKind | undefined,
): value is ModelProtocolKind {
  return value !== undefined && SETTINGS_MODEL_PROTOCOLS.has(value);
}

function friendlyProfileTitle(profile: ModelProviderProfileItem): string {
  const label = profile.label?.trim();
  if (label !== undefined && label.length > 0) return label;
  const raw = profile.profileId ?? "";
  if (raw.trim().length === 0) return "自定义服务";
  if (raw.toLowerCase() === "default") return "OpenAI";
  if (raw.toLowerCase() === "custom") return "自定义服务";
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
