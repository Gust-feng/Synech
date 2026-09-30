import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { ModelProviderModelCatalog } from "@panel-api/config";
import {
  filterModelCatalogItems,
  modelCatalogItemsWithConfiguredModel,
  type ModelProviderListItem,
  type ModelProviderModelItem,
} from "./settings-projection";

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
  readonly pickerOpenFor: string | undefined;
  readonly setPickerOpenFor: Dispatch<SetStateAction<string | undefined>>;
  readonly availableCandidates: readonly ModelProviderModelItem[];
} {
  const [pickerOpenFor, setPickerOpenFor] = useState<string | undefined>(undefined);
  const [fetchedCatalogs, setFetchedCatalogs] = useState<Record<string, ModelProviderModelCatalog>>({});
  const [modelNameDrafts, setModelNameDrafts] = useState<Record<string, string>>({});
  const [modelQuery, setModelQuery] = useState("");
  const initialModelId = input.selectedItem?.model?.trim() || undefined;
  const [selectedModelRowId, setSelectedModelRowId] = useState<string | undefined>(initialModelId);
  const catalogModels = useMemo(
    () => modelCatalogItemsWithConfiguredModel(
      input.selectedCatalog?.modelsPath === "pi-catalog" ? [] : input.selectedCatalog?.models ?? [],
      input.selectedItem?.model,
      input.selectedItem?.title ?? input.selectedCatalog?.label ?? "model"
    ),
    [input.selectedCatalog?.models, input.selectedCatalog?.label, input.selectedItem?.model, input.selectedItem?.title]
  );
  const savedModelIds = useMemo(() => new Set(catalogModels.map((model) => model.id)), [catalogModels]);
  const profileKey = input.selectedItem?.profileId ?? input.selectedItem?.presetId;
  const fetchedCatalog = profileKey === undefined ? undefined : fetchedCatalogs[profileKey];
  const fetchedCandidates = (fetchedCatalog?.models ?? []).filter((model) => !savedModelIds.has(model.id));
  const normalizedModelQuery = modelQuery.trim().toLowerCase();
  const hasModelQuery = normalizedModelQuery.length > 0;
  const visibleCatalogModels = filterModelCatalogItems(catalogModels, normalizedModelQuery);
  const visibleFetchedCandidates = filterModelCatalogItems(fetchedCandidates, normalizedModelQuery);
  const availableCandidates = useMemo(() => {
    const map = new Map<string, ModelProviderModelItem>();
    // 先塞入已拉取模型
    for (const model of fetchedCatalog?.models ?? []) {
      map.set(model.id, model);
    }
    // 再合并当前模型库已有模型（带用户自定义别名）
    for (const model of catalogModels) {
      map.set(model.id, model);
    }
    return Array.from(map.values());
  }, [fetchedCatalog?.models, catalogModels]);

  return {
    fetchedCatalogs,
    setFetchedCatalogs,
    modelNameDrafts,
    setModelNameDrafts,
    modelQuery,
    setModelQuery,
    selectedModelRowId: selectedModelRowId ?? (input.selectedItem?.model?.trim() || undefined),
    setSelectedModelRowId,
    catalogModels,
    fetchedCatalog,
    fetchedCandidates,
    hasModelQuery,
    visibleCatalogModels,
    visibleFetchedCandidates,
    showSavedCount: catalogModels.length > 0 || hasModelQuery,
    showModelSearch: catalogModels.length > 0 || fetchedCandidates.length > 0 || hasModelQuery,
    pickerOpenFor,
    setPickerOpenFor,
    availableCandidates,
  };
}

export function removeRecordKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next: Record<string, T> = { ...record };
  delete next[key];
  return next;
}
