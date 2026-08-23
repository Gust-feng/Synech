import type React from "react";
import {
  catalogRecordFromList,
  createCustomModelProviderProfile,
  deleteMcpServer,
  deleteModelProviderProfile,
  fetchMcpReferences,
  fetchModelProviderCatalog,
  importMcpServers,
  mergeCatalogsIntoConfig,
  revealModelProviderApiKey,
  refreshSkillCatalog,
  refreshSubAgentCatalog,
  resetOrdinaryAgentSystemPrompt as requestResetOrdinaryAgentSystemPrompt,
  saveCommandShellConfig,
  saveOrdinaryAgentSystemPrompt as requestSaveOrdinaryAgentSystemPrompt,
  saveOrdinaryAgentSystemPromptVariant as requestSaveOrdinaryAgentSystemPromptVariant,
  saveMcpServerSettings,
  saveModelCapabilityConfig,
  saveModelProviderCatalog,
  saveModelProviderConfig,
  saveModelProviderOrder,
  saveSkillTriggerConfig,
  saveToolConfirmationConfig,
  saveToolSettings,
  selectModelProviderModel,
  testMcpServer,
  checkMcpEnvironment,
  installMcpEnvironment,
  updateMcpToolState,
  updateSkillState,
  type ModelCapabilityUpdateForm,
} from "./app-config-actions";
import { mergeConfigResponse, type ComposerToolConfirmationPolicy, type VisibleAiMode } from "./app-config-projection";
import type { AppState } from "./app-state";
import type { McpServerForm, ModelForm, ToolForm } from "./components/settings-types";
import type { CommandShellKind, ConfigResponse, ModelProviderModelCatalog, SkillTriggerMode } from "./contracts/config";
import type { SkillDefinition } from "./contracts/skills";
import type { McpEnvironmentCheckResponse, McpReferenceResponse, McpServerCatalogItem } from "./contracts/tools";

export type AppSettingsController = {
  readonly saveModelConfig: (nextModelForm?: ModelForm) => Promise<void>;
  readonly createCustomModelProfile: (nextModelForm?: ModelForm) => Promise<void>;
  readonly reorderModelProviders: (order: readonly string[]) => Promise<void>;
  readonly deleteModelProvider: (profileId: string, fallbackProfileId?: string) => Promise<void>;
  readonly revealModelApiKey: (profileId: string) => Promise<string | undefined>;
  readonly selectComposerModel: (modelOptionId: string) => Promise<void>;
  readonly fetchModelsForProfile: (profileId?: string) => Promise<ModelProviderModelCatalog | undefined>;
  readonly saveModelCatalog: (profileId: string, catalog: ModelProviderModelCatalog) => Promise<void>;
  readonly saveModelCapabilities: (form: ModelCapabilityUpdateForm) => Promise<void>;
  readonly saveCommandShell: (kind: CommandShellKind | "auto") => Promise<void>;
  readonly saveToolConfirmationPolicy: (policy: ComposerToolConfirmationPolicy) => Promise<void>;
  readonly saveOrdinaryAgentSystemPrompt: (systemPrompt: string) => Promise<void>;
  readonly saveOrdinaryAgentSystemPromptVariant: (variant: string) => Promise<void>;
  readonly resetOrdinaryAgentSystemPrompt: () => Promise<void>;
  readonly saveSkillTriggerMode: (mode: SkillTriggerMode) => Promise<void>;
  readonly saveTools: (nextToolForm?: ToolForm) => Promise<void>;
  readonly saveMcpServer: (nextMcpServerForm?: McpServerForm) => Promise<void>;
  readonly loadMcpReferences: (serverId: string) => Promise<McpReferenceResponse>;
  readonly importMcpConfig: (config: string) => Promise<void>;
  readonly testMcpServer: (serverId: string) => Promise<void>;
  readonly checkMcpEnvironment: (form: Pick<McpServerForm, "command" | "commandLine">) => Promise<McpEnvironmentCheckResponse>;
  readonly installMcpEnvironment: (form: Pick<McpServerForm, "command" | "commandLine">) => Promise<McpEnvironmentCheckResponse>;
  readonly deleteMcpServer: (serverId: string) => Promise<void>;
  readonly updateMcpTool: (serverId: string, toolName: string, enabled: boolean, autoApproved?: boolean) => Promise<void>;
  readonly refreshSkills: () => Promise<void>;
  readonly refreshSubAgents: () => Promise<void>;
  readonly updateSkill: (skill: Pick<SkillDefinition, "id" | "stateKey">, enabled: boolean) => Promise<void>;
};

