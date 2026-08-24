import { ApiError, postJson } from "../../../api";
import { loadObservedRunReadModel } from "./observed-run-read-model";
import { createRunReadModelPatch } from "./projection";
import { shouldKeepRefreshing } from "./runtime-controls";
import type { AppState } from "../../../workbench/state";
import { emptyLiveRun } from "@panel-api/ui-read-model";
import { nextRunCapabilityState } from "./capability-state";
import type { LiveRunSubscription } from "./live-run-updates";
import type { OrdinaryRun } from "../../../contracts/run";

export type ConfirmationDecision = "approve_once" | "deny" | "guidance";

type SetApp = (update: (previous: AppState) => AppState) => void;

export async function decideRunConfirmation(input: {
  readonly app: AppState;
  readonly currentRunId: string | undefined;
  readonly decision: ConfirmationDecision;
  readonly guidance?: string;
  readonly confirmationBusy: boolean;
  readonly setConfirmationBusy: (busy: boolean) => void;
  readonly setApp: SetApp;
  readonly mountedRef: { readonly current: boolean };
  readonly viewEpochRef: { readonly current: number };
  readonly refreshConversations: () => Promise<void>;
  readonly startLiveUpdates: (input: LiveRunSubscription) => void;
}): Promise<void> {
  const confirmation = pendingConfirmationFromApp(input.app);
  if (input.currentRunId === undefined || confirmation === undefined || input.confirmationBusy) return;
  const currentRunId = input.currentRunId;
  if (input.app.run?.status !== "approval_needed") {
    await refreshRunAfterConfirmationSettled({
      runId: currentRunId,
      preferredConversation: input.app.conversation,
      mountedRef: input.mountedRef,
      setApp: input.setApp,
      refreshConversations: input.refreshConversations,
    });
    return;
  }
  const localError = localConfirmationDecisionError(input.decision, confirmation.resumeAvailability, input.guidance);
  if (localError !== undefined) {
    input.setApp((previous) => ({ ...previous, error: localError }));
    return;
  }
  input.setConfirmationBusy(true);
  input.setApp((previous) => ({ ...previous, error: undefined }));

  try {
    const response = await postJson<{ readonly run: OrdinaryRun }>(
      `/api/ordinary/runs/${encodeURIComponent(currentRunId)}/confirmations/${encodeURIComponent(confirmation.confirmationId)}/decision`,
      { decision: input.decision, guidance: input.guidance?.trim() }
    );
    const observed = await loadObservedRunReadModel({
      runId: currentRunId,
      conversationId: response.run.conversationId,
      preferredConversation: input.app.conversation,
      requireFreshRunView: true,
    });
    const observedRun = observed.run ?? response.run;
    const shouldResumeLiveUpdates = shouldKeepRefreshing(observedRun.status);
    input.setApp((previous) => {
      const readModel = createRunReadModelPatch(previous, {
        runId: currentRunId,
        workView: observed.workView,
        detail: observed.detail,
        reusePreviousWorkView: false,
      });
      const capabilityState = nextRunCapabilityState(previous, {
        runId: currentRunId,
        capabilityResolution: observed.capabilityResolution,
      });
      return {
        ...previous,
        ...capabilityState,
        conversation: observed.conversation ?? previous.conversation,
        run: observedRun,
        live: shouldResumeLiveUpdates ? emptyLiveRun(currentRunId) : previous.live,
        error: undefined,
        ...readModel,
      };
    });
    if (shouldResumeLiveUpdates) {
      input.startLiveUpdates({
        runId: currentRunId,
        cursor: observed.replay?.cursor.token,
        conversationId: observed.conversation?.conversationId ?? input.app.conversation?.conversationId,
        epoch: input.viewEpochRef.current,
      });
    }
    void input.refreshConversations();
  } catch (error) {
    if (isStaleConfirmationError(error)) {
      await refreshRunAfterConfirmationSettled({
        runId: currentRunId,
        preferredConversation: input.app.conversation,
        mountedRef: input.mountedRef,
        setApp: input.setApp,
        refreshConversations: input.refreshConversations,
      });
      return;
    }
    input.setApp((previous) => ({
      ...previous,
      error: `提交失败：${error instanceof Error ? error.message : "请重试。"}`,
    }));
  } finally {
    input.setConfirmationBusy(false);
  }
}

function pendingConfirmationFromApp(app: AppState) {
  return app.workView?.pendingConfirmation;
}

function localConfirmationDecisionError(
  decision: ConfirmationDecision,
  resumeAvailability: "live" | "lost_after_restart" | undefined,
  guidance: string | undefined
): string | undefined {
  if (decision === "approve_once" && resumeAvailability === "lost_after_restart") {
    return "这次操作无法原地继续。请发送新消息，让我基于当前上下文继续。";
  }
  if (decision === "guidance" && (guidance ?? "").trim().length === 0) {
    return "请先输入补充要求，再提交。";
  }
  return undefined;
}

async function refreshRunAfterConfirmationSettled(input: {
  readonly runId: string;
  readonly preferredConversation?: AppState["conversation"];
  readonly mountedRef: { readonly current: boolean };
  readonly setApp: SetApp;
  readonly refreshConversations: () => Promise<void>;
}): Promise<void> {
  const observed = await loadObservedRunReadModel({
    runId: input.runId,
    conversationId: input.preferredConversation?.conversationId,
    preferredConversation: input.preferredConversation,
    requireFreshRunView: true,
  });
  if (!input.mountedRef.current) return;
  input.setApp((previous) => {
    const readModel = createRunReadModelPatch(previous, {
      runId: input.runId,
      workView: observed.workView,
      detail: observed.detail,
      reusePreviousWorkView: false,
    });
    const capabilityState = nextRunCapabilityState(previous, {
      runId: input.runId,
      capabilityResolution: observed.capabilityResolution,
    });
    return {
      ...previous,
      ...capabilityState,
      conversation: observed.conversation ?? previous.conversation,
      run: observed.run ?? previous.run,
      error: undefined,
      ...readModel,
    };
  });
  void input.refreshConversations();
}

function isStaleConfirmationError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "ordinary_confirmation_not_found";
}
