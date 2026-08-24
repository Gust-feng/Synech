import { appendLiveRunEvents } from "../../../../../panel-api/ui-read-model";
import { nextRunCapabilityState } from "./capability-state.js";
import { loadObservedRunReadModel } from "./observed-run-read-model.js";
import { createRunReadModelPatch } from "./projection.js";
import { shouldKeepRefreshing } from "./runtime-controls.js";
import type { AppState } from "../../../workbench/state";
import type {
  OrdinaryRunReplay,
  OrdinaryRun,
  OrdinaryRunDetail,
  OrdinaryWorkView,
  OrdinaryRunCursor,
  RunCapabilityResolution,
} from "../../../contracts/run";
import type { Conversation } from "../../../contracts/conversation";
import { ordinaryWorkViewFromRunView, safeOrdinaryRunView, safeConversation } from "../../../workbench/run-client.js";

export type FollowUpActiveRunProjection = {
  readonly conversation?: Conversation;
  readonly run?: OrdinaryRun;
  readonly replay?: OrdinaryRunReplay;
  readonly workView?: OrdinaryWorkView;
  readonly capabilityResolution?: RunCapabilityResolution;
  readonly detail?: OrdinaryRunDetail;
};

export type SettledRunProjection = {
  readonly runId: string;
  readonly run: OrdinaryRun;
  readonly workView?: OrdinaryWorkView;
  readonly capabilityResolution?: RunCapabilityResolution;
  readonly detail?: OrdinaryRunDetail;
  readonly conversation?: Conversation;
  readonly followUp: FollowUpActiveRunProjection;
};

export async function loadSettledRunProjection(input: {
  readonly runId: string;
  readonly run: OrdinaryRun;
  readonly workView?: OrdinaryWorkView;
  readonly capabilityResolution?: RunCapabilityResolution;
}): Promise<SettledRunProjection> {
  const [view, conversation] = await Promise.all([
    safeOrdinaryRunView(input.runId),
    input.run.conversationId === undefined ? undefined : safeConversation(input.run.conversationId),
  ]);
  return {
    runId: input.runId,
    run: view?.run ?? input.run,
    workView: ordinaryWorkViewFromRunView(view) ?? input.workView,
    capabilityResolution: view?.capabilityResolution,
    detail: view?.detail,
    conversation,
    followUp: await loadFollowUpActiveRunProjection(conversation, input.runId),
  };
}

export function appStateWithSettledRunProjection(
  previous: AppState,
  settled: SettledRunProjection
): AppState {
  if (settled.followUp.run !== undefined) {
    return appStateWithFollowUpActiveRun(previous, settled.followUp);
  }
  const readModel = createRunReadModelPatch(previous, {
    runId: settled.runId,
    workView: settled.workView,
    detail: settled.detail,
  });
  const capabilityState = nextRunCapabilityState(previous, {
    runId: settled.runId,
    capabilityResolution: settled.capabilityResolution,
  });
  return {
    ...previous,
    ...capabilityState,
    conversation: settled.conversation ?? previous.conversation,
    run: settled.run,
    live: undefined,
    ...readModel,
    // 结算读取成功即代表运行状态恢复，清除此前的全局错误提示（run-controller
    // 取消路径与 live 结算路径共用此入口）。
    error: undefined,
  };
}

export function refreshingFollowUpRun(
  settled: SettledRunProjection
): { readonly runId: string; readonly cursor?: OrdinaryRunCursor } | undefined {
  const followUp = settled.followUp;
  if (followUp.run === undefined || !shouldKeepRefreshing(followUp.run.status)) {
    return undefined;
  }
  return {
    runId: followUp.run.runId,
    cursor: followUp.replay?.cursor.token,
  };
}

async function loadFollowUpActiveRunProjection(
  conversation: Conversation | undefined,
  completedRunId: string
): Promise<FollowUpActiveRunProjection> {
  const runId = followUpActiveRunId(conversation, completedRunId);
  if (runId === undefined) {
    return { conversation };
  }
  const currentRun = conversation?.currentRun;
  if (currentRun?.run.runId === runId) {
    return {
      conversation,
      run: currentRun.run,
      replay: currentRun.replay,
      workView: ordinaryWorkViewFromRunView(currentRun),
      capabilityResolution: currentRun.capabilityResolution,
      detail: currentRun.detail,
    };
  }
  const observed = await loadObservedRunReadModel({
    runId,
    conversationId: conversation?.conversationId,
    preferredConversation: conversation,
  });
  return {
    conversation: observed.conversation ?? conversation,
    run: observed.run,
    replay: observed.replay,
    workView: observed.workView,
    capabilityResolution: observed.capabilityResolution,
    detail: observed.detail,
  };
}

function appStateWithFollowUpActiveRun(
  previous: AppState,
  followUp: FollowUpActiveRunProjection
): AppState {
  if (followUp.run === undefined) {
    return previous;
  }
  const readModel = createRunReadModelPatch(previous, {
    runId: followUp.run.runId,
    workView: followUp.workView,
    detail: followUp.detail,
  });
  const capabilityState = nextRunCapabilityState(previous, {
    runId: followUp.run.runId,
    capabilityResolution: followUp.capabilityResolution,
  });
  return {
    ...previous,
    ...capabilityState,
    conversation: followUp.conversation ?? previous.conversation,
    run: followUp.run,
    events: followUp.replay?.events ?? [],
    live: shouldKeepRefreshing(followUp.run.status)
      ? appendLiveRunEvents(followUp.run.runId, undefined, followUp.replay?.events ?? [])
      : undefined,
    ...readModel,
    error: undefined,
  };
}

function followUpActiveRunId(
  conversation: Conversation | undefined,
  completedRunId: string
): string | undefined {
  const activeRunId = conversation?.activeRunId;
  if (activeRunId === undefined || activeRunId === completedRunId) {
    return undefined;
  }
  return activeRunId;
}
