import {
  appendLiveRunEvent,
  appendLiveRunEvents,
  type LiveRunBuffer,
} from "./panel-run-live-buffer.js";
import {
  createRunReadModelPatch,
  detailForRun,
  type RunProjectionDetail,
  type RunProjectionNode,
  type RunProjectionWorkView,
} from "./panel-run-projection.js";

export type RunObservationEvent = {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: string;
  readonly delta?: string;
  readonly summary?: string;
  readonly refs: readonly {
    readonly kind: string;
    readonly id: string;
  }[];
  readonly detail?: {
    readonly preview?: string;
  };
};

export type RunObservationState<
  TRun,
  TEvent extends RunObservationEvent,
  TWorkView extends RunProjectionWorkView<TNode>,
  TDetail extends RunProjectionDetail<TNode>,
  TNode extends RunProjectionNode
> = {
  readonly run?: TRun;
  readonly workView?: TWorkView;
  readonly transcriptNodes: readonly TNode[];
  readonly transcriptNodesByRunId: Record<string, readonly TNode[]>;
  readonly events: readonly TEvent[];
  readonly live?: LiveRunBuffer;
  readonly detail?: TDetail;
};

export function mergeRunEvents<TEvent extends RunObservationEvent>(
  previous: readonly TEvent[],
  incoming: readonly TEvent[]
): readonly TEvent[] {
  const byId = new Map<string, TEvent>();
  for (const event of previous) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

export function canApplyRunSubscriptionToState(input: {
  readonly previous: {
    readonly conversation?: {
      readonly conversationId: string;
    };
  };
  readonly activeRunId: string | undefined;
  readonly currentEpoch: number;
  readonly runId: string;
  readonly conversationId?: string;
  readonly epoch: number;
}): boolean {
  return input.activeRunId === input.runId &&
    input.currentEpoch === input.epoch &&
    input.previous.conversation?.conversationId === input.conversationId;
}

export function stateWithConversationGuard<TState>(
  previous: TState & {
    readonly conversation?: {
      readonly conversationId: string;
    };
  },
  input: {
    readonly expectedConversationId?: string;
    readonly next: TState;
  }
): TState {
  return previous.conversation?.conversationId === input.expectedConversationId
    ? input.next
    : previous;
}

export function stateWithObservedRunEvents<
  TNode extends RunProjectionNode,
  TRun,
  TEvent extends RunObservationEvent,
  TWorkView extends RunProjectionWorkView<TNode>,
  TDetail extends RunProjectionDetail<TNode>,
  TState extends RunObservationState<TRun, TEvent, TWorkView, TDetail, TNode>
>(
  previous: TState,
  input: {
    readonly runId: string;
    readonly events: readonly TEvent[];
  }
): TState {
  if (input.events.length === 0) {
    return previous;
  }
  return {
    ...previous,
    live: appendLiveRunEvents(input.runId, previous.live, input.events),
    events: mergeRunEvents(previous.events, input.events),
  };
}

export function stateWithObservedRunProjection<
  TNode extends RunProjectionNode,
  TRun,
  TEvent extends RunObservationEvent,
  TWorkView extends RunProjectionWorkView<TNode>,
  TDetail extends RunProjectionDetail<TNode>,
  TState extends RunObservationState<TRun, TEvent, TWorkView, TDetail, TNode>
>(
  previous: TState,
  input: {
    readonly runId: string;
    readonly run?: TRun;
    readonly events?: readonly TEvent[];
    readonly workView?: TWorkView;
    readonly detail?: TDetail;
    /** Replace the current run's volatile observation buffer after a backend stream generation reset. */
    readonly reset?: boolean;
  }
): TState {
  const events = input.events ?? [];
  const priorLive = input.reset === true ? undefined : previous.live;
  const priorEvents = input.reset === true ? [] : previous.events;
  const readModel = createRunReadModelPatch(previous, {
    runId: input.runId,
    workView: input.workView,
    detail: input.detail ?? detailForRun(input.runId, previous.detail),
  });
  return {
    ...previous,
    run: input.run ?? previous.run,
    live: events.length === 0
      ? priorLive
      : appendLiveRunEvents(input.runId, priorLive, events),
    events: events.length === 0
      ? priorEvents
      : mergeRunEvents(priorEvents, events),
    ...readModel,
  };
}

export function stateWithObservedRunEvent<
  TNode extends RunProjectionNode,
  TRun,
  TEvent extends RunObservationEvent,
  TWorkView extends RunProjectionWorkView<TNode>,
  TDetail extends RunProjectionDetail<TNode>,
  TState extends RunObservationState<TRun, TEvent, TWorkView, TDetail, TNode>
>(
  previous: TState,
  input: {
    readonly runId: string;
    readonly event: TEvent;
    readonly run?: TRun;
    readonly workView?: TWorkView;
    readonly detail?: TDetail;
  }
): TState {
  return stateWithObservedRunProjection(previous, {
    runId: input.runId,
    run: input.run,
    events: [input.event],
    workView: input.workView,
    detail: input.detail,
  });
}

export function stateWithAppendOnlyRunEvent<
  TNode extends RunProjectionNode,
  TRun,
  TEvent extends RunObservationEvent,
  TWorkView extends RunProjectionWorkView<TNode>,
  TDetail extends RunProjectionDetail<TNode>,
  TState extends RunObservationState<TRun, TEvent, TWorkView, TDetail, TNode>
>(
  previous: TState,
  input: {
    readonly runId: string;
    readonly event: TEvent;
  }
): TState {
  return {
    ...previous,
    live: appendLiveRunEvent(input.runId, previous.live, input.event),
  };
}

export function stateWithAppendOnlyRunEvents<
  TNode extends RunProjectionNode,
  TRun,
  TEvent extends RunObservationEvent,
  TWorkView extends RunProjectionWorkView<TNode>,
  TDetail extends RunProjectionDetail<TNode>,
  TState extends RunObservationState<TRun, TEvent, TWorkView, TDetail, TNode>
>(
  previous: TState,
  input: {
    readonly runId: string;
    readonly events: readonly TEvent[];
  }
): TState {
  if (input.events.length === 0) {
    return previous;
  }
  return {
    ...previous,
    live: appendLiveRunEvents(input.runId, previous.live, input.events),
  };
}

export type AppendOnlyRunEventBatcher<TItem> = {
  readonly enqueue: (item: TItem) => void;
  readonly flush: () => void;
  readonly clear: () => void;
  readonly pendingCount: () => number;
};

export function createAppendOnlyRunEventBatcher<TItem>(input: {
  readonly schedule: (flush: () => void) => (() => void) | undefined;
  readonly apply: (items: readonly TItem[]) => void;
}): AppendOnlyRunEventBatcher<TItem> {
  let pending: TItem[] = [];
  let scheduled = false;
  let cancelScheduled: (() => void) | undefined;

  const applyPending = (): void => {
    if (pending.length === 0) {
      return;
    }
    const items = pending;
    pending = [];
    input.apply(items);
  };

  const runScheduledFlush = (): void => {
    scheduled = false;
    cancelScheduled = undefined;
    applyPending();
  };

  const requestFlush = (): void => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    cancelScheduled = input.schedule(runScheduledFlush);
  };

  return {
    enqueue(event): void {
      pending = [...pending, event];
      requestFlush();
    },
    flush(): void {
      cancelScheduled?.();
      scheduled = false;
      cancelScheduled = undefined;
      applyPending();
    },
    clear(): void {
      cancelScheduled?.();
      scheduled = false;
      cancelScheduled = undefined;
      pending = [];
    },
    pendingCount(): number {
      return pending.length;
    },
  };
}
