import type { ToolCallResult } from "../../domain/tools/index.js";
import type {
  AgentSessionAssistantEntry,
  AgentSessionEntryRef,
} from "../model-runtime/agent-session.js";
import type {
  OrdinaryRunActivity,
  OrdinaryRunActivityCursor,
  OrdinaryRunActivityReplay,
  OrdinaryRunEvent,
  OrdinaryRunState,
} from "./contracts.js";
import { ordinaryToolResultKey } from "./state.js";

export function ordinaryRunActivityCursor(stream: {
  readonly streamId: string;
  readonly nextSequence: number;
}): OrdinaryRunActivityCursor {
  return { streamId: stream.streamId, sequence: stream.nextSequence - 1 };
}

export function durableOrdinaryRunReplayFromState(
  run: OrdinaryRunState,
  assistantEntries: readonly AgentSessionAssistantEntry[],
): OrdinaryRunActivityReplay {
  const assistantTextByEntryId = new Map(assistantEntries.map((entry) =>
    [sessionEntryKey(entry.entryRef), entry.text] as const));
  const activities = durableActivities(
    run.runId,
    run.timeline,
    run.toolCalls,
    run.toolResultRecordedAt,
    assistantTextByEntryId,
  );
  const lastEventId = run.timeline.at(-1)?.eventId ?? "initial";
  return {
    cursor: {
      streamId: `ordinary-command-response:${run.runId}:${lastEventId}`,
      sequence: activities.length,
    },
    reset: false,
    activities,
  };
}

function durableActivities(
  runId: string,
  events: readonly OrdinaryRunEvent[],
  toolResults: readonly ToolCallResult[],
  toolResultRecordedAt: Readonly<Record<string, string>>,
  assistantTextByEntryId: ReadonlyMap<string, string>,
): OrdinaryRunActivity[] {
  const pending: Array<{
    readonly recordedAt: string;
    readonly priority: number;
    readonly insertion: number;
    readonly activity: OrdinaryRunActivity;
  }> = [];
  for (const [insertion, event] of events.entries()) {
    if (event.type === "model.output.completed") {
      const content = assistantTextByEntryId.get(sessionEntryKey(event.assistantEntryRef));
      if (content === undefined) continue;
      pending.push({
        recordedAt: event.recordedAt,
        priority: 1,
        insertion,
        activity: {
          activityId: `transition:${event.eventId}`,
          runId,
          sequence: 0,
          recordedAt: event.recordedAt,
          type: "model.output.completed",
          durability: "durable",
          modelRequestId: event.modelRequestId,
          assistantEntryRef: structuredClone(event.assistantEntryRef),
          content,
        },
      });
      continue;
    }
    pending.push({
      recordedAt: event.recordedAt,
      priority: 1,
      insertion,
      activity: {
        activityId: `transition:${event.eventId}`,
        runId,
        sequence: 0,
        recordedAt: event.recordedAt,
        type: "run.transition",
        durability: "durable",
        event: structuredClone(event),
      },
    });
  }
  for (const [insertion, result] of toolResults.entries()) {
    if (result.status === "approval_required") continue;
    const recordedAt = toolResultRecordedAt[ordinaryToolResultKey(result)];
    if (recordedAt === undefined) continue;
    pending.push({
      recordedAt,
      priority: 0,
      insertion,
      activity: {
        activityId: `tool:${ordinaryToolResultKey(result)}`,
        runId,
        sequence: 0,
        recordedAt,
        type: "tool.result",
        durability: "durable",
        result: structuredClone(result),
      },
    });
  }

  // Reasoning and final output form one replay unit. Anchor both to the first
  // persisted timestamp, then keep reasoning before output within that unit.
  const messageStartAtByRequest = new Map<string, string>();
  for (const item of pending) {
    if (durableMessagePhase(item.activity) === undefined) continue;
    const requestId = durableModelRequestId(item.activity);
    if (requestId === undefined) continue;
    const current = messageStartAtByRequest.get(requestId);
    if (current === undefined || item.recordedAt.localeCompare(current) < 0) {
      messageStartAtByRequest.set(requestId, item.recordedAt);
    }
  }

  return pending
    .map((item) => {
      const phase = durableMessagePhase(item.activity);
      const requestId = durableModelRequestId(item.activity);
      return {
        item,
        sortAt: phase === undefined || requestId === undefined
          ? item.recordedAt
          : messageStartAtByRequest.get(requestId) ?? item.recordedAt,
        phase: phase ?? 0,
      };
    })
    .sort((left, right) => left.sortAt.localeCompare(right.sortAt) ||
      left.phase - right.phase ||
      left.item.priority - right.item.priority ||
      left.item.insertion - right.item.insertion)
    .map(({ item }, index) => ({ ...item.activity, sequence: index + 1 }));
}

function durableMessagePhase(activity: OrdinaryRunActivity): 0 | 1 | undefined {
  if (activity.type === "run.transition" && activity.event.type === "model.reasoning.completed") return 0;
  if (activity.type === "model.output.completed") return 1;
  return undefined;
}

function durableModelRequestId(activity: OrdinaryRunActivity): string | undefined {
  if (activity.type === "run.transition") {
    return "modelRequestId" in activity.event ? activity.event.modelRequestId : undefined;
  }
  return "modelRequestId" in activity ? activity.modelRequestId : undefined;
}

function sessionEntryKey(ref: AgentSessionEntryRef): string {
  return `${ref.sessionId}\u0000${ref.entryId}`;
}
