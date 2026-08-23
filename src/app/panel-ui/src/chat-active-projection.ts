import {
  projectLiveRunTranscript,
  type LiveAnswerProjection,
  type LiveTranscriptNode,
  type LiveRunTranscriptProjection,
} from "../../panel-read-model/transcript/panel-live-transcript.js";
import { projectChatWorkline, type ChatWorklineProjection, type WorklineTaskStatus } from "../../panel-read-model/assistant/panel-assistant-workline.js";
import type { LiveRunBuffer } from "../../panel-read-model/run/panel-run-live-buffer.js";
import { firstNonEmptyText, hasNonEmptyText } from "../../panel-read-model/assistant/panel-assistant-output.js";
import {
  isLowValueUserDecisionNode,
  nodesForRun,
} from "../../panel-read-model/transcript/panel-transcript-node-projection.js";
import { isGenericApprovalDecisionText } from "../../text-projection/confirmation-copy.js";

export type ChatActiveConversationTurn = {
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly title?: string;
  readonly content: string;
  readonly status: string;
  readonly runId?: string;
  readonly attachments?: readonly {
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
  }[];
};

export type ChatActiveConversation = {
  readonly turns: readonly ChatActiveConversationTurn[];
  readonly activeRunId?: string;
  readonly latestRunId?: string;
};

export type ChatActiveRun = {
  readonly runId: string;
  readonly status: WorklineTaskStatus;
  readonly eventCursor: {
    readonly lastSequence: number;
  };
};

export type ChatActiveTranscriptNode = LiveTranscriptNode;

export type ChatActiveStatusNotice = {
  readonly title?: string;
  readonly message: string;
  readonly tone: "warning" | "error";
};

export type ChatActiveProjectionInput<TDeliverable, TPending> = {
  readonly conversation?: ChatActiveConversation;
  readonly run?: ChatActiveRun;
  readonly transcriptNodes: readonly ChatActiveTranscriptNode[];
  readonly live?: LiveRunBuffer;
  readonly workViewAnswer?: string;
  readonly detailAnswer?: string;
  readonly pending?: TPending;
  readonly deliverable?: TDeliverable;
  readonly problem?: ChatActiveStatusNotice;
  readonly appError?: string;
};

export type ChatActiveProjection<TDeliverable, TPending> = {
  readonly currentRunId?: string;
  readonly currentRunProjection: LiveRunTranscriptProjection;
  readonly transcriptNodes: readonly ChatActiveTranscriptNode[];
  readonly answer?: string;
  readonly pending?: TPending;
  readonly deliverable?: TDeliverable;
  readonly liveAnswer?: LiveAnswerProjection;
  readonly running: boolean;
  readonly statusNotice?: ChatActiveStatusNotice;
  readonly workline: ChatWorklineProjection<ChatActiveConversationTurn>;
  readonly hasVisibleContent: boolean;
  readonly scrollKey: string;
};

export function projectChatActive<TDeliverable, TPending>(
  input: ChatActiveProjectionInput<TDeliverable, TPending>
): ChatActiveProjection<TDeliverable, TPending> {
  const currentRunId = input.run?.runId ?? input.conversation?.activeRunId ?? input.conversation?.latestRunId ?? input.live?.runId;
  const activeLive = activeLiveForCurrentRun(input.run, currentRunId, input.live);
  const currentRunNodes = nodesForRun(input.transcriptNodes, currentRunId);
  const currentRunProjection = projectLiveRunTranscript(currentRunNodes, activeLive);
  const currentRunAssistantTurn = currentRunId === undefined
    ? undefined
    : latestAssistantTurnForRun(input.conversation?.turns ?? [], currentRunId);
  const pending = input.pending;
  const turnContentAnswer = canUseConversationTurnAsAnswer({
    run: input.run,
    pending,
    turn: currentRunAssistantTurn,
    transcriptNodes: currentRunProjection.nodes,
    currentRunNodes,
    currentRunId,
  })
    ? currentRunAssistantTurn?.content
    : undefined;
  const answer = pending === undefined ? firstNonEmptyText([
    input.workViewAnswer,
    input.detailAnswer,
    turnContentAnswer,
  ]) : undefined;
  const liveAnswer = currentRunProjection.answer;
  const running = input.run !== undefined && !terminalStatuses.has(input.run.status);
  const statusNotice = shouldShowStatusNotice(input.problem, input.appError, input.run, currentRunAssistantTurn)
    ? input.problem
    : undefined;
  const workline = projectChatWorkline({
    turns: input.conversation?.turns ?? [],
    currentRunId,
    currentRunStatus: input.run?.status,
    transcriptNodes: input.transcriptNodes,
    hasAnswer: hasNonEmptyText(answer),
    hasLiveAnswer: liveAnswer !== undefined,
    hasPendingConfirmation: pending !== undefined,
    hasDeliverable: input.deliverable !== undefined,
  });
  const latestTurn = workline.turns.at(-1);
  const scrollKey = [
    latestTurn?.turn.turnId,
    latestTurn?.turn.content.length,
    liveAnswer?.text.length,
    input.run?.status,
    input.run?.eventCursor.lastSequence,
    input.transcriptNodes.at(-1)?.nodeId,
  ].join(":");

  return {
    currentRunId,
    currentRunProjection,
    transcriptNodes: input.transcriptNodes,
    answer,
    pending,
    deliverable: input.deliverable,
    liveAnswer,
    running,
    statusNotice,
    workline,
    hasVisibleContent: workline.turns.length > 0 || workline.standaloneRun || statusNotice !== undefined,
    scrollKey,
  };
}

