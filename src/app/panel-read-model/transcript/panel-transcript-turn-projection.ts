import {
  projectLiveRunTranscript,
  type LiveRunTranscriptProjection,
} from "./panel-live-transcript.js";
import type { LiveRunBuffer } from "../run/panel-run-live-buffer.js";
import type { WorklineConversationTurn, WorklineProjectedTurn } from "../assistant/panel-assistant-workline.js";
import {
  answerForWorkViewTurn,
  deliverableForWorkViewTurn,
  type AssistantDeliverableLike,
  type AssistantWorkViewOutput,
} from "../assistant/panel-assistant-message-output.js";
import {
  pendingForTurn,
  type ConfirmationIdentity,
} from "./panel-transcript-confirmation-projection.js";
import {
  isLowValueUserDecisionNode,
  nodesForRun,
} from "./panel-transcript-node-projection.js";
import { isGenericApprovalDecisionText } from "../../text-projection/confirmation-copy.js";

export type AssistantTranscriptRunLike = {
  readonly runId: string;
  readonly status: string;
};

export type AssistantTranscriptNodeLike = {
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
  readonly refs: readonly {
    readonly kind: string;
    readonly id: string;
    readonly label?: string;
  }[];
};

export type AssistantShellSnapshot = {
  readonly turnIds: ReadonlySet<string>;
  readonly slotKeys: ReadonlySet<string>;
};

export type AssistantTranscriptTurnProjection<
  TTurn extends WorklineConversationTurn,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
> = {
  readonly turn: TTurn;
  readonly displayRunId?: string;
  readonly runProjection: LiveRunTranscriptProjection;
  readonly pending?: TPending;
  readonly content: string;
  readonly deliverable?: TDeliverable;
  readonly live: boolean;
  readonly keepStreamMounted: boolean;
  readonly animateOnMount: boolean;
  readonly liveTone?: NonNullable<LiveRunTranscriptProjection["answer"]>["tone"];
};

export function projectAssistantTranscriptTurn<
  TTurn extends WorklineConversationTurn,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
  TNode extends AssistantTranscriptNodeLike,
>(input: {
  readonly projectedTurn: WorklineProjectedTurn<TTurn>;
  readonly turnIndex: number;
  readonly turns: readonly TTurn[];
  readonly latestAssistantTurnId: string | undefined;
  readonly previousEmptyShells: AssistantShellSnapshot;
  readonly run?: AssistantTranscriptRunLike;
  readonly transcriptNodes?: readonly TNode[];
  readonly transcriptNodesForRun?: readonly TNode[];
  readonly assistantTurnSlotKey?: string;
  readonly live?: LiveRunBuffer;
  readonly workView?: AssistantWorkViewOutput<TDeliverable>;
  readonly pending?: TPending;
}): AssistantTranscriptTurnProjection<TTurn, TDeliverable, TPending> {
  const turn = input.projectedTurn.turn;
  const displayRunId = input.projectedTurn.displayRunId;
  const unclaimedRunningTurn = displayRunId === undefined && isPendingAssistantShell(turn);
  const refreshingRun = input.run?.runId === displayRunId && isRefreshingRunStatus(input.run);
  const live = activeLiveForTurn(input.live, input.run, displayRunId, refreshingRun);
  const runProjection = projectLiveRunTranscript(
    input.transcriptNodesForRun ?? nodesForRun(input.transcriptNodes ?? [], displayRunId),
    live
  );
  const pending = pendingForTurn(input.pending, displayRunId);
  const liveAnswer = runProjection.answer?.streaming === true ? runProjection.answer : undefined;
  const settledAnswerFallback = runProjection.answer?.streaming === false ? runProjection.answer.text : "";
  const turnContentAnswer = canUseTurnContentAsAnswer({
    run: input.run,
    pending,
    turn,
    nodes: runProjection.nodes,
  }) ? turn.content : "";
  const turnAnswer = answerForWorkViewTurn(input.workView, displayRunId, turnContentAnswer);
  const content = liveAnswer?.text ?? (turnAnswer.trim().length > 0 ? turnAnswer : settledAnswerFallback);
  const deliverable = deliverableForWorkViewTurn(input.workView, displayRunId, content);
  const keepStreamMounted = live !== undefined || refreshingRun || unclaimedRunningTurn;
  const shellKey = input.assistantTurnSlotKey ?? assistantTurnSlotKey(input.turns, input.turnIndex);
  const hasVisibleAnswer = content.trim().length > 0;
  const animateFromObservedShell =
    hasVisibleAnswer &&
    (
      input.previousEmptyShells.turnIds.has(turn.turnId) ||
      input.previousEmptyShells.slotKeys.has(shellKey)
    );

  return {
    turn,
    displayRunId,
    runProjection,
    pending,
    content,
    deliverable,
    live: liveAnswer !== undefined,
    keepStreamMounted,
    animateOnMount: liveAnswer !== undefined || animateFromObservedShell,
    liveTone: liveAnswer?.tone ?? runProjection.answer?.tone,
  };
}

