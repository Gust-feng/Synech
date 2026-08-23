import type {
  AssistantDeliverableLike,
  AssistantWorkViewOutput,
} from "../panel-read-model/assistant/panel-assistant-message-output.js";
import type { LiveRunBuffer } from "../panel-read-model/run/panel-run-live-buffer.js";
import type { WorklineConversationTurn, WorklineProjectedTurn } from "../panel-read-model/assistant/panel-assistant-workline.js";
import type { ConfirmationIdentity } from "../panel-read-model/transcript/panel-transcript-confirmation-projection.js";
import {
  projectConversationWorkflowDisplay,
  projectStandaloneAssistantWorkflowDisplay,
  type ConversationWorkflowDisplayState,
} from "./panel-conversation-workflow-display.js";
import type { StableAssistantTurnDisplay } from "../panel-read-model/assistant/panel-assistant-turn-display.js";
import type { AssistantTranscriptNodeLike, AssistantTranscriptRunLike } from "../panel-read-model/transcript/panel-transcript-turn-projection.js";
import type {
  AssistantWorkflowDisplay,
  AssistantWorkflowDisplayState,
} from "../panel-read-model/assistant/panel-assistant-workflow-display.js";
import type { LiveRunTranscriptProjection } from "../panel-read-model/transcript/panel-live-transcript.js";
import {
  assistantTerminalStatus,
  type AssistantFailureParts,
  type AssistantTerminalStatus,
} from "../panel-read-model/assistant/panel-assistant-failure.js";

export type ConversationDisplayItem<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TPending extends ConfirmationIdentity,
> =
  | {
      readonly kind: "user";
      readonly key: string;
      readonly turn: TTurn;
    }
  | {
      readonly kind: "assistant";
      readonly key: string;
      readonly source: "turn";
      readonly turn: TTurn;
      readonly workflow?: AssistantWorkflowDisplay<TNode, TPending>;
      readonly live: boolean;
      readonly animateOnMount: boolean;
      readonly hasPendingConfirmation: boolean;
      readonly failure?: AssistantFailureParts;
      readonly terminalStatus?: AssistantTerminalStatus;
    }
  | {
      readonly kind: "assistant";
      readonly key: string;
      readonly source: "standalone";
      readonly workflow?: AssistantWorkflowDisplay<TNode, TPending>;
      readonly live: boolean;
      readonly animateOnMount: boolean;
      readonly hasPendingConfirmation: boolean;
      readonly failure?: AssistantFailureParts;
      readonly terminalStatus?: AssistantTerminalStatus;
    };

