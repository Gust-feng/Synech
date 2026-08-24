import type React from "react";
import type { VisibleAiMode } from "../config-projection";
import type { AppState } from "../../../workbench/state";
import type { McpServerForm, ModelForm, ToolForm } from "../components/types";
import type { ModelProviderModelCatalog } from "../../../../../panel-api/config";
import type { McpServerCatalogItem } from "../../../../../panel-api/tools";
import type { SettingsControllerContext } from "./controller-types";
import {
  createMcpSettingsController,
  type McpSettingsController,
} from "./mcp-controller";
import {
  createModelSettingsController,
  type ModelSettingsController,
} from "./model-controller";
import {
  createToolSettingsController,
  type ToolSettingsController,
} from "./tool-controller";

export type AppSettingsController =
  & ModelSettingsController
  & ToolSettingsController
  & McpSettingsController;

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
  const context: SettingsControllerContext = {
    app: options.app,
    setApp: options.setApp,
    mountedRef: options.mountedRef,
  };
  const model = createModelSettingsController({
    ...context,
    aiMode: options.aiMode,
    modelForm: options.modelForm,
    setModelForm: options.setModelForm,
    setModelCatalogs: options.setModelCatalogs,
    modelSaveQueueRef: options.modelSaveQueueRef,
    setSavingModel: options.setSavingModel,
  });
  const tools = createToolSettingsController({
    ...context,
    setOrdinaryAgentSystemPrompt: options.setOrdinaryAgentSystemPrompt,
    toolForm: options.toolForm,
    setToolForm: options.setToolForm,
    toolSaveQueueRef: options.toolSaveQueueRef,
    setSavingEnvironment: options.setSavingEnvironment,
    setSavingOrdinaryAgentPrompt: options.setSavingOrdinaryAgentPrompt,
    setSavingTools: options.setSavingTools,
  });
  const mcp = createMcpSettingsController({
    ...context,
    mcpServerForm: options.mcpServerForm,
    setMcpServerForm: options.setMcpServerForm,
    mcpToolSaveQueueRef: options.mcpToolSaveQueueRef,
    mcpToolUpdateVersionRef: options.mcpToolUpdateVersionRef,
    mcpToolCatalogDraftRef: options.mcpToolCatalogDraftRef,
    setSavingTools: options.setSavingTools,
  });

  return { ...model, ...tools, ...mcp };
}
