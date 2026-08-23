import type {
  LocalSettings,
  ModelProviderModelCatalog,
  ModelProviderModelCatalogItem,
  ModelProviderProfileSettings,
} from "../../domain/config/index.js";
import { normalizeModelCatalogDisplayName } from "../../domain/config/index.js";
import { asRecord, optionalString, safeConfigId } from "./settings-utils.js";
import {
  DEFAULT_MODEL_PROVIDER_BASE_URL,
  normalizeBaseUrl,
  normalizeOptionalString,
  normalizeProfileId,
} from "./model-provider-common.js";

export function parseModelCatalogs(
  value: unknown,
  updatedAt: string
): LocalSettings["modelCatalogs"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const catalogs: ModelProviderModelCatalog[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const profileId = safeConfigId(optionalString(record.profileId) ?? "");
    if (profileId.length === 0) {
      continue;
    }
    catalogs.push({
      profileId,
      label: optionalString(record.label),
      baseUrl: optionalString(record.baseUrl) ?? "",
      modelsPath: normalizeModelCatalogPath(optionalString(record.modelsPath)),
      fetchedAt: optionalString(record.fetchedAt) ?? updatedAt,
      models: parseModelCatalogItems(record.models),
    });
  }
  return catalogs;
}

export function normalizeModelCatalogs(
  catalogs: readonly ModelProviderModelCatalog[],
  profiles: readonly ModelProviderProfileSettings[],
  now: string
): readonly ModelProviderModelCatalog[] {
  const profileMap = new Map(profiles.map((profile) => [profile.profileId, profile]));
  const catalogMap = new Map<string, ModelProviderModelCatalog>();
  for (const catalog of catalogs) {
    const profileId = normalizeCatalogProfileId(catalog.profileId);
    if (profileId === undefined) {
      continue;
    }
    const profile = profileMap.get(profileId);
    if (profile === undefined) {
      continue;
    }
    catalogMap.set(profileId, {
      profileId,
      label: normalizeOptionalString(catalog.label) ?? profile.label,
      baseUrl:
        normalizeBaseUrl(catalog.baseUrl) ??
        normalizeBaseUrl(profile.baseUrl) ??
        DEFAULT_MODEL_PROVIDER_BASE_URL,
      modelsPath: normalizeModelCatalogPath(catalog.modelsPath),
      fetchedAt: normalizeCatalogFetchedAt(catalog.fetchedAt) ?? now,
      models: normalizeModelCatalogItems(catalog.models),
    });
  }
  return [...catalogMap.values()];
}

function parseModelCatalogItems(value: unknown): readonly ModelProviderModelCatalogItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item): ModelProviderModelCatalogItem | undefined => {
      const record = asRecord(item);
      const id = optionalString(record.id);
      if (id === undefined) {
        return undefined;
      }
      return {
        id,
        displayName: normalizeModelCatalogDisplayName(optionalString(record.displayName), id),
        owner: optionalString(record.owner),
        createdAt: optionalString(record.createdAt),
      };
    })
    .filter((item): item is ModelProviderModelCatalogItem => item !== undefined);
}

function normalizeModelCatalogItems(
  models: readonly ModelProviderModelCatalogItem[]
): readonly ModelProviderModelCatalogItem[] {
  const map = new Map<string, ModelProviderModelCatalogItem>();
  for (const model of models) {
    const id = normalizeOptionalString(model.id);
    if (id === undefined || map.has(id)) {
      continue;
    }
    map.set(id, {
      id,
      displayName: normalizeModelCatalogDisplayName(normalizeOptionalString(model.displayName), id),
      owner: normalizeOptionalString(model.owner),
      createdAt: normalizeCatalogFetchedAt(model.createdAt),
    });
  }
  return [...map.values()];
}

function normalizeCatalogProfileId(profileId: string): string | undefined {
  try {
    return normalizeProfileId(profileId);
  } catch {
    return undefined;
  }
}

function normalizeModelCatalogPath(value: string | undefined): string {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    return "/models";
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeCatalogFetchedAt(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized !== undefined && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(normalized) ? normalized : undefined;
}