export function projectConversationDisplayList<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(input: {
  readonly previous?: ConversationWorkflowDisplayState<TTurn, TNode, TDeliverable, TPending>;
  readonly conversationId?: string;
  readonly projectedTurns: readonly WorklineProjectedTurn<TTurn>[];
  readonly turns: readonly TTurn[];
  readonly cachedNodesByRunId: Readonly<Record<string, readonly TNode[]>>;
  readonly currentRunId?: string;
  readonly currentRunNodes: readonly TNode[];
  readonly run?: AssistantTranscriptRunLike;
  readonly live?: LiveRunBuffer;
  readonly workView?: AssistantWorkViewOutput<TDeliverable>;
  readonly pending?: TPending;
  readonly standaloneRun?: {
    readonly currentRunId?: string;
    readonly runStatus?: string;
    readonly answer?: string;
    readonly deliverable?: AssistantDeliverableLike;
    readonly runProjection: LiveRunTranscriptProjection & {
      readonly nodes: readonly TNode[];
    };
    readonly pending?: TPending;
    readonly collapseTimeline: boolean;
  };
}): {
  readonly state: ConversationWorkflowDisplayState<TTurn, TNode, TDeliverable, TPending>;
  readonly items: readonly ConversationDisplayItem<TTurn, TNode, TPending>[];
} {
  const turnDisplay = projectConversationWorkflowDisplay({
    previous: input.previous,
    conversationId: input.conversationId,
    projectedTurns: input.projectedTurns,
    turns: input.turns,
    cachedNodesByRunId: input.cachedNodesByRunId,
    currentRunId: input.currentRunId,
    currentRunNodes: input.currentRunNodes,
    run: input.run,
    live: input.live,
    workView: input.workView,
    pending: input.pending,
  });
  const standaloneRun = input.standaloneRun;
  const standaloneInput = standaloneRun === undefined
    ? undefined
    : standaloneWorkflowProjectionInput(input.conversationId, standaloneRun);
  const standalone = standaloneInput === undefined
    ? undefined
    : projectStandaloneAssistantWorkflowDisplay({
        previous: input.previous,
        conversationId: input.conversationId,
        ...standaloneInput,
      });
  const items = conversationDisplayItemsFromTurns(input.projectedTurns, turnDisplay.assistantDisplays);
  if (standalone !== undefined && standaloneRun !== undefined) {
    const standaloneFacts = standaloneAssistantFacts(standaloneRun, input.conversationId);
    items.push({
      kind: "assistant",
      key: standaloneFacts.key,
      source: "standalone",
      workflow: standalone.workflow,
      live: standalone.failure === undefined ? standaloneFacts.live : false,
      animateOnMount: standalone.failure === undefined ? standaloneFacts.animateOnMount : false,
      hasPendingConfirmation: standalone.failure === undefined && standaloneRun.pending !== undefined,
      failure: standalone.failure,
      terminalStatus: standaloneInput?.terminalStatus,
    });
  }
  return {
    state: {
      ...turnDisplay.state,
      assistantWorkflowsByRunId: assistantWorkflowsByRunIdWithStandalone(
        turnDisplay.state.assistantWorkflowsByRunId,
        standalone?.nextStandalone,
      ),
      standaloneAssistant: standalone?.nextStandalone,
    },
    items,
  };
}

function standaloneWorkflowProjectionInput<
  TNode extends AssistantTranscriptNodeLike,
  TPending extends ConfirmationIdentity,
>(
  conversationId: string | undefined,
  standaloneRun: {
    readonly currentRunId?: string;
    readonly runStatus?: string;
    readonly answer?: string;
    readonly deliverable?: AssistantDeliverableLike;
    readonly runProjection: LiveRunTranscriptProjection & {
      readonly nodes: readonly TNode[];
    };
    readonly pending?: TPending;
    readonly collapseTimeline: boolean;
  },
): {
  readonly key: string;
  readonly runId?: string;
  readonly content: string;
  readonly deliverable?: AssistantDeliverableLike;
  readonly transcriptNodes: readonly TNode[];
  readonly pending?: TPending;
  readonly live: boolean;
  readonly keepStreamMounted: boolean;
  readonly animateOnMount: boolean;
  readonly liveTone?: NonNullable<LiveRunTranscriptProjection["answer"]>["tone"];
  readonly collapseTimeline: boolean;
  readonly terminalStatus?: AssistantTerminalStatus;
} {
  const facts = standaloneAssistantFacts(standaloneRun, conversationId);
  return {
    key: facts.key,
    runId: standaloneRun.currentRunId,
    content: facts.content,
    deliverable: standaloneRun.deliverable,
    terminalStatus: facts.terminalStatus,
    transcriptNodes: standaloneRun.runProjection.nodes,
    pending: standaloneRun.pending,
    live: facts.live,
    keepStreamMounted: facts.keepStreamMounted,
    animateOnMount: facts.animateOnMount,
    liveTone: facts.liveTone,
    collapseTimeline: standaloneRun.collapseTimeline,
  };
}

function assistantWorkflowsByRunIdWithStandalone<
  TNode extends AssistantTranscriptNodeLike,
  TPending extends ConfirmationIdentity,
