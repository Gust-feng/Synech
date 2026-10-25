import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversationSummaryRefresh } from "../features/conversations/conversation-refresh";
import { useConversationProjectionChanges } from "../features/conversations/conversation-projection-changes";
import { createAppRunController } from "../features/conversations/run/controller";
import {
  currentRunProjectionDeps,
  projectCurrentRun,
  type CurrentRunProjection,
} from "../features/conversations/run/projection";

import { createAppSidebarConversationController } from "../features/conversations/sidebar-controller";
import { createAppSettingsController, type AppSettingsController } from "../features/settings/controllers/settings-controller";
import { createAppComposerController } from "../features/conversations/composer-controller";
import { shouldKeepRefreshing, stopLiveUpdates } from "../features/conversations/run/runtime-controls";
import { sameRunObservationIdentity, type RunObservationIdentity } from "../features/conversations/run/observation-state";
import { resetTranscriptCache } from "../features/conversations/transcript/store";
import {
  contextWindowUsageFrom,
  contextWindowTokensForActiveRun,
  latestModelUsageFromEvents,
  latestModelUsageFromTranscript,
  type ContextWindowUsage,
} from "../features/conversations/context-window-usage";
import { isConversationWaitingForUser } from "../features/conversations/conversation-state";
import type { AppState } from "./state";
import { useAppBootstrap, type AppBootstrapLoadState } from "./use-app-bootstrap";
export type { AppBootstrapLoadState } from "./use-app-bootstrap";
import type {
  ComposerReasoningEffort,
  ComposerToolConfirmationPolicy,
  VisibleAiMode,
} from "../features/settings/config-projection";
import type { McpServerForm, ModelForm, ToolForm } from "../features/settings/components/types";
import type { ModelProviderModelCatalog } from "@panel-api/config";
import type { ContextAttachment } from "../contracts/context";
import type { OrdinaryWorkView } from "../contracts/run";
import type { McpServerCatalogItem } from "@panel-api/tools";

export type AppWorkbenchRuntimeOptions = {
  readonly app: AppState;
  readonly setApp: React.Dispatch<React.SetStateAction<AppState>>;
  readonly setGoal: React.Dispatch<React.SetStateAction<string>>;
  readonly goal: string;
  readonly aiMode: VisibleAiMode;
  readonly composerReasoningEffort: ComposerReasoningEffort;
  readonly toolConfirmationPolicy: ComposerToolConfirmationPolicy;
  readonly setToolConfirmationPolicy: React.Dispatch<React.SetStateAction<ComposerToolConfirmationPolicy>>;
  readonly setComposerSelectedModelId: React.Dispatch<React.SetStateAction<string | undefined>>;
  readonly modelForm: ModelForm;
  readonly setModelForm: React.Dispatch<React.SetStateAction<ModelForm>>;
  readonly setModelCatalogs: React.Dispatch<React.SetStateAction<Record<string, ModelProviderModelCatalog>>>;
  readonly setOrdinaryAgentSystemPrompt: React.Dispatch<React.SetStateAction<string>>;
  readonly toolForm: ToolForm;
  readonly setToolForm: React.Dispatch<React.SetStateAction<ToolForm>>;
  readonly mcpServerForm: McpServerForm;
  readonly setMcpServerForm: React.Dispatch<React.SetStateAction<McpServerForm>>;
  readonly attachments: readonly ContextAttachment[];
  readonly setAttachments: React.Dispatch<React.SetStateAction<readonly ContextAttachment[]>>;
  readonly selectedModelId: string;
  readonly selectedModelSupportsReasoningEffort: boolean;
  readonly selectedModelContextWindowTokens?: number;
  readonly setInputCloseSignal: React.Dispatch<React.SetStateAction<number>>;
  /** Owner 为空间的会话变更（创建/置顶/重命名/删除）成功后刷新对应空间 read-model。 */
  readonly refreshSpaceConversations?: (spaceId: string) => void | Promise<void>;
};

