import type React from "react";
import { getJson, postJson } from "../../../api";
import { decideRunConfirmation } from "./confirmation-decisions";
import { type ComposerReasoningEffort, type ComposerToolConfirmationPolicy, type VisibleAiMode } from "../../settings/config-projection";
import { createLiveRunUpdateController, type LiveRunSubscription } from "./live-run-updates";
import {
  appStateWithSettledRunProjection,
  loadSettledRunProjection,
} from "./observation-settlement";
import { shouldKeepRefreshing, stopLiveUpdates } from "./runtime-controls";
import { loadConversationSession, resetConversationSession } from "../conversation-session";
import { submitPanelTask } from "./task-submission";
import { invalidateUsageStatistics } from "../../../workbench/usage-statistics-query";
import type { AppState } from "../../../workbench/state";
import type { ContextAttachment } from "../../../contracts/context";
import type { Conversation, ConversationOwnerView, ConversationSummary } from "../../../contracts/conversation";
import type { OrdinaryRun } from "../../../contracts/run";
import { createRunObservationGuard } from "./observation-state";

export type AppRunController = {
  readonly activeRunIdRef: React.MutableRefObject<string | undefined>;
  readonly viewEpochRef: React.MutableRefObject<number>;
  readonly submissionAttemptRef: React.MutableRefObject<{ readonly key: string; readonly id: string } | undefined>;
  readonly loadConversation: (conversationId: string) => Promise<boolean>;
  readonly startTask: (explicitGoal?: string, attachments?: readonly ContextAttachment[]) => Promise<boolean>;
  readonly selectBranch: (runId: string) => Promise<void>;
  readonly editTurn: (runId: string, content: string) => Promise<boolean>;
  readonly startNewConversation: (owner?: ConversationOwnerView) => Promise<boolean>;
  readonly refreshConversations: () => Promise<void>;
  readonly startLiveUpdates: (input: LiveRunSubscription) => void;
  readonly cancelRun: () => Promise<void>;
  readonly decideConfirmation: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => Promise<void>;
  readonly resetChat: () => void;
};

export type AppRunControllerOptions = {
  readonly app: AppState;
  readonly setApp: React.Dispatch<React.SetStateAction<AppState>>;
  readonly setGoal: (goal: string) => void;
  readonly attachments: readonly ContextAttachment[];
  readonly setAttachments: React.Dispatch<React.SetStateAction<readonly ContextAttachment[]>>;
  readonly goal: string;
  readonly aiMode: VisibleAiMode;
  readonly composerReasoningEffort: ComposerReasoningEffort;
  readonly toolConfirmationPolicy: ComposerToolConfirmationPolicy;
  readonly selectedModelId: string;
  readonly selectedModelSupportsReasoningEffort: boolean;
  readonly branchMutationRef: React.MutableRefObject<boolean>;
  readonly confirmationBusy: boolean;
  readonly setConfirmationBusy: React.Dispatch<React.SetStateAction<boolean>>;
  readonly mountedRef: React.MutableRefObject<boolean>;
  readonly pollTimer: React.MutableRefObject<number | undefined>;
  readonly streamRef: React.MutableRefObject<EventSource | undefined>;
  readonly fallbackPollRef: React.MutableRefObject<AbortController | undefined>;
  readonly activeRunIdRef: React.MutableRefObject<string | undefined>;
  readonly viewEpochRef: React.MutableRefObject<number>;
  readonly submissionAttemptRef: React.MutableRefObject<{ readonly key: string; readonly id: string } | undefined>;
  readonly conversationLoadAbortRef: React.MutableRefObject<AbortController | undefined>;
  readonly conversationLoadTargetRef: React.MutableRefObject<string | undefined>;
  readonly setCancellingRunId: React.Dispatch<React.SetStateAction<string | undefined>>;
  /** Owner 为空间的对话提交（创建/续接）成功后刷新对应空间 read-model。 */
  readonly refreshSpaceConversations?: (spaceId: string) => void | Promise<void>;
};