>(
  workflowsByRunId: ReadonlyMap<string, AssistantWorkflowDisplayState<TNode, TPending>>,
  standalone: {
    readonly runId?: string;
    readonly workflow: AssistantWorkflowDisplayState<TNode, TPending>;
  } | undefined,
): ReadonlyMap<string, AssistantWorkflowDisplayState<TNode, TPending>> {
  if (standalone?.runId === undefined) {
    return workflowsByRunId;
  }
  const next = new Map(workflowsByRunId);
  next.set(standalone.runId, standalone.workflow);
  return next;
}

function standaloneAssistantFacts<
  TNode extends AssistantTranscriptNodeLike,
  TPending extends ConfirmationIdentity,
>(
  standaloneRun: {
    readonly currentRunId?: string;
    readonly runStatus?: string;
    readonly answer?: string;
    readonly runProjection: LiveRunTranscriptProjection & {
      readonly nodes: readonly TNode[];
    };
    readonly pending?: TPending;
  },
  conversationId?: string,
): {
  readonly key: string;
  readonly content: string;
  readonly terminalStatus?: AssistantTerminalStatus;
  readonly live: boolean;
  readonly keepStreamMounted: boolean;
  readonly animateOnMount: boolean;
  readonly liveTone?: NonNullable<LiveRunTranscriptProjection["answer"]>["tone"];
} {
  const liveStreamingAnswer = standaloneRun.runProjection.answer?.streaming === true
    ? standaloneRun.runProjection.answer
    : undefined;
  const refreshing = isStandaloneRefreshingStatus(standaloneRun.runStatus);
  const content = liveStreamingAnswer?.text ?? standaloneRun.answer ?? standaloneRun.runProjection.answer?.text ?? "";
  return {
    key: `${conversationId ?? "standalone"}:${standaloneRun.currentRunId ?? "standalone-assistant"}`,
    content,
    terminalStatus: standaloneRun.runStatus === undefined
      ? undefined
      : assistantTerminalStatus(standaloneRun.runStatus),
    live: refreshing && liveStreamingAnswer !== undefined,
    keepStreamMounted: refreshing,
    animateOnMount: false,
    liveTone: liveStreamingAnswer?.tone ?? standaloneRun.runProjection.answer?.tone,
  };
}

function isStandaloneRefreshingStatus(status: string | undefined): boolean {
  return status === "queued" || status === "planning" || status === "running" || status === "pending";
}

function conversationDisplayItemsFromTurns<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(
  projectedTurns: readonly WorklineProjectedTurn<TTurn>[],
  assistantDisplays: ReadonlyMap<string, StableAssistantTurnDisplay<TTurn, TNode, TDeliverable, TPending>>,
): ConversationDisplayItem<TTurn, TNode, TPending>[] {
  const items: ConversationDisplayItem<TTurn, TNode, TPending>[] = [];
  for (const projection of projectedTurns) {
    const turn = projection.turn;
    if (turn.role === "user") {
      items.push({
        kind: "user",
        key: turn.turnId,
        turn,
      });
      continue;
    }
    const assistantDisplay = assistantDisplays.get(turn.turnId);
    if (assistantDisplay === undefined) {
      continue;
    }
    const { assistant, workflow } = assistantDisplay;
    const terminalStatus = turn.interruption === undefined
      ? assistantTerminalStatus(turn.status)
      : undefined;
    items.push(terminalStatus !== undefined
      ? {
          kind: "assistant",
          key: turn.turnId,
          source: "turn",
          turn,
          workflow,
          live: false,
          animateOnMount: false,
          hasPendingConfirmation: false,
          failure: assistantDisplay.failure,
          terminalStatus,
        }
      : {
          kind: "assistant",
          key: turn.turnId,
          source: "turn",
          turn,
          workflow,
          live: assistant.live,
          animateOnMount: assistant.animateOnMount,
          hasPendingConfirmation: assistant.pending !== undefined,
        });
  }
  return items;
}