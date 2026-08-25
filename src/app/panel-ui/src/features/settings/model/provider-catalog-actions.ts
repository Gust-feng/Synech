import { useState } from "react";
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
  readonly saveProvider: (form: ModelForm) => Promise<void>;
  readonly onFetchModels: (profileId?: string) => Promise<ModelProviderModelCatalog | undefined>;
  readonly onSaveModelCatalog: (profileId: string, catalog: ModelProviderModelCatalog) => Promise<void>;
};

export function useProviderCatalogActions(options: ProviderCatalogActionsOptions) {
  const [modelsFetchBusy, setModelsFetchBusy] = useState(false);

  async function fetchSelectedModels(): Promise<void> {
    const { selectedItem, selectedForm } = options;
    if (selectedItem === undefined) return;
    const profileId = selectedItem.profileId ?? modelProviderFormId(selectedItem);
    setModelsFetchBusy(true);
    try {
      if (selectedItem.profileId === undefined) {
        await options.saveProvider(modelFormForProviderItem(selectedForm, selectedItem));
      }
      const catalog = await options.onFetchModels(profileId);
      if (catalog !== undefined) {
        options.catalogState.setFetchedCatalogs((previous) => ({
          ...previous,
          [catalog.profileId]: catalog,
        }));
      }
    } catch {
      // The parent owns user-facing error state.
    } finally {
      setModelsFetchBusy(false);
    }
  }

  async function saveCatalogModels(models: readonly ModelProviderModelItem[]): Promise<void> {
    const { selectedItem, selectedCatalog, catalogState } = options;
    if (selectedItem?.profileId === undefined) return;
    const catalog = selectedCatalog ?? catalogState.fetchedCatalog ?? {
      profileId: selectedItem.profileId,
      label: selectedItem.title,
      baseUrl: selectedItem.baseUrl,
      modelsPath: "/models",
      fetchedAt: new Date().toISOString(),
      models: [],
    };
    await options.onSaveModelCatalog(selectedItem.profileId, {
      ...catalog,
      profileId: selectedItem.profileId,
      label: catalog.label ?? selectedItem.title,
      baseUrl: catalog.baseUrl || selectedItem.baseUrl,
      fetchedAt: new Date().toISOString(),
      models,
    });
  }

  async function addCatalogModel(model: ModelProviderModelItem): Promise<void> {
    const { selectedItem, catalogState } = options;
    if (selectedItem?.profileId === undefined) return;
    const profileId = selectedItem.profileId;
    const nextModels = [...catalogState.catalogModels.filter((item) => item.id !== model.id), model];
    try {
      await saveCatalogModels(nextModels);
    } catch {
      return;
    }
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
  }

  async function removeCatalogModel(modelId: string): Promise<void> {
    const { selectedItem, selectedForm, selectedCatalog, catalogState } = options;
    const nextModels = (selectedCatalog?.models ?? catalogState.catalogModels).filter((model) => model.id !== modelId);
    if (selectedForm.model === modelId || selectedItem?.model === modelId) {
      const nextForm = selectedItem === undefined
        ? { ...selectedForm, model: "" }
        : modelFormForProviderItem({ ...selectedForm, model: "" }, selectedItem);
      options.setModelForm(nextForm);
      options.upsertModelFormDraft(nextForm);
      catalogState.setSelectedModelRowId(undefined);
    }
    catalogState.setModelNameDrafts((previous) => removeRecordKey(previous, modelId));
    try {
      await saveCatalogModels(nextModels);
    } catch {
      return;
    }
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

  return {
    modelsFetchBusy,
    fetchSelectedModels,
    selectCatalogModel,
    commitModelDisplayName,
    removeCatalogModel,
    addCatalogModel,
  };
}