export type AppWorkbenchRuntime = {
  readonly bootstrap: AppBootstrapLoadState;
  readonly retryBootstrap: () => void;
  readonly currentRun: CurrentRunProjection;
  readonly contextUsage?: ContextWindowUsage;
  readonly modelResponding: boolean;
  readonly pendingConfirmation?: OrdinaryWorkView["pendingConfirmation"];
  readonly pendingCount: number;
  readonly confirmationBusy: boolean;
  readonly contextBusy: boolean;
  readonly pendingConversationIds: ReadonlySet<string>;

  readonly savingModel: boolean;
  readonly savingEnvironment: boolean;
  readonly savingOrdinaryAgentPrompt: boolean;
  readonly savingTools: boolean;
  readonly savingWebSearch: boolean;
  readonly savingSkillTrigger: boolean;
  readonly runActions: Pick<
    ReturnType<typeof createAppRunController>,
    | "loadConversation"
    | "startTask"
    | "editTurn"
    | "selectBranch"
    | "startNewConversation"
    | "cancelRun"
    | "decideConfirmation"
    | "resetChat"
  >;
  readonly sidebarActions: Pick<
    ReturnType<typeof createAppSidebarConversationController>,
    "renameConversation" | "toggleConversationPinned" | "deleteConversation"
  >;
  readonly settingsController: AppSettingsController;
  readonly composerActions: Pick<
    ReturnType<typeof createAppComposerController>,
    "selectInputModel" | "selectAttachment" | "uploadAttachments" | "removeAttachment" | "changeToolConfirmationPolicy"
  >;
};