export type AppSettingsControllerOptions = {
  readonly app: AppState;
  readonly setApp: React.Dispatch<React.SetStateAction<AppState>>;
  readonly aiMode: VisibleAiMode;
  readonly modelForm: ModelForm;
  readonly setModelForm: React.Dispatch<React.SetStateAction<ModelForm>>;
  readonly setModelCatalogs: React.Dispatch<React.SetStateAction<Record<string, ModelProviderModelCatalog>>>;
  readonly setOrdinaryAgentSystemPrompt: React.Dispatch<React.SetStateAction<string>>;
  readonly toolForm: ToolForm;
  readonly setToolForm: React.Dispatch<React.SetStateAction<ToolForm>>;
  readonly mcpServerForm: McpServerForm;
  readonly setMcpServerForm: React.Dispatch<React.SetStateAction<McpServerForm>>;
  readonly mountedRef: React.MutableRefObject<boolean>;
  readonly modelSaveQueueRef: React.MutableRefObject<Promise<void>>;
  readonly toolSaveQueueRef: React.MutableRefObject<Promise<void>>;
  readonly mcpToolSaveQueueRef: React.MutableRefObject<Promise<void>>;
  readonly mcpToolUpdateVersionRef: React.MutableRefObject<number>;
  readonly mcpToolCatalogDraftRef: React.MutableRefObject<readonly McpServerCatalogItem[] | undefined>;
  readonly setSavingModel: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setSavingEnvironment: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setSavingOrdinaryAgentPrompt: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setSavingTools: React.Dispatch<React.SetStateAction<boolean>>;
};

