import { sanitizeFailureCopy } from "./panel-assistant-visible-text.js";

export type AssistantFailureParts = {
  readonly code: string;
  readonly error: string;
};

export type AssistantFailureFact = {
  readonly code: string;
  readonly message: string;
};

export type AssistantTerminalStatus = "failed" | "blocked" | "cancelled";

export function assistantTerminalStatus(status: string): AssistantTerminalStatus | undefined {
  switch (status) {
    case "failed":
    case "blocked":
    case "cancelled":
      return status;
    default:
      return undefined;
  }
}

export function assistantTerminalNoticeTitle(status: AssistantTerminalStatus): string | undefined {
  switch (status) {
    case "blocked": return "需要处理";
    case "cancelled": return "已取消";
    case "failed": return undefined;
  }
}

export type FailureEchoTranscriptNode = {
  readonly nodeId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly kind: "thinking" | "tool" | "confirmation" | "user_decision" | "answer" | "body" | "system";
  readonly phase:
    | "noted"
    | "preparing"
    | "waiting_approval"
    | "approved"
    | "denied"
    | "guidance"
    | "executing"
    | "completed"
    | "failed"
    | "blocked"
    | "cancelled";
  readonly text?: string;
  readonly summary?: string;
  readonly title: string;
  readonly timestamp: string;
  readonly refs: readonly {
    readonly kind: string;
    readonly id: string;
    readonly label?: string;
  }[];
};

export function assistantFailureParts(failure: AssistantFailureFact | undefined): AssistantFailureParts | undefined {
  if (failure === undefined) return undefined;
  return { code: failure.code, error: sanitizeFailureCopy(failure.message) };
}

export function transcriptNodesWithoutFailureEcho<TNode extends FailureEchoTranscriptNode>(
  nodes: readonly TNode[] | undefined,
  terminalStatus: AssistantTerminalStatus | undefined,
): readonly TNode[] | undefined {
  if (nodes === undefined || terminalStatus === undefined) return nodes;
  const terminalEventType = `run.${terminalStatus}`;
  const filtered = nodes.filter((node) => !(node.kind === "system" && node.eventType === terminalEventType));
  return filtered.length === nodes.length ? nodes : filtered;
}
