import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { ModelProviderModelCatalog } from "../contracts/config";
import {
  filterModelCatalogItems,
  modelCatalogItemsWithConfiguredModel,
  type ModelProviderListItem,
  type ModelProviderModelItem,
} from "./model-settings-projection";

export function useModelCatalogState(input: {
  readonly selectedItem: ModelProviderListItem | undefined;
  readonly selectedCatalog?: ModelProviderModelCatalog;
}): {
  readonly fetchedCatalogs: Readonly<Record<string, ModelProviderModelCatalog>>;
  readonly setFetchedCatalogs: Dispatch<SetStateAction<Record<string, ModelProviderModelCatalog>>>;
  readonly modelNameDrafts: Readonly<Record<string, string>>;
  readonly setModelNameDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  readonly modelQuery: string;
  readonly setModelQuery: Dispatch<SetStateAction<string>>;
  readonly selectedModelRowId: string | undefined;
  readonly setSelectedModelRowId: Dispatch<SetStateAction<string | undefined>>;
  readonly catalogModels: readonly ModelProviderModelItem[];
  readonly fetchedCatalog: ModelProviderModelCatalog | undefined;
  readonly fetchedCandidates: readonly ModelProviderModelItem[];
  readonly hasModelQuery: boolean;
  readonly visibleCatalogModels: readonly ModelProviderModelItem[];
  readonly visibleFetchedCandidates: readonly ModelProviderModelItem[];
  readonly showSavedCount: boolean;
  readonly showModelSearch: boolean;
} {
  const [fetchedCatalogs, setFetchedCatalogs] = useState<Record<string, ModelProviderModelCatalog>>({});
  const [modelNameDrafts, setModelNameDrafts] = useState<Record<string, string>>({});
  const [modelQuery, setModelQuery] = useState("");
  const [selectedModelRowId, setSelectedModelRowId] = useState<string | undefined>(undefined);
  const catalogModels = useMemo(
    () => modelCatalogItemsWithConfiguredModel(
      input.selectedCatalog?.models ?? [],
      input.selectedItem?.model,
      input.selectedItem?.title ?? input.selectedCatalog?.label ?? "model"
    ),
    [input.selectedCatalog?.models, input.selectedCatalog?.label, input.selectedItem?.model, input.selectedItem?.title]
  );
  const savedModelIds = useMemo(() => new Set(catalogModels.map((model) => model.id)), [catalogModels]);
  const fetchedCatalog = input.selectedItem?.profileId === undefined ? undefined : fetchedCatalogs[input.selectedItem.profileId];
  const fetchedCandidates = (fetchedCatalog?.models ?? []).filter((model) => !savedModelIds.has(model.id));
  const normalizedModelQuery = modelQuery.trim().toLowerCase();
  const hasModelQuery = normalizedModelQuery.length > 0;
  const visibleCatalogModels = filterModelCatalogItems(catalogModels, normalizedModelQuery);
  const visibleFetchedCandidates = filterModelCatalogItems(fetchedCandidates, normalizedModelQuery);
  return {
    fetchedCatalogs,
    setFetchedCatalogs,
    modelNameDrafts,
    setModelNameDrafts,
    modelQuery,
    setModelQuery,
    selectedModelRowId,
    setSelectedModelRowId,
    catalogModels,
    fetchedCatalog,
    fetchedCandidates,
    hasModelQuery,
    visibleCatalogModels,
    visibleFetchedCandidates,
    showSavedCount: catalogModels.length > 0 || hasModelQuery,
    showModelSearch: catalogModels.length > 0 || fetchedCandidates.length > 0 || hasModelQuery,
  };
}

export function removeRecordKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next: Record<string, T> = { ...record };
  delete next[key];
  return next;
}