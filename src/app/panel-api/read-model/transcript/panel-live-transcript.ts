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
  readonly requestStartSequence?: number;
  readonly contentIndex?: number;
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
  readonly parentInvocationId?: string;
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
  const liveNodes = liveTranscriptNodes(live);
  return sortCanonicalTranscriptNodes(mergeTranscriptNodeLists(liveNodes, nodes), liveNodes);
}

function liveTranscriptNodes(live: LiveRunBuffer): readonly LiveTranscriptNode[] {
  const nodes: LiveTranscriptNode[] = live.tools.map((tool) => liveToolNode(live.runId, tool));
  for (const turn of [...live.turns].sort(compareLiveModelTurns)) {
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

function compareLiveModelTurns(left: LiveModelTurnBuffer, right: LiveModelTurnBuffer): number {
  return left.requestStartSequence - right.requestStartSequence ||
    left.contentIndex - right.contentIndex ||
    (left.outputStartSequence ?? left.reasoningStartSequence ?? left.updatedAtSequence) -
      (right.outputStartSequence ?? right.reasoningStartSequence ?? right.updatedAtSequence);
}

function sortCanonicalTranscriptNodes(
  nodes: readonly LiveTranscriptNode[],
  liveNodes: readonly LiveTranscriptNode[],
): readonly LiveTranscriptNode[] {
  const liveOrder = new Map(liveNodes.map((node) => [node.nodeId, node]));
  return [...nodes].sort((left, right) => {
    const leftLive = liveOrder.get(left.nodeId);
    const rightLive = liveOrder.get(right.nodeId);
    if (leftLive?.requestStartSequence !== undefined && rightLive?.requestStartSequence !== undefined) {
      return (leftLive.requestStartSequence ?? leftLive.sequence) - (rightLive.requestStartSequence ?? rightLive.sequence) ||
        (leftLive.contentIndex ?? 0) - (rightLive.contentIndex ?? 0) ||
        leftLive.sequence - rightLive.sequence ||
        transcriptNodeKindRank(leftLive) - transcriptNodeKindRank(rightLive) ||
        left.nodeId.localeCompare(right.nodeId);
    }
    return left.sequence - right.sequence || left.nodeId.localeCompare(right.nodeId);
  });
}

function transcriptNodeKindRank(node: LiveTranscriptNode): number {
  if (node.kind === "thinking") return 0;
  if (node.kind === "system") return 1;
  if (node.kind === "body") return 2;
  return 3;
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
    parentInvocationId: tool.parentInvocationId,
    display: tool.display,
    refs: tool.refs,
  };
}

export function liveStreamingAnswer(
  live: LiveRunBuffer | undefined,
  nodes: readonly LiveTranscriptNode[]
): LiveAnswerProjection | undefined {
  const liveTurns = live === undefined
    ? []
    : live.turns
      .filter((turn) => turn.output.text.trim().length > 0)
      .sort((left, right) => left.requestStartSequence - right.requestStartSequence ||
        left.contentIndex - right.contentIndex ||
        (left.outputStartSequence ?? left.outputSequence ?? 0) - (right.outputStartSequence ?? right.outputSequence ?? 0));
  if (liveTurns.length > 0) {
    return {
      text: liveTurns.map((turn) => turn.output.text).join(""),
      tone: liveOutputFollowsToolResult(liveTurns[liveTurns.length - 1]!, nodes) ? "formal" : "process",
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
    nodeId: `${runId}:live:${turn.requestId}:block:${turn.contentIndex}:thinking`,
    runId,
    requestStartSequence: turn.requestStartSequence,
    sequence: liveReasoningSequence(turn),
    contentIndex: turn.contentIndex,
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
    nodeId: `${runId}:live:${turn.requestId}:block:${turn.contentIndex}:side-text`,
    runId,
    requestStartSequence: turn.requestStartSequence,
    sequence: liveSideTextSequence(turn),
    contentIndex: turn.contentIndex,
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
    nodeId: `${runId}:live:${turn.requestId}:block:${turn.contentIndex}:body`,
    runId,
    requestStartSequence: turn.requestStartSequence,
    sequence: liveOutputSequence(turn),
    contentIndex: turn.contentIndex,
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
  return latestToolResultSequence > 0 && liveOutputLatestSequence(turn) > latestToolResultSequence;
}

function liveOutputSequence(turn: LiveModelTurnBuffer): number {
  return turn.outputStartSequence ?? turn.outputSequence ?? turn.updatedAtSequence;
}

function liveOutputLatestSequence(turn: LiveModelTurnBuffer): number {
  return turn.outputSequence ?? turn.outputStartSequence ?? turn.updatedAtSequence;
}

function liveReasoningSequence(turn: LiveModelTurnBuffer): number {
  return turn.reasoningStartSequence ?? turn.reasoningSequence ?? turn.updatedAtSequence;
}

function liveSideTextSequence(turn: LiveModelTurnBuffer): number {
  return turn.sideTextSequence ?? turn.updatedAtSequence;
}

function answerFallbackText(value: string): string {
  return value.trim();
}

function compact(value: string, maxLength: number): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}
