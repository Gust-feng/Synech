import { useEffect, useRef, useState } from "react";
import type { ModelProviderModelCatalog } from "@panel-api/config";
import { removeRecordKey, useModelCatalogState } from "./catalog-state";
import {
  modelProviderFormId,
  type ModelForm,
  type ModelProviderListItem,
  type ModelProviderModelItem,
} from "./settings-projection";
import { modelFormForProviderItem } from "./provider-projection-draft";

type ProviderCatalogActionsOptions = {
  readonly selectedItem: ModelProviderListItem | undefined;
  readonly selectedForm: ModelForm;
  readonly selectedCatalog: ModelProviderModelCatalog | undefined;
  readonly catalogState: ReturnType<typeof useModelCatalogState>;
  readonly setModelForm: (form: ModelForm) => void;
  readonly upsertModelFormDraft: (form: ModelForm) => void;
  readonly saveModelImmediately: (form: ModelForm) => Promise<void>;
  readonly onFetchModels: (profileId?: string) => Promise<ModelProviderModelCatalog | undefined>;
  readonly onSaveModelCatalog: (profileId: string, catalog: ModelProviderModelCatalog) => Promise<void>;
};

export function useProviderCatalogActions(options: ProviderCatalogActionsOptions) {
  const [modelsFetchBusy, setModelsFetchBusy] = useState(false);
  const [fetchFeedback, setFetchFeedback] = useState<{
    readonly type: "error" | "success";
    readonly message: string;
  } | undefined>(undefined);
  const selectedProfileRef = useRef<string | undefined>(undefined);
  selectedProfileRef.current = options.selectedItem === undefined ? undefined : modelProviderFormId(options.selectedItem);

  useEffect(() => {
    setFetchFeedback(undefined);
  }, [options.selectedItem === undefined ? undefined : modelProviderFormId(options.selectedItem)]);

  async function fetchSelectedModels(): Promise<void> {
    const { selectedItem, selectedForm } = options;
    if (selectedItem === undefined) return;
    const profileId = selectedItem.profileId ?? modelProviderFormId(selectedItem);
    setModelsFetchBusy(true);
    setFetchFeedback(undefined);
    try {
      // Fetch always uses the current form, including a key the user just entered.
      // Persist the connection first so discovery never runs against stale secrets.
      await options.saveModelImmediately(modelFormForProviderItem(selectedForm, selectedItem));
      const catalog = await options.onFetchModels(profileId);
      if (catalog !== undefined) {
        options.catalogState.setFetchedCatalogs((previous) => ({
          ...previous,
          [catalog.profileId]: catalog,
        }));
        if (selectedProfileRef.current !== profileId) return;
        if (catalog.models.length > 0) {
          options.catalogState.setPickerOpenFor(profileId);
          setFetchFeedback(undefined);
        } else {
          setFetchFeedback({
            type: "error",
            message: "服务端返回的模型列表为空，请确认上游支持模型列表接口",
          });
        }
      } else {
        if (selectedProfileRef.current !== profileId) return;
        setFetchFeedback({
          type: "error",
          message: "获取模型失败，请检查 Base URL、API Key 与网络连通性",
        });
      }
    } catch (error) {
      if (selectedProfileRef.current !== profileId) return;
      const message = error instanceof Error ? error.message : "获取模型失败，请检查厂商配置与网络";
      setFetchFeedback({ type: "error", message });
    } finally {
      setModelsFetchBusy(false);
    }
  }

  async function saveCatalogModels(models: readonly ModelProviderModelItem[]): Promise<void> {
    const { selectedItem, selectedCatalog, catalogState } = options;
    if (selectedItem === undefined) return;
    const profileId = selectedItem.profileId ?? modelProviderFormId(selectedItem);
    const catalog = selectedCatalog ?? catalogState.fetchedCatalog ?? {
      profileId,
      label: selectedItem.title,
      baseUrl: selectedItem.baseUrl,
      modelsPath: "/models",
      fetchedAt: new Date().toISOString(),
      models: [],
    };
    await options.onSaveModelCatalog(profileId, {
      ...catalog,
      profileId,
      label: catalog.label ?? selectedItem.title,
      baseUrl: catalog.baseUrl || selectedItem.baseUrl,
      fetchedAt: new Date().toISOString(),
      models,
    });
  }

  async function addCatalogModel(model: ModelProviderModelItem): Promise<void> {
    const { selectedItem, selectedForm, catalogState } = options;
    if (selectedItem === undefined) return;
    const profileId = selectedItem.profileId ?? modelProviderFormId(selectedItem);
    const nextModels = [...catalogState.catalogModels.filter((item) => item.id !== model.id), model];
    await saveCatalogModels(nextModels);
    catalogState.setFetchedCatalogs((previous) => {
      const current = previous[profileId];
      if (current === undefined) return previous;
      return {
        ...previous,
        [profileId]: {
          ...current,
          models: current.models.filter((item) => item.id !== model.id),
        },
      };
    });
    if (selectedProfileRef.current === profileId && selectedForm.model.trim().length === 0) {
      selectCatalogModel(model.id);
    }
  }

  async function removeCatalogModel(modelId: string): Promise<void> {
    const { selectedItem, selectedForm, selectedCatalog, catalogState } = options;
    const nextModels = (selectedCatalog?.models ?? catalogState.catalogModels).filter((model) => model.id !== modelId);
    try {
      if (selectedForm.model === modelId || selectedItem?.model === modelId) {
        await saveSelectedModel(nextModels[0]?.id ?? "");
      }
      await saveCatalogModels(nextModels);
      catalogState.setModelNameDrafts((previous) => removeRecordKey(previous, modelId));
    } catch {
      // The parent owns user-facing error state.
    }
  }

  async function saveSelectedModel(modelId: string): Promise<void> {
    const { selectedItem, selectedForm, catalogState } = options;
    if (selectedItem === undefined) return;
    const nextForm = modelFormForProviderItem({ ...selectedForm, model: modelId }, selectedItem);
    options.setModelForm(nextForm);
    options.upsertModelFormDraft(nextForm);
    catalogState.setSelectedModelRowId(modelId || undefined);
    await options.saveModelImmediately(nextForm);
  }

  function selectCatalogModel(modelId: string): void {
    const { selectedItem, selectedForm, catalogState } = options;
    catalogState.setSelectedModelRowId(modelId);
    if (selectedForm.model === modelId || selectedItem === undefined) return;
    const nextForm = modelFormForProviderItem({ ...selectedForm, model: modelId }, selectedItem);
    options.setModelForm(nextForm);
    options.upsertModelFormDraft(nextForm);
    void options.saveModelImmediately(nextForm).catch(() => undefined);
  }

  async function commitModelDisplayName(modelId: string, value: string): Promise<void> {
    const { catalogState } = options;
    const model = catalogState.catalogModels.find((item) => item.id === modelId);
    if (model === undefined) return;
    const displayName = value.trim().length === 0 ? model.id : value.trim();
    if (displayName === model.displayName) {
      catalogState.setModelNameDrafts((previous) => removeRecordKey(previous, modelId));
      return;
    }
    try {
      await saveCatalogModels(catalogState.catalogModels.map((item) => (
        item.id === modelId ? { ...item, displayName } : item
      )));
      catalogState.setModelNameDrafts((previous) => removeRecordKey(previous, modelId));
    } catch {
      // The parent owns user-facing error state.
    }
  }

  async function applySelectedModels(selectedModelIds: readonly string[]): Promise<void> {
    const { selectedItem, selectedForm, catalogState } = options;
    if (selectedItem === undefined) return;
    const candidateMap = new Map(catalogState.availableCandidates.map((m) => [m.id, m]));
    const existingMap = new Map(catalogState.catalogModels.map((m) => [m.id, m]));

    const nextModels: ModelProviderModelItem[] = [];
    for (const id of selectedModelIds) {
      const existing = existingMap.get(id);
      const candidate = candidateMap.get(id);
      if (existing !== undefined) {
        nextModels.push(existing);
      } else if (candidate !== undefined) {
        nextModels.push(candidate);
      } else {
        nextModels.push({ id, displayName: id });
      }
    }

    try {
      if (!selectedModelIds.includes(selectedForm.model)) {
        await saveSelectedModel(nextModels[0]?.id ?? "");
      }
      await saveCatalogModels(nextModels);
      if (selectedProfileRef.current === modelProviderFormId(selectedItem)) {
        catalogState.setPickerOpenFor(undefined);
      }
    } catch {
      // Keep the picker open; the parent owns user-facing error state.
    }
  }

  return {
    modelsFetchBusy,
    fetchFeedback,
    clearFetchFeedback: () => setFetchFeedback(undefined),
    fetchSelectedModels,
    applySelectedModels,
    selectCatalogModel,
    commitModelDisplayName,
    removeCatalogModel,
    addCatalogModel,
  };
}