export function createAppRunController(options: AppRunControllerOptions): AppRunController {
  const currentRunId = options.app.run?.runId;
  const liveUpdates = createLiveRunUpdateController({
    setApp: options.setApp,
    mountedRef: options.mountedRef,
    pollTimer: options.pollTimer,
    streamRef: options.streamRef,
    fallbackPollRef: options.fallbackPollRef,
    activeRunIdRef: options.activeRunIdRef,
    viewEpochRef: options.viewEpochRef,
    refreshConversations,
  });

  async function loadConversation(conversationId: string): Promise<boolean> {
    try {
      return await loadConversationSession({
        ...options,
        refreshConversations,
        startLiveUpdates: liveUpdates.startLiveUpdates,
      }, conversationId);
    } catch (error: unknown) {
      if (isAbortError(error)) return false;
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "加载对话失败。",
        }));
      }
      return false;
    }
  }

  async function startTask(explicitGoal?: string, attachments?: readonly ContextAttachment[]): Promise<boolean> {
    return await submitPanelTask({
      ...options,
      refreshConversations,
      startLiveUpdates: liveUpdates.startLiveUpdates,
    }, explicitGoal, "continue", undefined, undefined, undefined, attachments);
  }

  async function selectBranch(targetRunId: string): Promise<void> {
    const conversationId = options.app.conversation?.conversationId;
    if (conversationId === undefined || options.app.busy || options.branchMutationRef.current) return;
    options.branchMutationRef.current = true;
    options.conversationLoadAbortRef.current?.abort();
    options.conversationLoadAbortRef.current = undefined;
    options.conversationLoadTargetRef.current = undefined;
    const epoch = ++options.viewEpochRef.current;
    options.setApp((previous) => ({ ...previous, busy: true, error: undefined }));
    try {
      const response = await postJson<{ readonly conversation: Conversation }>(`/api/conversations/${encodeURIComponent(conversationId)}/branches/select`, { targetRunId });
      if (!options.mountedRef.current || options.viewEpochRef.current !== epoch) return;
      await loadConversationSession({ ...options, refreshConversations, startLiveUpdates: liveUpdates.startLiveUpdates }, conversationId, response.conversation);
      // A version switch does not require recomputing every conversation.
      options.setApp((previous) => ({ ...previous, conversations: previous.conversations.map((summary) =>
        summary.conversationId === conversationId ? { ...summary, latestRunId: response.conversation.latestRunId,
          activeRunId: response.conversation.activeRunId, updatedAt: response.conversation.updatedAt } : summary) }));
    } catch (error) {
      if (!options.mountedRef.current || options.viewEpochRef.current !== epoch) return;
      options.setApp((previous) => ({ ...previous, busy: false, error: error instanceof Error ? error.message : "切换消息版本失败。" }));
    } finally {
      options.branchMutationRef.current = false;
    }
  }

  async function editTurn(runId: string, content: string): Promise<boolean> {
    return submitPanelTask({ ...options, refreshConversations, startLiveUpdates: liveUpdates.startLiveUpdates },
      content, "continue", undefined, undefined, runId);
  }

  async function startNewConversation(owner?: ConversationOwnerView): Promise<boolean> {
    return await submitTask("new", undefined, owner);
  }

  async function submitTask(
    conversationBehavior: "continue" | "new",
    explicitGoal?: string,
    newConversationOwner?: ConversationOwnerView,
  ): Promise<boolean> {
    return await submitPanelTask({
      ...options,
      refreshConversations,
      startLiveUpdates: liveUpdates.startLiveUpdates,
    }, explicitGoal, conversationBehavior, undefined, newConversationOwner);
  }

  async function refreshConversations(): Promise<void> {
    const response = await getJson<{ readonly conversations: readonly ConversationSummary[] }>("/api/conversations");
    options.setApp((previous) => ({ ...previous, conversations: response.conversations ?? [] }));
    invalidateUsageStatistics();
  }

  async function cancelRun(): Promise<void> {
    if (currentRunId === undefined) return;
    const guard = createRunObservationGuard(options, {
      runId: currentRunId,
      conversationId: options.app.conversation?.conversationId,
      epoch: options.viewEpochRef.current,
    });
    if (!guard.isCurrent(options.app)) return;
    options.setCancellingRunId(currentRunId);
    stopLiveUpdates(options.pollTimer, options.streamRef, options.fallbackPollRef);
    try {
      const response = await postJson<{ readonly run: OrdinaryRun }>(`/api/ordinary/runs/${encodeURIComponent(currentRunId)}/cancel`, {});
      if (!guard.isCurrent()) return;
      options.activeRunIdRef.current = currentRunId;
      options.setApp((previous) => {
        if (!guard.isCurrent(previous)) return previous;
        return {
          ...previous,
          run: response.run,
          busy: false,
        };
      });
      options.setCancellingRunId((pending) => pending === currentRunId ? undefined : pending);
      void loadSettledRunProjection({
        runId: currentRunId,
        run: response.run,
        workView: options.app.workView,
        capabilityResolution: options.app.capabilityResolution,
      }).then((settled) => {
        if (!guard.isCurrent()) return;
        options.setApp((previous) => guard.isCurrent(previous)
          ? appStateWithSettledRunProjection(previous, settled)
          : previous);
      }).catch(() => undefined);
      void refreshConversations().catch(() => undefined);
    } catch {
      if (!guard.isCurrent()) return;
      const current = options.app.run;
      if (current?.runId === currentRunId && shouldKeepRefreshing(current.status)) {
        liveUpdates.startLiveUpdates({
          runId: currentRunId,
          conversationId: options.app.conversation?.conversationId,
          epoch: guard.identity.epoch,
        });
      }
    } finally {
      // Clear only this run's marker; a newer cancellation owns a different id.
      if (options.mountedRef.current) {
        options.setCancellingRunId((pending) => pending === currentRunId ? undefined : pending);
      }
    }
  }

  async function decideConfirmation(decision: "approve_once" | "deny" | "guidance", guidance?: string): Promise<void> {
    await decideRunConfirmation({
      app: options.app,
      currentRunId,
      decision,
      guidance,
      confirmationBusy: options.confirmationBusy,
      setConfirmationBusy: options.setConfirmationBusy,
      setApp: options.setApp,
      mountedRef: options.mountedRef,
      activeRunIdRef: options.activeRunIdRef,
      viewEpochRef: options.viewEpochRef,
      refreshConversations,
      startLiveUpdates: liveUpdates.startLiveUpdates,
    });
  }

  function resetChat(): void {
    resetConversationSession({
      ...options,
      refreshConversations,
      startLiveUpdates: liveUpdates.startLiveUpdates,
    });
  }

  return {
    activeRunIdRef: options.activeRunIdRef,
    viewEpochRef: options.viewEpochRef,
    submissionAttemptRef: options.submissionAttemptRef,
    loadConversation,
    startTask,
    editTurn,
    selectBranch,
    startNewConversation,
    refreshConversations,
    startLiveUpdates: liveUpdates.startLiveUpdates,
    cancelRun,
    decideConfirmation,
    resetChat,
  };
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException
    ? reason.name === "AbortError"
    : reason instanceof Error && reason.name === "AbortError";
}
