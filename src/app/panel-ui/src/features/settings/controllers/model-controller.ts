import type React from "react";
import {
  catalogRecordFromList,
  createCustomModelProviderProfile,
  deleteModelProviderProfile,
  fetchModelProviderCatalog,
  mergeCatalogsIntoConfig,
  revealModelProviderApiKey,
  saveModelCapabilityConfig,
  saveModelProviderCatalog,
  saveModelProviderConfig,
  saveModelProviderOrder,
  selectModelProviderModel,
  type ModelCapabilityUpdateForm,
} from "../config-actions";
import { mergeConfigResponse, type VisibleAiMode } from "../config-projection";
import type { ModelForm } from "../components/types";
import type { ConfigResponse, ModelProviderModelCatalog } from "@panel-api/config";
import type { SettingsControllerContext } from "./controller-types";

export type ModelSettingsController = {
  readonly saveModelConfig: (nextModelForm?: ModelForm) => Promise<void>;
  readonly createCustomModelProfile: (nextModelForm?: ModelForm) => Promise<void>;
  readonly reorderModelProviders: (order: readonly string[]) => Promise<void>;
  readonly deleteModelProvider: (profileId: string, fallbackProfileId?: string) => Promise<void>;
  readonly revealModelApiKey: (profileId: string) => Promise<string | undefined>;
  readonly selectComposerModel: (modelOptionId: string) => Promise<void>;
  readonly fetchModelsForProfile: (profileId?: string) => Promise<ModelProviderModelCatalog | undefined>;
  readonly saveModelCatalog: (profileId: string, catalog: ModelProviderModelCatalog) => Promise<void>;
  readonly saveModelCapabilities: (form: ModelCapabilityUpdateForm) => Promise<void>;
};

export type ModelSettingsControllerOptions = SettingsControllerContext & {
  readonly aiMode: VisibleAiMode;
  readonly modelForm: ModelForm;
  readonly setModelForm: React.Dispatch<React.SetStateAction<ModelForm>>;
  readonly setModelCatalogs: React.Dispatch<React.SetStateAction<Record<string, ModelProviderModelCatalog>>>;
  readonly modelSaveQueueRef: React.MutableRefObject<Promise<void>>;
  readonly setSavingModel: React.Dispatch<React.SetStateAction<boolean>>;
};

