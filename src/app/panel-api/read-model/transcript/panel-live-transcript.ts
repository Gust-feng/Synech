import type { ModelUsage } from "../../../../domain/intelligence/index.js";
import type { ToolDisplayProjection } from "../../tool-display.js";
import type { LiveModelTurnBuffer, LiveRunBuffer, LiveToolActivity } from "../run/panel-run-live-buffer.js";
import {
  mergeTranscriptNodeLists,
} from "./panel-transcript-node-identity.js";

export type LiveTranscriptObservationRef = {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
};

export type LiveTranscriptNode = {
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
  readonly title: string;
  readonly summary?: string;
  readonly text?: string;
  readonly timestamp: string;
  readonly modelUsage?: ModelUsage;
  readonly toolName?: string;
  readonly parentToolCallFactId?: string;
  readonly display?: ToolDisplayProjection;
  readonly refs: readonly LiveTranscriptObservationRef[];
};

export type LiveAnswerTone = "formal" | "process";

export type LiveAnswerProjection = {
  readonly text: string;
  readonly tone: LiveAnswerTone;
  readonly streaming: boolean;
};

export type LiveRunTranscriptProjection = {
  readonly nodes: readonly LiveTranscriptNode[];
  readonly answer?: LiveAnswerProjection;
};

export function projectLiveRunTranscript(
  nodes: readonly LiveTranscriptNode[],
  live: LiveRunBuffer | undefined
): LiveRunTranscriptProjection {
  const projectedNodes = canonicalRunTranscriptNodes(nodes, live);
  return {
    nodes: projectedNodes,
    answer: liveStreamingAnswer(live, projectedNodes),
  };
}

export function withLiveTranscriptNodes(
  nodes: readonly LiveTranscriptNode[],
  live: LiveRunBuffer | undefined
): readonly LiveTranscriptNode[] {
  return canonicalRunTranscriptNodes(nodes, live);
}

/** The single reconciliation boundary for durable and live facts of one run. */
export function canonicalRunTranscriptNodes(
  nodes: readonly LiveTranscriptNode[],
  live: LiveRunBuffer | undefined,
): readonly LiveTranscriptNode[] {
  if (live === undefined) return nodes;
  // Durable nodes are passed as the incoming observation so equal-sequence
  // terminal facts win over the volatile buffer during the handoff.
  return mergeTranscriptNodeLists(liveTranscriptNodes(live), nodes);
}

function liveTranscriptNodes(live: LiveRunBuffer): readonly LiveTranscriptNode[] {
  const nodes: LiveTranscriptNode[] = live.tools.map((tool) => liveToolNode(live.runId, tool));
  for (const turn of live.turns) {
    if (turn.reasoning.text.trim().length > 0) {
      nodes.push(liveThinkingNode(live.runId, turn));
    }
    if (turn.sideText.trim().length > 0) {
      nodes.push(liveSideTextNode(live.runId, turn));
    }
    if (turn.output.text.trim().length > 0) {
      nodes.push(liveBodyNode(live.runId, turn));
    }
  }
  return nodes;
}

function liveToolNode(runId: string, tool: LiveToolActivity): LiveTranscriptNode {
  return {
    nodeId: tool.nodeId,
    runId,
    sequence: tool.sequence,
    eventType: "tool.requested",
    kind: "tool",
    phase: "executing",
    title: "",
    summary: tool.summary,
    timestamp: tool.timestamp,
    toolName: tool.toolName,
    parentToolCallFactId: tool.parentToolCallFactId,
    display: tool.display,
    refs: tool.refs,
  };
}

