import React from "react";
import type { AppSettingsController } from "../controllers/settings-controller";
import type { AppState } from "../../../workbench/state";
import type { ModelProviderModelCatalog } from "../../../../../panel-api/config";
import type { ConversationFollowUpMode } from "../../../contracts/composer";
import { SettingsDialog } from "./dialog";
import type { McpServerForm, ModelForm, SettingsGroup, ToolForm } from "./types";

type WorkbenchSettingsDialogFormState = {
  readonly modelForm: ModelForm;
  readonly setModelForm: (form: ModelForm) => void;
  readonly ordinaryAgentSystemPrompt: string;
  readonly setOrdinaryAgentSystemPrompt: (value: string) => void;
  readonly toolForm: ToolForm;
  readonly setToolForm: (form: ToolForm) => void;
  readonly mcpServerForm: McpServerForm;
  readonly setMcpServerForm: (form: McpServerForm) => void;
};

type WorkbenchSettingsDialogPreferences = {
  readonly modelUsageDisplayEnabled: boolean;
  readonly onModelUsageDisplayChange: (enabled: boolean) => void;
  readonly developerModeEnabled: boolean;
  readonly onDeveloperModeChange: (enabled: boolean) => void;
  readonly conversationFollowUpMode: ConversationFollowUpMode;
  readonly onConversationFollowUpModeChange: (mode: ConversationFollowUpMode) => void;
};

type WorkbenchSettingsDialogSavingState = {
  readonly model?: boolean;
  readonly workspace?: boolean;
  readonly ordinaryAgent?: boolean;
  readonly tools?: boolean;
};

export type WorkbenchSettingsDialogProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly initialGroup?: SettingsGroup;
  readonly app: Pick<AppState, "config" | "tools" | "skills" | "subAgents">;
  readonly modelCatalogs?: Readonly<Record<string, ModelProviderModelCatalog>>;
  readonly forms: WorkbenchSettingsDialogFormState;
  readonly preferences: WorkbenchSettingsDialogPreferences;
  readonly saving: WorkbenchSettingsDialogSavingState;
  readonly actions: AppSettingsController;
};

export function WorkbenchSettingsDialog(props: WorkbenchSettingsDialogProps): React.ReactElement | null {
  return (
    <SettingsDialog
      open={props.open}
      onClose={props.onClose}
      initialGroup={props.initialGroup}
      config={props.app.config}
      modelForm={props.forms.modelForm}
      setModelForm={props.forms.setModelForm}
      ordinaryAgentSystemPrompt={props.forms.ordinaryAgentSystemPrompt}
      setOrdinaryAgentSystemPrompt={props.forms.setOrdinaryAgentSystemPrompt}
      modelUsageDisplayEnabled={props.preferences.modelUsageDisplayEnabled}
      onModelUsageDisplayChange={props.preferences.onModelUsageDisplayChange}
      developerModeEnabled={props.preferences.developerModeEnabled}
      onDeveloperModeChange={props.preferences.onDeveloperModeChange}
      conversationFollowUpMode={props.preferences.conversationFollowUpMode}
      onConversationFollowUpModeChange={props.preferences.onConversationFollowUpModeChange}
      onSaveCommandShell={props.actions.saveCommandShell}
      savingModel={props.saving.model}
      savingWorkspace={props.saving.workspace}
      savingOrdinaryAgentPrompt={props.saving.ordinaryAgent}
      onSaveModel={props.actions.saveModelConfig}
      onCreateCustomProfile={props.actions.createCustomModelProfile}
      onReorderModelProviders={props.actions.reorderModelProviders}
      onDeleteModelProvider={props.actions.deleteModelProvider}
      onFetchModels={props.actions.fetchModelsForProfile}
      onSaveModelCatalog={props.actions.saveModelCatalog}
      onSaveModelCapabilities={props.actions.saveModelCapabilities}
      onRevealModelApiKey={props.actions.revealModelApiKey}
      modelCatalogs={props.modelCatalogs}
      skills={props.app.skills}
      subAgents={props.app.subAgents}
      onSaveOrdinaryAgentSystemPrompt={props.actions.saveOrdinaryAgentSystemPrompt}
      onSaveOrdinaryAgentSystemPromptVariant={props.actions.saveOrdinaryAgentSystemPromptVariant}
      onResetOrdinaryAgentSystemPrompt={props.actions.resetOrdinaryAgentSystemPrompt}
      tools={props.app.tools}
      toolForm={props.forms.toolForm}
      setToolForm={props.forms.setToolForm}
      mcpServerForm={props.forms.mcpServerForm}
      setMcpServerForm={props.forms.setMcpServerForm}
      savingTools={props.saving.tools}
      onSaveTools={(nextToolForm) => void props.actions.saveTools(nextToolForm)}
      onSaveSkillTriggerMode={(mode) => void props.actions.saveSkillTriggerMode(mode)}
      onSaveMcpServer={props.actions.saveMcpServer}
      onLoadMcpReferences={props.actions.loadMcpReferences}
      onImportMcpConfig={(config) => void props.actions.importMcpConfig(config)}
      onTestMcpServer={(serverId) => void props.actions.testMcpServer(serverId)}
      onCheckMcpEnvironment={props.actions.checkMcpEnvironment}
      onInstallMcpEnvironment={props.actions.installMcpEnvironment}
      onDeleteMcpServer={(serverId) => void props.actions.deleteMcpServer(serverId)}
      onUpdateMcpTool={(serverId, toolName, enabled, autoApproved) =>
        void props.actions.updateMcpTool(serverId, toolName, enabled, autoApproved)}
      onRefreshSkills={() => void props.actions.refreshSkills()}
      onRefreshSubAgents={() => void props.actions.refreshSubAgents()}
      onUpdateSkill={(skill, enabled) => void props.actions.updateSkill(skill, enabled)}
    />
  );
}