export function createModelSettingsController(options: ModelSettingsControllerOptions): ModelSettingsController {
  async function saveModelConfig(nextModelForm: ModelForm = options.modelForm): Promise<void> {
    const save = options.modelSaveQueueRef.current
      .catch(() => undefined)
      .then(() => persistModelConfig(nextModelForm));
    options.modelSaveQueueRef.current = save.catch(() => undefined);
    await save;
  }

  async function persistModelConfig(nextModelForm: ModelForm): Promise<void> {
    options.setSavingModel(true);
    try {
      const response = await saveModelProviderConfig({
        config: options.app.config,
        form: nextModelForm,
        aiMode: options.aiMode,
      });
      if (options.mountedRef.current) {
        options.setApp((previous) => ({ ...previous, config: mergeConfigResponse(previous.config, response) }));
        options.setModelForm((previous) => mergeSavedModelForm(previous, nextModelForm, response));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "模型服务保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingModel(false);
    }
  }

  async function createCustomModelProfile(nextModelForm: ModelForm = options.modelForm): Promise<void> {
    const save = options.modelSaveQueueRef.current
      .catch(() => undefined)
      .then(() => persistCreateCustomModelProfile(nextModelForm));
    options.modelSaveQueueRef.current = save.catch(() => undefined);
    await save;
  }

  async function persistCreateCustomModelProfile(nextModelForm: ModelForm): Promise<void> {
    options.setSavingModel(true);
    try {
      const activated = await createCustomModelProviderProfile({
        form: nextModelForm,
        aiMode: options.aiMode,
      });
      if (options.mountedRef.current) {
        options.setApp((previous) => ({ ...previous, config: mergeConfigResponse(previous.config, activated) }));
        options.setModelForm((previous) => ({ ...previous, apiKey: "", apiKeyCleared: false, logoCleared: false }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "模型服务添加失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingModel(false);
    }
  }

  async function revealModelApiKey(profileId: string): Promise<string | undefined> {
    try {
      return await revealModelProviderApiKey(profileId);
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "API Key 读取失败。",
        }));
      }
      throw error;
    }
  }

  async function selectComposerModel(modelOptionId: string): Promise<void> {
    const save = options.modelSaveQueueRef.current
      .catch(() => undefined)
      .then(() => persistComposerModelSelection(modelOptionId));
    options.modelSaveQueueRef.current = save.catch(() => undefined);
    await save;
  }

  async function persistComposerModelSelection(modelOptionId: string): Promise<void> {
    options.setSavingModel(true);
    try {
      const selected = await selectModelProviderModel({
        config: options.app.config,
        modelOptionId,
        aiMode: options.aiMode,
      });
      const selectedConfig = selected.config;
      if (options.mountedRef.current && selectedConfig !== undefined) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, selectedConfig),
          error: undefined,
        }));
        if (selected.form !== undefined) {
          options.setModelForm(selected.form);
        }
      }
      if (options.mountedRef.current && selectedConfig === undefined) {
        options.setApp((previous) => ({ ...previous, error: "模型切换失败：没有收到有效配置。" }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "模型切换失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingModel(false);
    }
  }

  async function reorderModelProviders(order: readonly string[]): Promise<void> {
    const save = options.modelSaveQueueRef.current
      .catch(() => undefined)
      .then(() => persistModelProviderOrder(order));
    options.modelSaveQueueRef.current = save.catch(() => undefined);
    await save;
  }

  async function persistModelProviderOrder(order: readonly string[]): Promise<void> {
    options.setSavingModel(true);
    try {
      const response = await saveModelProviderOrder(order);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "模型服务排序保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingModel(false);
    }
  }

  async function deleteModelProvider(profileId: string, fallbackProfileId?: string): Promise<void> {
    const normalizedProfileId = profileId.trim();
    if (normalizedProfileId.length === 0) return;
    const save = options.modelSaveQueueRef.current
      .catch(() => undefined)
      .then(() => persistDeleteModelProvider(normalizedProfileId, fallbackProfileId));
    options.modelSaveQueueRef.current = save.catch(() => undefined);
    await save;
  }

  async function persistDeleteModelProvider(
    profileId: string,
    fallbackProfileId: string | undefined
  ): Promise<void> {
    options.setSavingModel(true);
    try {
      const response = await deleteModelProviderProfile({
        config: options.app.config,
        profileId,
        fallbackProfileId,
      });
      if (options.mountedRef.current) {
        if (response.modelCatalogs !== undefined) {
          options.setModelCatalogs(catalogRecordFromList(response.modelCatalogs));
        }
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "模型服务删除失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingModel(false);
    }
  }

  async function fetchModelsForProfile(
    profileId = options.app.config?.config?.profileId
  ): Promise<ModelProviderModelCatalog | undefined> {
    if (profileId === undefined) return undefined;
    try {
      const response = await fetchModelProviderCatalog(profileId);
      if (options.mountedRef.current) {
        const catalogs = response.catalogs ?? options.app.config?.modelCatalogs;
        if (catalogs !== undefined) {
          options.setModelCatalogs(catalogRecordFromList(catalogs));
          options.setApp((previous) => ({
            ...previous,
            config: mergeConfigResponse(mergeCatalogsIntoConfig(previous.config, catalogs), {
              modelCapabilityProfiles: response.modelCapabilityProfiles,
            }),
          }));
        } else if (response.modelCapabilityProfiles !== undefined) {
          options.setApp((previous) => ({
            ...previous,
            config: mergeConfigResponse(previous.config, {
              modelCapabilityProfiles: response.modelCapabilityProfiles,
            }),
          }));
        }
      }
      return response.catalog;
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "模型列表获取失败。",
        }));
      }
      return undefined;
    }
  }

  async function saveModelCatalog(profileId: string, catalog: ModelProviderModelCatalog): Promise<void> {
    const save = options.modelSaveQueueRef.current
      .catch(() => undefined)
      .then(() => persistModelCatalog(profileId, catalog));
    options.modelSaveQueueRef.current = save.catch(() => undefined);
    await save;
  }

  async function persistModelCatalog(profileId: string, catalog: ModelProviderModelCatalog): Promise<void> {
    options.setSavingModel(true);
    try {
      const response = await saveModelProviderCatalog({ profileId, catalog });
      const catalogs = response.modelCatalogs ?? [];
      if (options.mountedRef.current) {
        options.setModelCatalogs(catalogRecordFromList(catalogs));
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(mergeCatalogsIntoConfig(previous.config, catalogs), response),
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "模型保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingModel(false);
    }
  }

  async function saveModelCapabilities(form: ModelCapabilityUpdateForm): Promise<void> {
    const save = options.modelSaveQueueRef.current
      .catch(() => undefined)
      .then(() => persistModelCapabilities(form));
    options.modelSaveQueueRef.current = save.catch(() => undefined);
    await save;
  }

  async function persistModelCapabilities(form: ModelCapabilityUpdateForm): Promise<void> {
    options.setSavingModel(true);
    try {
      const response = await saveModelCapabilityConfig(form);
      if (options.mountedRef.current) {
        const catalogs = response.modelCatalogs ?? options.app.config?.modelCatalogs ?? [];
        if (response.modelCatalogs !== undefined) {
          options.setModelCatalogs(catalogRecordFromList(response.modelCatalogs));
        }
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(
            catalogs.length === 0 ? previous.config : mergeCatalogsIntoConfig(previous.config, catalogs),
            response
          ),
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "模型信息保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingModel(false);
    }
  }

  return {
    saveModelConfig,
    createCustomModelProfile,
    reorderModelProviders,
    deleteModelProvider,
    revealModelApiKey,
    selectComposerModel,
    fetchModelsForProfile,
    saveModelCatalog,
    saveModelCapabilities,
  };
}

function mergeSavedModelForm(
  current: ModelForm,
  submitted: ModelForm,
  response: ConfigResponse
): ModelForm {
  const savedProfile = response.profile ?? response.config;
  const savedProfileId = savedProfile?.profileId ?? submitted.profileId;
  if (current.profileId !== submitted.profileId && current.profileId !== savedProfileId) {
    return {
      ...current,
      apiKeyCleared: false,
      logoCleared: false,
    };
  }
  if (savedProfile === undefined) {
    return {
      ...current,
      ...submitted,
      apiKey: submitted.apiKeyCleared ? "" : current.apiKey,
      apiKeyCleared: false,
      logoCleared: false,
    };
  }
  return {
    ...current,
    profileId: savedProfileId,
    label: savedProfile.label ?? submitted.label,
    logoDataUrl: savedProfile.logoDataUrl ?? "",
    baseUrl: savedProfile.baseUrl ?? submitted.baseUrl,
    protocolKind: savedProfile.protocolKind ?? submitted.protocolKind,
    model: savedProfile.model ?? "",
    apiKey: submitted.apiKeyCleared ? "" : current.apiKey,
    apiKeyCleared: false,
    logoCleared: false,
  };
}