export function useAppWorkbenchRuntime(options: AppWorkbenchRuntimeOptions): AppWorkbenchRuntime {
  const mountedRef = useRef(true);
  const { state: bootstrap, retry: retryBootstrap } = useAppBootstrap({ mountedRef, setApp: options.setApp });
  const [pendingConfirmationIdentity, setPendingConfirmationIdentity] = useState<RunObservationIdentity>();
  const [contextBusy, setContextBusy] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [savingEnvironment, setSavingEnvironment] = useState(false);
  const [savingOrdinaryAgentPrompt, setSavingOrdinaryAgentPrompt] = useState(false);
  const [savingTools, setSavingTools] = useState(false);
  const [savingWebSearch, setSavingWebSearch] = useState(false);
  const [savingSkillTrigger, setSavingSkillTrigger] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<string | undefined>(undefined);
  const [pendingConversationIds, setPendingConversationIds] = useState<ReadonlySet<string>>(() => new Set());


  const appRef = useRef(options.app);
  appRef.current = options.app;
  const pollTimer = useRef<number | undefined>(undefined);
  const streamRef = useRef<EventSource | undefined>(undefined);
  const fallbackPollRef = useRef<AbortController | undefined>(undefined);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  const viewEpochRef = useRef(0);
  const branchMutationRef = useRef(false);
  const submissionAttemptRef = useRef<{ readonly key: string; readonly id: string } | undefined>(undefined);
  const attachmentUploadAttemptRef = useRef<{ readonly key: string; readonly id: string } | undefined>(undefined);

  const conversationLoadAbortRef = useRef<AbortController | undefined>(undefined);
  const conversationLoadTargetRef = useRef<string | undefined>(undefined);
  const mutationConversationIdsRef = useRef<Set<string>>(new Set());
  const modelSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const toolSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mcpToolSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mcpToolUpdateVersionRef = useRef(0);
  const mcpToolCatalogDraftRef = useRef<readonly McpServerCatalogItem[] | undefined>(undefined);

  useConversationSummaryRefresh({
    conversations: options.app.conversations,
    setApp: options.setApp,
    mountedRef,
  });

  useEffect(() => {
    mcpToolCatalogDraftRef.current = options.app.tools?.mcpCatalog;
  }, [options.app.tools?.mcpCatalog]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      conversationLoadAbortRef.current?.abort();
      conversationLoadAbortRef.current = undefined;
      conversationLoadTargetRef.current = undefined;
      stopLiveUpdates(pollTimer, streamRef, fallbackPollRef);
      resetTranscriptCache();

    };
  }, []);

  const currentRun = useMemo(() => projectCurrentRun(options.app), currentRunProjectionDeps(options.app));
  const confirmationIdentity = useMemo(() => currentRun.run === undefined ? undefined : ({
    runId: currentRun.run.runId,
    conversationId: options.app.conversation?.conversationId,
    epoch: viewEpochRef.current,
  }), [currentRun.run?.runId, options.app.conversation?.conversationId, viewEpochRef.current]);
  const confirmationBusy = sameRunObservationIdentity(pendingConfirmationIdentity, confirmationIdentity);
  const setConfirmationBusy = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((update) => {
    setPendingConfirmationIdentity((previous) => {
      const owned = sameRunObservationIdentity(previous, confirmationIdentity);
      const busy = typeof update === "function" ? update(owned) : update;
      return busy ? confirmationIdentity : owned ? undefined : previous;
    });
  }, [confirmationIdentity]);
  const hasNormalConversationContext = options.app.conversation !== undefined || currentRun.run !== undefined;
  const latestModelUsage = useMemo(
    () => latestModelUsageFromEvents(currentRun.events) ?? latestModelUsageFromTranscript(currentRun.transcriptNodes),
    [currentRun.events, currentRun.transcriptNodes],
  );
  const contextUsage = useMemo(() => {
    if (!hasNormalConversationContext) {
      return undefined;
    }
    const runContextWindowTokens =
      currentRun.capabilityResolution?.modelContextWindowTokens;
    return contextWindowUsageFrom({
      contextWindowTokens: contextWindowTokensForActiveRun({
        runContextWindowTokens,
        selectedModelContextWindowTokens: options.selectedModelContextWindowTokens,
      }),
      modelUsage: latestModelUsage,
    });
  }, [
    currentRun.capabilityResolution?.modelContextWindowTokens,
    currentRun.run,
    hasNormalConversationContext,
    latestModelUsage,
    options.selectedModelContextWindowTokens,
  ]);
  const modelResponding = currentRun.run !== undefined &&
    currentRun.run.runId !== cancellingRunId &&
    shouldKeepRefreshing(currentRun.run.status);
  const pendingConfirmation = currentRun.workView?.pendingConfirmation;
  const pendingConversationCount = options.app.conversations.filter(isConversationWaitingForUser).length;
  const pendingCount = Math.max(pendingConversationCount, pendingConfirmation === undefined ? 0 : 1);

  const runController = useMemo(() => createAppRunController({
    app: options.app,
    setApp: options.setApp,
    setGoal: options.setGoal,
    attachments: options.attachments,
    setAttachments: options.setAttachments,
    goal: options.goal,
    aiMode: options.aiMode,
    composerReasoningEffort: options.composerReasoningEffort,
    toolConfirmationPolicy: options.toolConfirmationPolicy,
    selectedModelId: options.selectedModelId,
    selectedModelSupportsReasoningEffort: options.selectedModelSupportsReasoningEffort,
    confirmationBusy,
    branchMutationRef,
    setConfirmationBusy,
    mountedRef,
    pollTimer,
    streamRef,
    fallbackPollRef,
    activeRunIdRef,
    viewEpochRef,
    submissionAttemptRef,
    conversationLoadAbortRef,
    conversationLoadTargetRef,
    setCancellingRunId,
    refreshSpaceConversations: options.refreshSpaceConversations,
  }), [
    confirmationBusy,
    setConfirmationBusy,
    options.aiMode,
    options.app,
    options.attachments,
    options.composerReasoningEffort,
    options.goal,
    options.refreshSpaceConversations,
    options.selectedModelId,
    options.selectedModelSupportsReasoningEffort,
    options.setApp,
    options.setAttachments,
    options.setGoal,
    options.toolConfirmationPolicy,
  ]);

  useConversationProjectionChanges({
    appRef,
    setApp: options.setApp,
    mountedRef,
    activeRunIdRef,
    viewEpochRef,
    startLiveUpdates: runController.startLiveUpdates,
  });

  const sidebarConversationController = useMemo(() => createAppSidebarConversationController({
    app: options.app,
    appRef,
    setApp: options.setApp,
    mountedRef,
    mutationConversationIdsRef,
    setMutationConversationIds: setPendingConversationIds,
    resetChat: runController.resetChat,
    setInputCloseSignal: options.setInputCloseSignal,
    setGoal: options.setGoal,
    setAttachments: options.setAttachments,
    refreshSpaceConversations: options.refreshSpaceConversations,
  }), [
    options.app,
    options.setApp,
    options.setAttachments,
    options.setGoal,
    options.setInputCloseSignal,
    options.refreshSpaceConversations,
    runController.resetChat,
  ]);

  const settingsController = useMemo(() => createAppSettingsController({
    app: options.app,
    setApp: options.setApp,
    aiMode: options.aiMode,
    modelForm: options.modelForm,
    setModelForm: options.setModelForm,
    setModelCatalogs: options.setModelCatalogs,
    setOrdinaryAgentSystemPrompt: options.setOrdinaryAgentSystemPrompt,
    toolForm: options.toolForm,
    setToolForm: options.setToolForm,
    mcpServerForm: options.mcpServerForm,
    setMcpServerForm: options.setMcpServerForm,
    mountedRef,
    modelSaveQueueRef,
    toolSaveQueueRef,
    mcpToolSaveQueueRef,
    mcpToolUpdateVersionRef,
    mcpToolCatalogDraftRef,
    setSavingModel,
    setSavingEnvironment,
    setSavingOrdinaryAgentPrompt,
    setSavingTools,
    setSavingWebSearch,
    setSavingSkillTrigger,
  }), [
    options.aiMode,
    options.app,
    options.mcpServerForm,
    options.modelForm,
    options.setApp,
    options.setOrdinaryAgentSystemPrompt,
    options.setMcpServerForm,
    options.setModelCatalogs,
    options.setModelForm,
    options.setToolForm,
    options.toolForm,
  ]);

  const composerController = useMemo(() => createAppComposerController({
    setApp: options.setApp,
    mountedRef,
    viewEpochRef,
    contextBusy,
    setContextBusy,
    attachmentUploadAttemptRef,
    setAttachments: options.setAttachments,
    attachments: options.attachments,
    selectedModelId: options.selectedModelId,
    setComposerSelectedModelId: options.setComposerSelectedModelId,
    selectComposerModel: settingsController.selectComposerModel,
    toolConfirmationPolicy: options.toolConfirmationPolicy,
    setToolConfirmationPolicy: options.setToolConfirmationPolicy,
    saveToolConfirmationPolicy: settingsController.saveToolConfirmationPolicy,
  }), [
    contextBusy,
    options.attachments,
    options.selectedModelId,
    options.setApp,
    options.setAttachments,
    options.setComposerSelectedModelId,
    options.setToolConfirmationPolicy,
    options.toolConfirmationPolicy,
    settingsController.saveToolConfirmationPolicy,
    settingsController.selectComposerModel,
  ]);

  return {
    bootstrap,
    retryBootstrap,
    currentRun,
    contextUsage,
    modelResponding,
    pendingConfirmation,
    pendingCount,
    confirmationBusy,
    contextBusy,
    pendingConversationIds,

    savingModel,
    savingEnvironment,
    savingOrdinaryAgentPrompt,
    savingTools,
    savingWebSearch,
    savingSkillTrigger,
    runActions: {
      loadConversation: runController.loadConversation,
      startTask: runController.startTask,
      editTurn: runController.editTurn,
      selectBranch: runController.selectBranch,
      startNewConversation: runController.startNewConversation,
      cancelRun: runController.cancelRun,
      decideConfirmation: runController.decideConfirmation,
      resetChat: runController.resetChat,
    },
    sidebarActions: {
      renameConversation: sidebarConversationController.renameConversation,
      toggleConversationPinned: sidebarConversationController.toggleConversationPinned,
      deleteConversation: sidebarConversationController.deleteConversation,
    },
    settingsController,
    composerActions: {
      selectInputModel: composerController.selectInputModel,
      selectAttachment: composerController.selectAttachment,
      uploadAttachments: composerController.uploadAttachments,
      removeAttachment: composerController.removeAttachment,
      changeToolConfirmationPolicy: composerController.changeToolConfirmationPolicy,
    },
  };
}
