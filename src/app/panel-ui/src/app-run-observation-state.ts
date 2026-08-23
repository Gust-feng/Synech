import {
  canApplyRunSubscriptionToState,
  createAppendOnlyRunEventBatcher,
  mergeRunEvents,
  stateWithConversationGuard,
  stateWithAppendOnlyRunEvent,
  stateWithAppendOnlyRunEvents,
  stateWithObservedRunEvent,
  stateWithObservedRunEvents,
  stateWithObservedRunProjection,
} from "../../panel-read-model/run/panel-run-observation-state";
import { nextRunCapabilityState } from "./run-capability-state";
import type { AppState } from "./app-state";
import type {
  OrdinaryRun,
  OrdinaryRunDetail,
  OrdinaryWorkView,
  RunCapabilityResolution,
  RunEvent,
} from "./contracts/run";

export { mergeRunEvents };
export { createAppendOnlyRunEventBatcher };

export function canApplyRunSubscriptionToAppState(input: {
  readonly previous: Pick<AppState, "conversation">;
  readonly activeRunId: string | undefined;
  readonly currentEpoch: number;
  readonly runId: string;
  readonly conversationId?: string;
  readonly epoch: number;
}): boolean {
  return canApplyRunSubscriptionToState(input);
}

export function appStateWithSettledConversationGuard(
  previous: AppState,
  input: {
    readonly expectedConversationId?: string;
    readonly next: AppState;
  }
): AppState {
  return stateWithConversationGuard(previous, input);
}

export function appStateWithObservedRunEvents(
  previous: AppState,
  input: {
    readonly runId: string;
    readonly events: readonly RunEvent[];
  }
): AppState {
  return stateWithObservedRunEvents(previous, input);
}

export function appStateWithObservedRunProjection(
  previous: AppState,
  input: {
    readonly runId: string;
    readonly run?: OrdinaryRun;
    readonly events?: readonly RunEvent[];
    readonly workView?: OrdinaryWorkView;
    readonly capabilityResolution?: RunCapabilityResolution;
    readonly detail?: OrdinaryRunDetail;
    readonly reset?: boolean;
  }
): AppState {
  return {
    ...stateWithObservedRunProjection(previous, input),
    ...nextCapabilityResolutionState(previous, input.runId, input.capabilityResolution),
    // 运行视图读取成功即代表恢复：清除同一数据源此前写入的全局错误提示，
    // 避免「读取运行视图失败」等瞬时错误在 run 结束后永久停留在右下角。
    error: undefined,
  };
}

export function appStateWithObservedRunEvent(
  previous: AppState,
  input: {
    readonly runId: string;
    readonly event: RunEvent;
    readonly run?: OrdinaryRun;
    readonly workView?: OrdinaryWorkView;
    readonly capabilityResolution?: RunCapabilityResolution;
    readonly detail?: OrdinaryRunDetail;
  }
): AppState {
  return {
    ...stateWithObservedRunEvent(previous, input),
    ...nextCapabilityResolutionState(previous, input.runId, input.capabilityResolution),
    error: undefined,
  };
}

export function appStateWithAppendOnlyRunEvent(
  previous: AppState,
  input: {
    readonly runId: string;
    readonly event: RunEvent;
  }
): AppState {
  return stateWithAppendOnlyRunEvent(previous, input);
}

export function appStateWithAppendOnlyRunEvents(
  previous: AppState,
  input: {
    readonly runId: string;
    readonly events: readonly RunEvent[];
  }
): AppState {
  return {
    ...stateWithAppendOnlyRunEvents(previous, input),
    // 事件仍在持续送达说明流连接已恢复，同步清除之前的全局错误提示。
    error: undefined,
  };
}

function nextCapabilityResolutionState(
  previous: AppState,
  runId: string,
  incoming: RunCapabilityResolution | undefined
): Pick<AppState, "capabilityResolution" | "capabilityResolutionRunId"> {
  return nextRunCapabilityState(previous, { runId, capabilityResolution: incoming });
}
