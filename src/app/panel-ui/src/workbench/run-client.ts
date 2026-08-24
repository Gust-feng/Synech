import { ApiError, getJson } from "../api";
import type { Conversation } from "../contracts/conversation";
import type { OrdinaryRunView, OrdinaryWorkView, OrdinaryRunCursor, RunEvent } from "../contracts/run";
import { ordinaryRunResourceUrl } from "../features/conversations/run/request";

const BASIC_RUN_EVENT_TYPES = [
  "run.started",
  "run.resumed",
  "run.blocked",
  "run.cancelled",
  "run.failed",
  "final.result",
  "tool.requested",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "tool.cancelled",
  "confirmation.needed",
  "user_approval.received",
  "user.guidance",
  "agent.note.delta",
  "agent.note.completed",
  "model.reasoning.delta",
  "model.reasoning.completed",
  "model.output.delta",
  "model.output.completed",
  "model.side.completed",
  "model.failed",
  "context.compaction.requested",
  "context.compaction.completed",
  "context.compaction.failed",
] as const;

export async function safeOrdinaryRunView(
  runId: string,
  cursor?: OrdinaryRunCursor,
  init?: RequestInit
): Promise<OrdinaryRunView | undefined> {
  try {
    return (await getJson<{ readonly view: OrdinaryRunView }>(
      ordinaryRunResourceUrl(runId, "view", cursor),
      init
    )).view;
  } catch (error) {
    if (isMissingRead(error, "run_not_found")) return undefined;
    throw error;
  }
}

export async function safeConversation(conversationId: string, init?: RequestInit): Promise<Conversation | undefined> {
  try {
    return (await getJson<{ readonly conversation: Conversation }>(
      `/api/conversations/${encodeURIComponent(conversationId)}`,
      init
    )).conversation;
  } catch (error) {
    if (isMissingRead(error, "conversation_not_found")) return undefined;
    throw error;
  }
}

function isMissingRead(error: unknown, code: string): boolean {
  return error instanceof ApiError && (error.code === code || error.status === 404);
}

export function ordinaryWorkViewFromRunView(
  view: {
    readonly workView?: OrdinaryWorkView;
  } | undefined
): OrdinaryWorkView | undefined {
  return view?.workView;
}

export function openOrdinaryRunStream(input: {
  readonly runId: string;
  readonly cursor?: OrdinaryRunCursor;
  readonly onEvent: (event: RunEvent, cursor: OrdinaryRunCursor) => void;
  readonly onReset: (cursor: OrdinaryRunCursor) => void;
  readonly onHeartbeat?: () => void;
  readonly onError: () => void;
}): EventSource | undefined {
  if (typeof EventSource === "undefined") {
    return undefined;
  }
  const stream = new EventSource(ordinaryRunResourceUrl(input.runId, "stream", input.cursor));
  const handle = (message: MessageEvent<string>): void => {
    try {
      if (message.lastEventId.length === 0) throw new Error("Missing event cursor");
      input.onEvent(JSON.parse(message.data) as RunEvent, message.lastEventId);
    } catch {
      input.onError();
    }
  };
  for (const type of BASIC_RUN_EVENT_TYPES) {
    stream.addEventListener(type, handle as EventListener);
  }
  stream.addEventListener("run.stream.reset", ((message: MessageEvent<string>) => {
    try {
      const value = JSON.parse(message.data) as { readonly cursor?: unknown };
      if (typeof value.cursor !== "string" || value.cursor.length === 0) throw new Error("Missing reset cursor");
      input.onReset(value.cursor);
    } catch {
      input.onError();
    }
  }) as EventListener);
  stream.addEventListener("run.stream.heartbeat", (() => {
    input.onHeartbeat?.();
  }) as EventListener);
  stream.onerror = () => {
    stream.close();
    input.onError();
  };
  return stream;
}