export function createAppSettingsController(options: AppSettingsControllerOptions): AppSettingsController {
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

  async function saveCommandShell(kind: CommandShellKind | "auto"): Promise<void> {
    options.setSavingEnvironment(true);
    try {
      const response = await saveCommandShellConfig(kind);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "命令 shell 保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingEnvironment(false);
    }
  }

  async function saveToolConfirmationPolicy(policy: ComposerToolConfirmationPolicy): Promise<void> {
    try {
      const response = await saveToolConfirmationConfig(policy);
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
          error: error instanceof Error ? error.message : "确认策略保存失败。",
        }));
      }
      throw error;
    }
  }

  async function saveOrdinaryAgentSystemPrompt(systemPrompt: string): Promise<void> {
    options.setSavingOrdinaryAgentPrompt(true);
    try {
      const response = await requestSaveOrdinaryAgentSystemPrompt(systemPrompt);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
          error: undefined,
        }));
        options.setOrdinaryAgentSystemPrompt(response.ordinaryAgent?.systemPrompt ?? systemPrompt);
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "系统提示词保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingOrdinaryAgentPrompt(false);
    }
  }

  async function saveOrdinaryAgentSystemPromptVariant(variant: string): Promise<void> {
    options.setSavingOrdinaryAgentPrompt(true);
    try {
      const response = await requestSaveOrdinaryAgentSystemPromptVariant(variant);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
          error: undefined,
        }));
        options.setOrdinaryAgentSystemPrompt(response.ordinaryAgent?.systemPrompt ?? "");
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "提示词偏好保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingOrdinaryAgentPrompt(false);
    }
  }

  async function resetOrdinaryAgentSystemPrompt(): Promise<void> {
    options.setSavingOrdinaryAgentPrompt(true);
    try {
      const response = await requestResetOrdinaryAgentSystemPrompt();
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
          error: undefined,
        }));
        options.setOrdinaryAgentSystemPrompt(response.ordinaryAgent?.systemPrompt ?? "");
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "系统提示词恢复失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingOrdinaryAgentPrompt(false);
    }
  }

  async function saveSkillTriggerMode(mode: SkillTriggerMode): Promise<void> {
    options.setSavingTools(true);
    try {
      const response = await saveSkillTriggerConfig(mode);
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
          error: error instanceof Error ? error.message : "Skills 触发方式保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function saveTools(nextToolForm: ToolForm = options.toolForm): Promise<void> {
    const save = options.toolSaveQueueRef.current
      .catch(() => undefined)
      .then(() => persistTools(nextToolForm));
    options.toolSaveQueueRef.current = save.catch(() => undefined);
    await save;
  }

  async function persistTools(nextToolForm: ToolForm): Promise<void> {
    options.setSavingTools(true);
    try {
      const response = await saveToolSettings(nextToolForm);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...response,
            mcpCatalog: response.mcpCatalog ?? previous.tools?.mcpCatalog,
          },
        }));
        if (nextToolForm.apiKey.trim().length > 0) {
          options.setToolForm((previous) => ({ ...previous, apiKey: "" }));
        }
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "工具配置保存失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function saveMcpServer(nextMcpServerForm: McpServerForm = options.mcpServerForm): Promise<void> {
    try {
      const response = await saveMcpServerSettings(nextMcpServerForm);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...previous.tools,
            mcpCatalog: response.mcpCatalog ?? [],
          },
        }));
        options.setMcpServerForm((previous) => ({
          ...previous,
          serverId: nextMcpServerForm.serverId || previous.serverId,
          authTouched: false,
          bearerTokenValue: "",
          apiKeyValue: "",
          customHeaderValue: "",
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 服务保存失败。",
        }));
      }
      throw error;
    } finally {
    }
  }

  async function loadMcpReferences(serverId: string): Promise<McpReferenceResponse> {
    try {
      return await fetchMcpReferences(serverId);
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 提示与资源读取失败。",
        }));
      }
      return { ok: false, errorSummary: "MCP 提示与资源读取失败。", prompts: [], resources: [], resourceTemplates: [] };
    }
  }

  async function importMcpConfig(config: string): Promise<void> {
    options.setSavingTools(true);
    try {
      const response = await importMcpServers(config);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...previous.tools,
            mcpCatalog: response.mcpCatalog ?? [],
          },
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 配置导入失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function testSelectedMcpServer(serverId: string): Promise<void> {
    options.setSavingTools(true);
    try {
      const response = await testMcpServer(serverId);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...previous.tools,
            mcpCatalog: response.mcpCatalog ?? [],
          },
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 连接测试失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function checkSelectedMcpEnvironment(
    form: Pick<McpServerForm, "command" | "commandLine">
  ): Promise<McpEnvironmentCheckResponse> {
    try {
      return await checkMcpEnvironment(form);
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 本地运行环境检测失败。",
        }));
      }
      throw error;
    }
  }

  async function installSelectedMcpEnvironment(
    form: Pick<McpServerForm, "command" | "commandLine">
  ): Promise<McpEnvironmentCheckResponse> {
    try {
      return await installMcpEnvironment(form);
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 本地运行环境安装失败。",
        }));
      }
      throw error;
    }
  }

  async function deleteSelectedMcpServer(serverId: string): Promise<void> {
    options.setSavingTools(true);
    try {
      const response = await deleteMcpServer(serverId);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...previous.tools,
            mcpCatalog: response.mcpCatalog ?? [],
          },
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 服务删除失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function updateMcpTool(serverId: string, toolName: string, enabled: boolean, autoApproved?: boolean): Promise<void> {
    const updateVersion = options.mcpToolUpdateVersionRef.current + 1;
    options.mcpToolUpdateVersionRef.current = updateVersion;
    const baseCatalog = options.mcpToolCatalogDraftRef.current ?? options.app.tools?.mcpCatalog ?? [];
    const nextPatch = mcpToolPatchFromCatalog(baseCatalog, serverId, toolName, enabled, autoApproved);
    const nextCatalog = updateLocalMcpCatalogServer(baseCatalog, serverId, nextPatch);
    options.mcpToolCatalogDraftRef.current = nextCatalog;
    if (options.mountedRef.current) {
      options.setApp((previous) => ({
        ...previous,
        tools: {
          ...previous.tools,
          mcpCatalog: nextCatalog,
        },
        error: undefined,
      }));
    }

    const save = options.mcpToolSaveQueueRef.current
      .catch(() => undefined)
      .then(() => updateMcpToolState({
        serverId,
        toolExposureMode: "selected",
        enabledTools: nextPatch.enabledTools,
        autoApprovedTools: nextPatch.autoApprovedTools,
      }));
    options.mcpToolSaveQueueRef.current = save.then(() => undefined, () => undefined);

    try {
      const response = await save;
      if (options.mountedRef.current && options.mcpToolUpdateVersionRef.current === updateVersion) {
        const responseCatalog = response.mcpCatalog ?? [];
        options.mcpToolCatalogDraftRef.current = responseCatalog;
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...previous.tools,
            mcpCatalog: responseCatalog,
          },
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current && options.mcpToolUpdateVersionRef.current === updateVersion) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "MCP 工具状态保存失败。",
        }));
      }
    }
  }

  async function updateSkill(skill: Pick<SkillDefinition, "id" | "stateKey">, enabled: boolean): Promise<void> {
    options.setSavingTools(true);
    try {
      const skills = await updateSkillState(skill, enabled);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({ ...previous, skills, error: undefined }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "技能状态保存失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function refreshSkills(): Promise<void> {
    options.setSavingTools(true);
    try {
      const skills = await refreshSkillCatalog();
      if (options.mountedRef.current) {
        options.setApp((previous) => ({ ...previous, skills, error: undefined }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "技能刷新失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function refreshSubAgents(): Promise<void> {
    options.setSavingTools(true);
    try {
      const subAgents = await refreshSubAgentCatalog();
      if (options.mountedRef.current) {
        options.setApp((previous) => ({ ...previous, subAgents, error: undefined }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "子 Agent 刷新失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
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
    saveCommandShell,
    saveToolConfirmationPolicy,
    saveOrdinaryAgentSystemPrompt,
    saveOrdinaryAgentSystemPromptVariant,
    resetOrdinaryAgentSystemPrompt,
    saveSkillTriggerMode,
    saveTools,
    saveMcpServer,
    loadMcpReferences,
    importMcpConfig,
    testMcpServer: testSelectedMcpServer,
    checkMcpEnvironment: checkSelectedMcpEnvironment,
    installMcpEnvironment: installSelectedMcpEnvironment,
    deleteMcpServer: deleteSelectedMcpServer,
    updateMcpTool,
    refreshSkills,
    refreshSubAgents,
    updateSkill,
  };
}

function updateLocalMcpCatalogServer(
  catalog: readonly McpServerCatalogItem[],
  serverId: string,
  patch: {
    readonly toolExposureMode: NonNullable<McpServerCatalogItem["toolExposureMode"]>;
    readonly enabledTools: readonly string[];
    readonly autoApprovedTools: readonly string[];
  }
): readonly McpServerCatalogItem[] {
  return catalog.map((server) => {
    if (server.serverId !== serverId) {
      return server;
    }
    const exposedTools = server.tools.filter((tool) =>
      isLocalMcpToolEnabled(patch.toolExposureMode, patch.enabledTools, tool.protocolName));
    return {
      ...server,
      toolExposureMode: patch.toolExposureMode,
      enabledTools: patch.enabledTools,
      autoApprovedTools: patch.autoApprovedTools,
      exposedTools,
    };
  });
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

function mcpToolPatchFromCatalog(
  catalog: readonly McpServerCatalogItem[],
  serverId: string,
  toolName: string,
  enabled: boolean,
  autoApproved?: boolean
): {
  readonly toolExposureMode: NonNullable<McpServerCatalogItem["toolExposureMode"]>;
  readonly enabledTools: readonly string[];
  readonly autoApprovedTools: readonly string[];
} {
  const currentServer = catalog.find((server) => server.serverId === serverId);
  const currentTools = new Set(currentServer?.enabledTools ?? []);
  const currentAutoApprovedTools = new Set(currentServer?.autoApprovedTools ?? []);
  if (enabled) {
    currentTools.add(toolName);
  } else {
    currentTools.delete(toolName);
    currentAutoApprovedTools.delete(toolName);
  }
  if (autoApproved !== undefined) {
    if (autoApproved) {
      currentAutoApprovedTools.add(toolName);
    } else {
      currentAutoApprovedTools.delete(toolName);
    }
  }
  return {
    toolExposureMode: "selected",
    enabledTools: [...currentTools],
    autoApprovedTools: [...currentAutoApprovedTools],
  };
}

function isLocalMcpToolEnabled(
  exposureMode: NonNullable<McpServerCatalogItem["toolExposureMode"]>,
  enabledTools: readonly string[],
  toolName: string
): boolean {
  if (exposureMode === "none") return false;
  if (exposureMode === "all") return true;
  return enabledTools.includes(toolName);
}