const terminalStatuses = new Set<WorklineTaskStatus>(["completed", "failed", "cancelled", "blocked"]);
const terminalProblemStatuses = new Set<WorklineTaskStatus>(["failed", "cancelled", "blocked"]);
const refreshingStatuses = new Set<WorklineTaskStatus>(["queued", "planning", "running", "pending"]);

function canUseConversationTurnAsAnswer<TPending>(input: {
  readonly run: ChatActiveRun | undefined;
  readonly pending: TPending | undefined;
  readonly turn: ChatActiveConversationTurn | undefined;
  readonly transcriptNodes: readonly ChatActiveTranscriptNode[];
  readonly currentRunNodes?: readonly ChatActiveTranscriptNode[];
  readonly currentRunId: string | undefined;
}): boolean {
  if (input.turn === undefined || input.pending !== undefined) return false;
  if (input.run === undefined) return true;
  if (terminalStatuses.has(input.run.status)) return true;
  if (input.run.status !== "running" || input.turn.content.trim().length === 0) {
    return false;
  }
  if (isGenericApprovalDecisionText(input.turn.content)) {
    return false;
  }
  const currentNodes = input.currentRunNodes ?? (
    input.currentRunId === undefined
      ? []
      : input.transcriptNodes.filter((node) => node.runId === input.currentRunId)
  );
  const latestNodeSequence = currentNodes.reduce((latest, node) => Math.max(latest, node.sequence), 0);
  return !hasToolOrApprovalBoundary(currentNodes) || input.run.eventCursor.lastSequence > latestNodeSequence;
}

function latestAssistantTurnForRun(
  turns: readonly ChatActiveConversationTurn[],
  runId: string
): ChatActiveConversationTurn | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.role === "assistant" && turn.runId === runId && turn.content.trim().length > 0) {
      return turn;
    }
  }
  return undefined;
}

function hasToolOrApprovalBoundary(nodes: readonly ChatActiveTranscriptNode[]): boolean {
  return nodes.some((node) =>
    node.kind === "tool" ||
    node.kind === "confirmation" ||
    (node.kind === "user_decision" && !isLowValueUserDecisionNode(node))
  );
}

function activeLiveForCurrentRun(
  run: ChatActiveRun | undefined,
  currentRunId: string | undefined,
  live: LiveRunBuffer | undefined
): LiveRunBuffer | undefined {
  if (live === undefined || currentRunId === undefined || live.runId !== currentRunId) {
    return undefined;
  }
  if (run === undefined) {
    return live;
  }
  return refreshingStatuses.has(run.status) || run.status === "cancelled" ? live : undefined;
}

function shouldShowStatusNotice(
  problem: ChatActiveStatusNotice | undefined,
  appError: string | undefined,
  run: ChatActiveRun | undefined,
  assistantTurn: ChatActiveConversationTurn | undefined
): boolean {
  if (problem === undefined) return false;
  if (appError !== undefined) return true;
  if (assistantTurn === undefined) return true;
  if (run !== undefined && terminalProblemStatuses.has(run.status)) {
    return assistantTurn.status !== run.status;
  }
  return run?.status === "paused";
}