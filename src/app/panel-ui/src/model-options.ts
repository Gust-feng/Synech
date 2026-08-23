import type { ChatModelOption } from "./contracts/composer";
import { resolveModelIconSvgForModel } from "./model-icons";
import { modelProviderSortRank, resolveModelProviderIdentity } from "./model-provider-logos";
import type { ConfigResponse, ModelCapabilities, ModelProviderModelCatalog } from "./contracts/config";

type ConfigModelProfile = NonNullable<ConfigResponse["profiles"]>[number];
type ConfigModelProfileWithId = ConfigModelProfile & { readonly profileId: string };

export function modelOptionsFromConfig(
  config: ConfigResponse | undefined,
  catalogs: Readonly<Record<string, ModelProviderModelCatalog>>,
  options: { readonly includeCapabilityProfileModels?: boolean } = {}
): readonly ChatModelOption[] {
  const order = config?.modelProviderOrder ?? [];
  const capabilityLookup = modelCapabilityLookup(config);
  return (config?.profiles ?? [])
    .filter(modelProfileHasId)
    .filter(modelProfileIsSelectable)
    .map((profile, index) => ({ profile, index }))
    .sort((left, right) => {
      const leftOrder = orderIndex(order, `profile:${left.profile.profileId}`);
      const rightOrder = orderIndex(order, `profile:${right.profile.profileId}`);
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      const rankDelta = modelProviderSortRank({
        title: left.profile.label,
        profileId: left.profile.profileId,
        baseUrl: left.profile.baseUrl,
        model: left.profile.model,
      }) - modelProviderSortRank({
        title: right.profile.label,
        profileId: right.profile.profileId,
        baseUrl: right.profile.baseUrl,
        model: right.profile.model,
      });
      return rankDelta === 0 ? left.index - right.index : rankDelta;
    })
    .flatMap(({ profile }) => {
      const catalog = catalogs[profile.profileId];
      const identity = resolveModelProviderIdentity({
        title: profile.label ?? catalog?.label,
        profileId: profile.profileId,
        baseUrl: profile.baseUrl ?? catalog?.baseUrl,
        model: profile.model,
      });
      const label = profile.label ?? catalog?.label ?? profile.profileId;
      return modelCatalogItemsForProfile(
        catalog?.models ?? [],
        profile.model,
        label,
        capabilityProfileModelIds(config, profile.profileId, options.includeCapabilityProfileModels === true)
      )
        .filter((model) => model.id.trim().length > 0)
        .map((model) => ({
          id: modelOptionId(profile.profileId, model.id),
          name: model.displayName || model.id,
          label,
          providerLabel: label,
          providerIdentity: identity,
          profileId: profile.profileId,
          modelId: model.id,
          capabilities: capabilityLookup.get(modelOptionId(profile.profileId, model.id)),
          iconSvg: resolveModelIconSvgForModel({
            providerIdentity: identity,
            modelId: model.id,
            displayName: model.displayName,
          }),
        }));
    });
}

export function modelCapabilitiesForProfileModel(
  config: ConfigResponse | undefined,
  profileId: string | undefined,
  modelId: string
): ModelCapabilities | undefined {
  if (profileId === undefined || profileId.trim().length === 0 || modelId.trim().length === 0) {
    return undefined;
  }
  return modelCapabilityLookup(config).get(modelOptionId(profileId, modelId));
}

export function selectedModelOptionId(config: ConfigResponse | undefined, options: readonly ChatModelOption[]): string {
  const profileId = config?.config?.profileId;
  const model = config?.config?.model;
  if (profileId === undefined || model === undefined) return "";
  const selectedId = modelOptionId(profileId, model);
  return options.some((option) => option.id === selectedId) ? selectedId : "";
}

export function modelOptionSupportsReasoningEffort(
  config: ConfigResponse | undefined,
  optionId: string
): boolean {
  const supportsCurrentModel = config?.capabilities?.modelCapabilities?.supportsReasoningEffort === true;
  if (optionId.length === 0) {
    return supportsCurrentModel;
  }
  const parsed = parseModelOptionId(optionId);
  if (parsed === undefined) return false;
  return config?.config?.profileId === parsed.profileId &&
    config.config.model === parsed.modelId &&
    supportsCurrentModel;
}

export function parseModelOptionId(value: string): { readonly profileId: string; readonly modelId: string } | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [profileId, modelId] = parsed;
    if (typeof profileId !== "string" || typeof modelId !== "string") return undefined;
    if (profileId.trim().length === 0 || modelId.trim().length === 0) return undefined;
    return { profileId, modelId };
  } catch {
    return undefined;
  }
}

function modelProfileHasId(profile: ConfigModelProfile): profile is ConfigModelProfileWithId {
  return typeof profile.profileId === "string" && profile.profileId.trim().length > 0;
}

function modelProfileIsSelectable(profile: ConfigModelProfileWithId): boolean {
  return profile.enabled !== false &&
    profile.secretConfigured === true &&
    profile.defaultAiMode !== "none";
}

function modelCapabilityLookup(config: ConfigResponse | undefined): ReadonlyMap<string, ModelCapabilities> {
  const lookup = new Map<string, ModelCapabilities>();
  for (const item of config?.modelCapabilityProfiles ?? []) {
    if (item.profileId.trim().length === 0 || item.model.trim().length === 0) continue;
    lookup.set(modelOptionId(item.profileId, item.model), item.capabilities);
  }
  const activeProfileId = config?.config?.profileId;
  const activeModel = config?.config?.model;
  const activeCapabilities = config?.capabilities?.modelCapabilities;
  if (
    activeProfileId !== undefined &&
    activeModel !== undefined &&
    activeCapabilities !== undefined &&
    !lookup.has(modelOptionId(activeProfileId, activeModel))
  ) {
    lookup.set(modelOptionId(activeProfileId, activeModel), activeCapabilities);
  }
  return lookup;
}

function modelCatalogItemsForProfile(
  models: readonly ModelProviderModelCatalog["models"][number][],
  configuredModel: string | undefined,
  owner: string,
  capabilityProfileModels: readonly string[]
): readonly ModelProviderModelCatalog["models"][number][] {
  const seen = new Set(models.map((model) => model.id));
  const modelId = configuredModel?.trim();
  const leading: ModelProviderModelCatalog["models"][number][] = [];
  if (modelId !== undefined && modelId.length > 0 && !seen.has(modelId)) {
    seen.add(modelId);
    leading.push({
      id: modelId,
      displayName: modelId,
      owner,
    });
  }
  const trailing: ModelProviderModelCatalog["models"][number][] = [];
  for (const capabilityModel of capabilityProfileModels) {
    const id = capabilityModel.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    trailing.push({
      id,
      displayName: id,
      owner,
    });
  }
  return [...leading, ...models, ...trailing];
}

function capabilityProfileModelIds(
  config: ConfigResponse | undefined,
  profileId: string,
  includeCapabilityProfileModels: boolean
): readonly string[] {
  if (!includeCapabilityProfileModels) return [];
  return (config?.modelCapabilityProfiles ?? [])
    .filter((item) => item.profileId === profileId)
    .map((item) => item.model);
}

function modelOptionId(profileId: string, modelId: string): string {
  return JSON.stringify([profileId, modelId]);
}

function orderIndex(order: readonly string[], key: string): number {
  const index = order.indexOf(key);
  if (index !== -1) return index;
  if (key.startsWith("profile:")) {
    const presetIndex = order.indexOf(`preset:${key.slice("profile:".length)}`);
    if (presetIndex !== -1) return presetIndex;
  }
  return Number.MAX_SAFE_INTEGER;
}
