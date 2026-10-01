import { ApiError, postJson } from "../../../api";
import { loadObservedRunReadModel } from "./observed-run-read-model";
import { createRunReadModelPatch } from "./projection";
import { shouldKeepRefreshing } from "./runtime-controls";
import type { AppState } from "../../../workbench/state";
import { emptyLiveRun } from "@panel-api/ui-read-model";
import { nextRunCapabilityState } from "./capability-state";
import type { LiveRunSubscription } from "./live-run-updates";
import type { OrdinaryRun } from "../../../contracts/run";
import { createRunObservationGuard } from "./observation-state";

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
  readonly activeRunIdRef: { readonly current: string | undefined };
  readonly viewEpochRef: { readonly current: number };
  readonly refreshConversations: () => Promise<void>;
  readonly startLiveUpdates: (input: LiveRunSubscription) => void;
}): Promise<void> {
  const confirmation = pendingConfirmationFromApp(input.app);
  if (input.currentRunId === undefined || confirmation === undefined || input.confirmationBusy) return;
  const currentRunId = input.currentRunId;
  const guard = createRunObservationGuard(input, {
    runId: currentRunId,
    conversationId: input.app.conversation?.conversationId,
    epoch: input.viewEpochRef.current,
  });
  if (!guard.isCurrent(input.app)) return;
  const showFailure = (error: unknown): void => {
    if (!guard.isCurrent()) return;
    input.setApp((previous) => guard.isCurrent(previous) ? {
      ...previous,
      error: `提交失败：${error instanceof Error ? error.message : "请重试。"}`,
    } : previous);
  };
  if (input.app.run?.status !== "approval_needed") {
    await refreshRunAfterConfirmationSettled({
      runId: currentRunId,
      preferredConversation: input.app.conversation,
      guard,
      setApp: input.setApp,
      refreshConversations: input.refreshConversations,
    }).catch(showFailure);
    return;
  }
  const localError = localConfirmationDecisionError(input.decision, confirmation.resumeAvailability, input.guidance);
  if (localError !== undefined) {
    input.setApp((previous) => guard.isCurrent(previous) ? { ...previous, error: localError } : previous);
    return;
  }
  input.setConfirmationBusy(true);
  input.setApp((previous) => guard.isCurrent(previous) ? { ...previous, error: undefined } : previous);

  try {
    const response = await postJson<{ readonly run: OrdinaryRun }>(
      `/api/ordinary/runs/${encodeURIComponent(currentRunId)}/confirmations/${encodeURIComponent(confirmation.confirmationId)}/decision`,
      { decision: input.decision, guidance: input.guidance?.trim() }
    );
    if (!guard.isCurrent()) return;
    const observed = await loadObservedRunReadModel({
      runId: currentRunId,
      conversationId: response.run.conversationId,
      preferredConversation: input.app.conversation,
      requireFreshRunView: true,
    });
    if (!guard.isCurrent()) return;
    const observedRun = observed.run ?? response.run;
    const shouldResumeLiveUpdates = shouldKeepRefreshing(observedRun.status);
    input.setApp((previous) => {
      if (!guard.isCurrent(previous)) return previous;
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
        epoch: guard.identity.epoch,
      });
    }
    void input.refreshConversations();
  } catch (error) {
    if (!guard.isCurrent()) return;
    if (isStaleConfirmationError(error)) {
      await refreshRunAfterConfirmationSettled({
        runId: currentRunId,
        preferredConversation: input.app.conversation,
        guard,
        setApp: input.setApp,
        refreshConversations: input.refreshConversations,
      }).catch(showFailure);
      return;
    }
    showFailure(error);
  } finally {
    // The setter releases only this captured request's pending marker, even
    // after navigation; it cannot clear a newer conversation's approval.
    if (input.mountedRef.current) input.setConfirmationBusy(false);
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
  readonly guard: ReturnType<typeof createRunObservationGuard>;
  readonly setApp: SetApp;
  readonly refreshConversations: () => Promise<void>;
}): Promise<void> {
  if (!input.guard.isCurrent()) return;
  const observed = await loadObservedRunReadModel({
    runId: input.runId,
    conversationId: input.preferredConversation?.conversationId,
    preferredConversation: input.preferredConversation,
    requireFreshRunView: true,
  });
  if (!input.guard.isCurrent()) return;
  input.setApp((previous) => {
    if (!input.guard.isCurrent(previous)) return previous;
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
