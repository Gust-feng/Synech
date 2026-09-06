import React, { useCallback, useState } from "react";
import { PersonalWorkbench } from "./personal-workbench/personal-workbench";
import { useAppShellEffects } from "./shell/effects";
import { persistSidebarCollapsedPreference, useAppShellState } from "./shell/state";
import { useAppQueuedMessages } from "./features/conversations/queued-message-state";
import { useAppWorkbenchConfigState } from "./features/settings/workbench-config-state";
import { useAppWorkbenchRuntime } from "./workbench/runtime";
import { workbenchSettingsDialogPropsFrom } from "./features/settings/controllers/dialog-props";
import { useAppWorkbenchTaskState } from "./features/conversations/task-state";
import { workbenchInputPropsFrom } from "./features/conversations/composer-input-props";
import { createInitialAppState } from "./workbench/state";
import { useSpaceProjection } from "./features/spaces/state";
import type { MemorySettingsScope } from "./features/memory/MemorySettingsPanel";

export function App(): React.ReactElement {
  const [app, setApp] = useState(createInitialAppState);
  const taskState = useAppWorkbenchTaskState();
  const spaceProjection = useSpaceProjection();
  const {
    goal,
    setGoal,
    attachments,
    setAttachments,
  } = taskState;
  const configState = useAppWorkbenchConfigState(app);
  const {
    aiMode,
    modelForm,
    setModelForm,
    composerReasoningEffort,
    setComposerReasoningEffort,
    toolConfirmationPolicy,
    setToolConfirmationPolicy,
    setComposerSelectedModelId,
    modelCatalogs,
    setModelCatalogs,
    ordinaryAgentSystemPrompt,
    setOrdinaryAgentSystemPrompt,
    toolForm,
    setToolForm,
    mcpServerForm,
    setMcpServerForm,
    modelOptions,
    selectedModelId,
    selectedModelSupportsReasoningEffort,
    selectedModelContextWindowTokens,
  } = configState;
  const shellState = useAppShellState();
  const {
    settingsOpen,
    settingsGroup,
    sidebarCollapsed,
    setSidebarCollapsed,
    modelUsageDisplayEnabled,
    setModelUsageDisplayEnabled,
    developerModeEnabled,
    conversationFollowUpMode,
    inputCloseSignal,
    setInputCloseSignal,
    openSettings,
    closeSettings,
    changeModelUsageDisplay,
    changeDeveloperMode,
    changeConversationFollowUpMode,
  } = shellState;
  const runtime = useAppWorkbenchRuntime({
    app,
    setApp,
    setGoal,
    goal,
    aiMode,
    composerReasoningEffort,
    toolConfirmationPolicy,
    setToolConfirmationPolicy,
    setComposerSelectedModelId,
    modelForm,
    setModelForm,
    setModelCatalogs,
    setOrdinaryAgentSystemPrompt,
    toolForm,
    setToolForm,
    mcpServerForm,
    setMcpServerForm,
    attachments,
    setAttachments,
    selectedModelId,
    selectedModelSupportsReasoningEffort,
    selectedModelContextWindowTokens,
    setInputCloseSignal,
    refreshSpaceConversations: spaceProjection.refreshSpace,
  });
  const {
    bootstrap,
    retryBootstrap,
    currentRun,
    contextUsage,
    modelResponding,
    pendingConfirmation,
    confirmationBusy,
    contextBusy,
    pendingConversationIds,
    savingModel,
    savingEnvironment,
    savingOrdinaryAgentPrompt,
    savingTools,
    runActions,
    sidebarActions,
    settingsController,
    composerActions,
  } = runtime;
  const {
    startTask,
    cancelRun,
    decideConfirmation,
  } = runActions;
  const {
    selectInputModel,
    selectAttachment,
    uploadAttachments,
    removeAttachment,
    changeToolConfirmationPolicy,
  } = composerActions;
  useAppShellEffects({
    sidebarCollapsed,
    persistSidebarCollapsed: persistSidebarCollapsedPreference,
    setModelUsageDisplayEnabled,
  });
  const {
    enqueueMessage,
    queuedMessages,
    removeQueuedMessage,
    updateQueuedMessage,
    clearQueuedMessages,
    guideQueuedMessage,
  } = useAppQueuedMessages({
    busy: app.busy,
    queueScopeId: app.conversation?.conversationId ?? currentRun.run?.conversationId,
    currentRun: currentRun.run,
    startTask,
  });
  const { inputProps: baseInputProps } = workbenchInputPropsFrom({
    goal,
    setGoal,
    attachments,
    selectAttachment,
    uploadAttachments,
    removeAttachment,
    contextBusy,
    busy: app.busy,
    models: modelOptions,
    selectedModelId,
    contextUsage,
    reasoningEffort: composerReasoningEffort,
    reasoningEffortEnabled: selectedModelSupportsReasoningEffort,
    onReasoningEffortChange: setComposerReasoningEffort,
    toolConfirmationPolicy,
    onToolConfirmationPolicyChange: changeToolConfirmationPolicy,
    closeSignal: inputCloseSignal,
    onModelSelect: selectInputModel,
    onOpenSettings: () => openSettings("models"),
    enqueueMessage,
    startTask,
    clearQueuedMessages,
    cancelRun,
    modelResponding,
    followUpMode: conversationFollowUpMode,
  });
  const inputProps = {
    ...baseInputProps,
    queuedMessages,
    onRemoveQueuedMessage: removeQueuedMessage,
    onUpdateQueuedMessage: updateQueuedMessage,
    onGuideQueuedMessage: guideQueuedMessage,
  };
  const startNewConversation = useCallback((owner?: { readonly kind: "space" | "workspace"; readonly id: string }) => {
    clearQueuedMessages();
    return runActions.startNewConversation(owner);
  }, [clearQueuedMessages, runActions.startNewConversation]);
  const openConversation = useCallback((conversationId: string) => {
    clearQueuedMessages();
    return runActions.loadConversation(conversationId);
  }, [clearQueuedMessages, runActions.loadConversation]);

  const settingsDialogProps = workbenchSettingsDialogPropsFrom({
    settingsOpen,
    closeSettings,
    settingsGroup,
    memoryScope: memorySettingsScopeFromConversation(app.conversation),
    onOpenConversation: openConversation,
    app,
    modelCatalogs,
    forms: {
      modelForm,
      setModelForm,
      ordinaryAgentSystemPrompt,
      setOrdinaryAgentSystemPrompt,
      toolForm,
      setToolForm,
      mcpServerForm,
      setMcpServerForm,
    },
    preferences: {
      modelUsageDisplayEnabled,
      onModelUsageDisplayChange: changeModelUsageDisplay,
      developerModeEnabled,
      onDeveloperModeChange: changeDeveloperMode,
      conversationFollowUpMode,
      onConversationFollowUpModeChange: changeConversationFollowUpMode,
    },
    saving: {
      model: savingModel,
      workspace: savingEnvironment,
      ordinaryAgent: savingOrdinaryAgentPrompt,
      tools: savingTools,
    },
    actions: settingsController,
  });
  return (
    <PersonalWorkbench
      personalKnowledgePersistenceEnabled
      bootstrapState={{
        status: bootstrap.status,
        ...(bootstrap.status === "error" ? { error: bootstrap.message } : {}),
        onRetry: retryBootstrap,
      }}
      sidebarCollapsed={sidebarCollapsed}
      onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
      conversation={app.conversation}
      conversations={app.conversations}
      currentRun={currentRun}
      inputProps={inputProps}
      showModelUsage={modelUsageDisplayEnabled}
      developerModeEnabled={developerModeEnabled}
      error={app.error}
      onDismissError={() => setApp((previous) => ({ ...previous, error: undefined }))}
      pendingConfirmation={pendingConfirmation}
      confirmationBusy={confirmationBusy}
      onDecision={(decision, guidance) => void decideConfirmation(decision, guidance)}
      onStartNewConversation={startNewConversation}
      onOpenConversation={openConversation}
      pendingConversationIds={pendingConversationIds}
      onRenameConversation={sidebarActions.renameConversation}
      onToggleConversationPinned={sidebarActions.toggleConversationPinned}
      onDeleteConversation={sidebarActions.deleteConversation}
      spaces={spaceProjection.spaces}
      spaceLoadState={{
        loading: spaceProjection.loading,
        mutationPending: spaceProjection.mutationPending,
        error: spaceProjection.error,
        onRetry: spaceProjection.refresh,
      }}
      onOpenSpaceItem={spaceProjection.openReference}
      onCreateSpace={spaceProjection.createSpace}
      spaceActions={{
        deleteSpace: spaceProjection.deleteSpace,
        createManagedFolder: spaceProjection.createManagedFolder,
        addLocalFile: spaceProjection.addLocalFile,
        addWorkspaceFolder: spaceProjection.addWorkspaceFolder,
        addWebReference: spaceProjection.addWebReference,
        rename: spaceProjection.rename,
        unlinkReference: spaceProjection.unlinkReference,
        reconnectWorkspace: spaceProjection.reconnectWorkspace,
        removeReference: spaceProjection.removeReference,
      }}
      onOpenSettings={() => openSettings("models")}
      settingsDialogProps={settingsDialogProps}
    />
  );
}

function memorySettingsScopeFromConversation(
  conversation: {
    readonly owner?: { readonly kind: "space" | "workspace"; readonly id: string };
  } | undefined,
): MemorySettingsScope | null {
  if (conversation === undefined || conversation.owner === undefined) return null;
  return {
    owner: conversation.owner,
  };
}