export function assistantShellSnapshot<TTurn extends WorklineConversationTurn>(
  turns: readonly TTurn[]
): AssistantShellSnapshot {
  const turnIds = new Set<string>();
  const slotKeys = new Set<string>();
  const precomputedSlotKeys = precomputeAssistantTurnSlotKeys(turns);
  turns.forEach((turn, index) => {
    if (!isEmptyRunningAssistantTurn(turn)) {
      return;
    }
    turnIds.add(turn.turnId);
    slotKeys.add(precomputedSlotKeys[index] ?? assistantTurnSlotKey(turns, index));
  });
  return { turnIds, slotKeys };
}

export function latestAssistantTurnIdForTurns<TTurn extends WorklineConversationTurn>(
  turns: readonly TTurn[]
): string | undefined {
  return [...turns].reverse().find((turn) => turn.role === "assistant")?.turnId;
}

export function assistantTurnSlotKey<TTurn extends WorklineConversationTurn>(
  turns: readonly TTurn[],
  turnIndex: number
): string {
  const assistantOrdinal = turns
    .slice(0, turnIndex + 1)
    .filter((turn) => turn.role === "assistant")
    .length;
  const previousUser = [...turns.slice(0, turnIndex)].reverse().find((turn) => turn.role === "user");
  return `${assistantOrdinal}:${previousUser?.content ?? ""}`;
}

export function precomputeAssistantTurnSlotKeys<TTurn extends WorklineConversationTurn>(
  turns: readonly TTurn[]
): readonly (string | undefined)[] {
  const slotKeys: (string | undefined)[] = new Array(turns.length);
  let assistantOrdinal = 0;
  let previousUserContent = "";
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    if (turn.role === "user") {
      previousUserContent = turn.content;
      continue;
    }
    assistantOrdinal += 1;
    slotKeys[index] = `${assistantOrdinal}:${previousUserContent}`;
  }
  return slotKeys;
}

export function isRefreshingRunStatus(run: AssistantTranscriptRunLike | undefined): boolean {
  return run?.status === "queued" || run?.status === "planning" || run?.status === "running" || run?.status === "pending";
}

function canUseTurnContentAsAnswer<TTurn extends WorklineConversationTurn, TPending>(input: {
  readonly run: AssistantTranscriptRunLike | undefined;
  readonly pending: TPending | undefined;
  readonly turn: TTurn;
  readonly nodes: readonly LiveRunTranscriptProjection["nodes"][number][];
}): boolean {
  if (input.pending !== undefined) return false;
  if (input.run === undefined) return true;
  if (input.run.status === "completed" || input.run.status === "failed" || input.run.status === "cancelled" || input.run.status === "blocked") {
    return true;
  }
  if (input.run.status !== "running" || input.turn.content.trim().length === 0) {
    return false;
  }
  if (isGenericApprovalDecisionText(input.turn.content)) {
    return false;
  }
  return !input.nodes.some((node) =>
    node.kind === "tool" ||
    node.kind === "confirmation" ||
    (node.kind === "user_decision" && !isLowValueUserDecisionNode(node))
  );
}

function activeLiveForTurn(
  live: LiveRunBuffer | undefined,
  run: AssistantTranscriptRunLike | undefined,
  displayRunId: string | undefined,
  refreshingRun: boolean
): LiveRunBuffer | undefined {
  if (live === undefined || displayRunId === undefined || live.runId !== displayRunId) {
    return undefined;
  }
  if (run === undefined) {
    return live;
  }
  return refreshingRun ? live : undefined;
}

function isEmptyRunningAssistantTurn(turn: WorklineConversationTurn): boolean {
  return turn.role === "assistant" &&
    turn.content.trim().length === 0 &&
    isPendingAssistantShell(turn);
}

function isPendingAssistantShell(turn: WorklineConversationTurn): boolean {
  return turn.role === "assistant" && (turn.status === "running" || turn.status === "pending");
}
