import {
  appendLiveRunEvents,
  type LiveRunBuffer,
} from "../../panel-read-model/run/panel-run-live-buffer.js";

export type SubmitFlowTaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "needs_input"
  | "approval_needed"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type StartedConversationRun = {
  readonly runId: string;
  readonly status?: SubmitFlowTaskStatus | "pending";
  readonly runMode?: "agent";
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly eventCursor?: {
    readonly lastSequence?: number;
    readonly eventCount?: number;
  };
};

export type SubmitFlowConversationTurnAttachment = {
  readonly attachmentId: string;
  readonly kind: "workspace" | "file" | "project" | "web";
  readonly title: string;
  readonly summary?: string;
  readonly readonlyPreviewMeta?: {
    readonly available?: boolean;
    readonly title?: string;
    readonly byteLength?: number;
    readonly mimeType?: string;
    readonly truncated?: boolean;
  };
  readonly mediaPreview?: {
    readonly kind: "image";
    readonly url: string;
    readonly mimeType: string;
    readonly byteLength?: number;
  };
};

export type SubmitFlowConversationTurn = {
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly title?: string;
  readonly content: string;
  readonly status: string;
  readonly runId?: string;
  readonly attachments?: readonly SubmitFlowConversationTurnAttachment[];
};

export type SubmitFlowConversation = {
  readonly conversationId: string;
  readonly title: string;
  readonly turns: readonly SubmitFlowConversationTurn[];
  readonly activeRunId?: string;
  readonly latestRunId?: string;
  readonly queuedRunIds?: readonly string[];
  readonly updatedAt?: string;
};

export type SubmitFlowOrdinaryRun = {
  readonly runId: string;
  readonly title: string;
  readonly goalSummary: string;
  readonly status: SubmitFlowTaskStatus;
  readonly runMode: "agent";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requiresUserAction: boolean;
  readonly eventCursor: {
    readonly lastSequence: number;
    readonly eventCount: number;
  };
};

export type SubmitFlowRunEvent = {
  readonly id: string;
  readonly runId?: string;
  readonly sequence: number;
  readonly type?: string;
  readonly delta?: string;
  readonly summary?: string;
  readonly refs?: readonly {
    readonly kind: string;
    readonly id: string;
  }[];
};

export function runIdToObserveAfterStart(input: {
  readonly conversation: SubmitFlowConversation;
  readonly responseRunId: string;
  readonly responseStatus: SubmitFlowTaskStatus | "pending" | undefined;
  readonly fetchedStatus: SubmitFlowTaskStatus | undefined;
  readonly previousObservedRunId: string | undefined;
}): string | undefined {
  const queuedRunIds = input.conversation.queuedRunIds ?? [];
  const responseIsQueued = input.fetchedStatus === undefined
    ? input.responseStatus === "queued" ||
      (queuedRunIds.includes(input.responseRunId) && input.conversation.activeRunId !== input.responseRunId)
    : input.fetchedStatus === "queued";
  if (!responseIsQueued) {
    return input.responseRunId;
  }
  return input.conversation.activeRunId ?? input.previousObservedRunId;
}

export function immediateRunForStartedConversation(input: {
  readonly previousRun: SubmitFlowOrdinaryRun | undefined;
  readonly responseRun: StartedConversationRun;
  readonly observedRunId: string | undefined;
  readonly goal: string;
  readonly now?: string;
}): SubmitFlowOrdinaryRun | undefined {
  if (input.observedRunId === undefined) {
    return undefined;
  }
  if (input.previousRun?.runId === input.observedRunId && input.observedRunId !== input.responseRun.runId) {
    return input.previousRun;
  }
  if (input.observedRunId !== input.responseRun.runId) {
    return undefined;
  }
  const now = input.now ?? new Date().toISOString();
  return {
    runId: input.responseRun.runId,
    title: input.goal,
    goalSummary: input.goal,
    status: taskStatusFromStartedRun(input.responseRun.status),
    runMode: "agent",
    createdAt: input.responseRun.createdAt ?? now,
    updatedAt: input.responseRun.updatedAt ?? now,
    requiresUserAction: false,
    eventCursor: {
      lastSequence: input.responseRun.eventCursor?.lastSequence ?? 0,
      eventCount: input.responseRun.eventCursor?.eventCount ?? 0,
    },
  };
}

export function optimisticConversationForSubmit(
  conversation: SubmitFlowConversation | undefined,
  goal: string,
  now = new Date().toISOString(),
  attachments?: readonly SubmitFlowConversationTurnAttachment[]
): SubmitFlowConversation {
  const userTurn = {
    turnId: `optimistic-user-${now}`,
    role: "user" as const,
    title: "你的消息",
    content: goal,
    status: "completed",
    attachments,
  };
  const assistantTurn = {
    turnId: `optimistic-assistant-${now}`,
    role: "assistant" as const,
    title: "",
    content: "",
    status: "running",
  };
  if (conversation === undefined) {
    return {
      conversationId: `optimistic-conversation-${now}`,
      title: goal,
      turns: [userTurn, assistantTurn],
      updatedAt: now,
    };
  }
  return {
    ...conversation,
    turns: [...conversation.turns, userTurn, assistantTurn],
    updatedAt: now,
  };
}

export function mergeObservedRunEvents<TEvent extends SubmitFlowRunEvent>(input: {
  readonly previousRunId: string | undefined;
  readonly observedRunId: string | undefined;
  readonly previousEvents: readonly TEvent[];
  readonly replayEvents: readonly TEvent[];
}): readonly TEvent[] {
  if (input.observedRunId === undefined) {
    return [];
  }
  if (input.previousRunId !== input.observedRunId) {
    return input.replayEvents;
  }
  const byId = new Map<string, TEvent>();
  for (const event of input.previousEvents) byId.set(event.id, event);
  for (const event of input.replayEvents) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

export function liveRunForObservedReplay(input: {
  readonly observedRunId: string | undefined;
  readonly observedRun: SubmitFlowOrdinaryRun | undefined;
  readonly previousLive: LiveRunBuffer | undefined;
  readonly replayEvents: readonly SubmitFlowRunEvent[];
}): LiveRunBuffer | undefined {
  if (input.observedRunId === undefined || input.observedRun === undefined) {
    return undefined;
  }
  const replayEvents = input.replayEvents.map((event) => ({
    ...event,
    runId: event.runId ?? input.observedRunId!,
    type: event.type ?? "",
    refs: event.refs ?? [],
  }));
  const live = appendLiveRunEvents(input.observedRunId, input.previousLive, replayEvents);
  if (shouldKeepSubmitFlowRefreshing(input.observedRun.status)) {
    return live;
  }
  return undefined;
}

function taskStatusFromStartedRun(status: SubmitFlowTaskStatus | "pending" | undefined): SubmitFlowTaskStatus {
  if (status === "pending") {
    return "queued";
  }
  return status ?? "running";
}

function shouldKeepSubmitFlowRefreshing(status: SubmitFlowTaskStatus): boolean {
  return status === "queued" || status === "planning" || status === "running";
}