export function liveStreamingAnswer(
  live: LiveRunBuffer | undefined,
  nodes: readonly LiveTranscriptNode[]
): LiveAnswerProjection | undefined {
  const liveTurn = live === undefined
    ? undefined
    : [...live.turns].reverse().find((turn) => turn.output.text.trim().length > 0);
  if (liveTurn !== undefined) {
    return {
      text: liveTurn.output.text,
      tone: liveOutputFollowsToolResult(liveTurn, nodes) ? "formal" : "process",
      streaming: true,
    };
  }
  const answerNode = [...nodes].reverse().find((node) => node.kind === "answer" && (node.text?.trim().length ?? 0) > 0);
  const answerText = answerNode?.text ?? [...nodes].reverse().find((node) => node.kind === "answer" && (node.summary?.trim().length ?? 0) > 0)?.summary;
  return answerText === undefined ? undefined : { text: answerFallbackText(answerText), tone: "formal", streaming: false };
}

function liveThinkingNode(runId: string, turn: LiveModelTurnBuffer): LiveTranscriptNode {
  const text = turn.reasoning.text.trim();
  const completed = turn.reasoningCompleted;
  const modelRefs = turn.modelRefs.map((id): LiveTranscriptObservationRef => ({ kind: "model_call", id }));
  return {
    nodeId: `${runId}:live:${turn.requestId}:thinking`,
    runId,
    sequence: liveReasoningSequence(turn),
    eventType: completed ? "model.reasoning.completed" : "model.reasoning.delta",
    kind: "thinking",
    phase: completed ? "completed" : "noted",
    title: "思考",
    summary: compact(text, 180),
    text,
    timestamp: "",
    refs: modelRefs,
  };
}

function liveSideTextNode(runId: string, turn: LiveModelTurnBuffer): LiveTranscriptNode {
  const text = turn.sideText.trim();
  const modelRefs = turn.modelRefs.map((id): LiveTranscriptObservationRef => ({ kind: "model_call", id }));
  return {
    nodeId: `${runId}:live:${turn.requestId}:side-text`,
    runId,
    sequence: Math.max(0, liveSideTextSequence(turn) - 0.1),
    eventType: "model.output.side",
    kind: "system",
    phase: "completed",
    title: "",
    summary: compact(text, 220),
    text,
    timestamp: "",
    refs: modelRefs,
  };
}

function liveBodyNode(runId: string, turn: LiveModelTurnBuffer): LiveTranscriptNode {
  const text = turn.output.text.trim();
  const completed = turn.outputCompleted === true;
  const modelRefs = turn.modelRefs.map((id): LiveTranscriptObservationRef => ({ kind: "model_call", id }));
  return {
    nodeId: `${runId}:live:${turn.requestId}:body`,
    runId,
    sequence: liveOutputSequence(turn),
    eventType: completed ? "model.output.completed" : "model.output.delta",
    kind: "body",
    phase: completed ? "completed" : "noted",
    title: "",
    summary: compact(text, 220),
    text,
    timestamp: "",
    refs: modelRefs,
  };
}

function liveOutputFollowsToolResult(turn: LiveModelTurnBuffer, nodes: readonly LiveTranscriptNode[]): boolean {
  const latestToolResultSequence = nodes.reduce((latest, node) => (
    node.kind === "tool" && (node.eventType === "tool.completed" || node.eventType === "tool.failed" || node.eventType === "tool.cancelled")
      ? Math.max(latest, node.sequence)
      : latest
  ), 0);
  return latestToolResultSequence > 0 && liveOutputSequence(turn) > latestToolResultSequence;
}

function liveOutputSequence(turn: LiveModelTurnBuffer): number {
  return turn.outputSequence ?? turn.updatedAtSequence;
}

function liveReasoningSequence(turn: LiveModelTurnBuffer): number {
  return turn.reasoningSequence ?? turn.updatedAtSequence;
}

function liveSideTextSequence(turn: LiveModelTurnBuffer): number {
  return turn.sideTextSequence ?? turn.updatedAtSequence;
}

function answerFallbackText(value: string): string {
  return value.replace(/^已(?:回答|完成|生成)[:：]\s*/u, "").trim();
}

function compact(value: string, maxLength: number): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}
