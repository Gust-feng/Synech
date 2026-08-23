import type { LiveRunBuffer } from "../run/panel-run-live-buffer.js";
import type { LiveAnswerTone } from "../transcript/panel-live-transcript.js";
import type {
  WorklineConversationTurn,
  WorklineProjectedTurn,
} from "./panel-assistant-workline.js";
import type { ConfirmationIdentity } from "../transcript/panel-transcript-confirmation-projection.js";
import {
  type AssistantDeliverableLike,
  type AssistantWorkViewOutput,
} from "./panel-assistant-message-output.js";
import {
  projectAssistantTranscriptTurn,
  type AssistantShellSnapshot,
  type AssistantTranscriptNodeLike,
  type AssistantTranscriptRunLike,
  type AssistantTranscriptTurnProjection,
} from "../transcript/panel-transcript-turn-projection.js";
import { shouldCollapseTimelineAfterTurn } from "./panel-assistant-timeline-collapse.js";
import { transcriptNodesForRunId } from "../transcript/panel-transcript-materializer.js";
import {
  projectStableAssistantWorkflowDisplay,
  type AssistantWorkflowDisplay,
  type AssistantWorkflowDisplayState,
} from "./panel-assistant-workflow-display.js";
import {
  assistantTerminalStatus,
  assistantFailureParts,
  transcriptNodesWithoutFailureEcho,
  type AssistantFailureParts,
} from "./panel-assistant-failure.js";

export type AssistantWorkflowProjectionInput<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
> = {
  readonly turn: TTurn;
  readonly transcriptNodes?: readonly TNode[];
  readonly pending?: TPending;
  readonly deliverable?: TDeliverable;
  readonly content: string;
  readonly live: boolean;
  readonly keepStreamMounted: boolean;
  readonly animateOnMount: boolean;
  readonly liveTone?: LiveAnswerTone;
  readonly collapseTimeline: boolean;
};

export type StableAssistantTurnDisplay<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
> = {
  readonly assistant: AssistantTranscriptTurnProjection<TTurn, TDeliverable, TPending>;
  readonly workflow?: AssistantWorkflowDisplay<TNode, TPending>;
  readonly failure?: AssistantFailureParts;
};

export function projectStableAssistantTurnDisplay<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(input: {
  readonly previousWorkflow?: AssistantWorkflowDisplayState<TNode, TPending>;
  readonly projectedTurn: WorklineProjectedTurn<TTurn>;
  readonly turnIndex: number;
  readonly turns: readonly TTurn[];
  readonly latestAssistantTurnId: string | undefined;
  readonly previousEmptyShells: AssistantShellSnapshot;
  readonly assistantTurnSlotKey?: string;
  readonly run?: AssistantTranscriptRunLike;
  readonly transcriptNodesForRun?: readonly TNode[];
  readonly live?: LiveRunBuffer;
  readonly workView?: AssistantWorkViewOutput<TDeliverable>;
  readonly pending?: TPending;
}): {
  readonly display: StableAssistantTurnDisplay<TTurn, TNode, TDeliverable, TPending>;
  readonly workflow: AssistantWorkflowDisplayState<TNode, TPending>;
} {
  const assistant = projectAssistantTranscriptTurn<TTurn, TDeliverable, TPending, TNode>({
    projectedTurn: input.projectedTurn,
    turnIndex: input.turnIndex,
    turns: input.turns,
    latestAssistantTurnId: input.latestAssistantTurnId,
    previousEmptyShells: input.previousEmptyShells,
    assistantTurnSlotKey: input.assistantTurnSlotKey,
    run: input.run,
    transcriptNodesForRun: input.transcriptNodesForRun,
    live: input.live,
    workView: input.workView,
    pending: input.pending,
  });
  const collapseTimeline = shouldCollapseTimelineAfterTurn({
    displayRunId: assistant.displayRunId,
    live: assistant.live,
    pending: assistant.pending,
    run: input.run,
    turnStatus: input.projectedTurn.turn.status,
  });
  const terminalStatus = input.projectedTurn.turn.interruption === undefined
    ? assistantTerminalStatus(input.projectedTurn.turn.status)
    : undefined;
  const failure = terminalStatus === undefined ? undefined : assistantFailureParts(assistant.content);
  const projectedNodes = assistant.runProjection.nodes as readonly TNode[];
  const interruptionNodes = input.projectedTurn.turn.interruption === undefined
    ? projectedNodes
    : projectedNodes.filter((node) =>
        !(node.kind === "system" && (node.phase === "cancelled" || node.phase === "blocked")));
  const workflowTranscriptNodes = transcriptNodesWithoutFailureEcho(
    interruptionNodes,
    failure,
  );
  const workflowInput: AssistantWorkflowProjectionInput<TTurn, TNode, TDeliverable, TPending> = {
    turn: input.projectedTurn.turn,
    content: failure?.previous ?? assistant.content,
    deliverable: failure === undefined ? assistant.deliverable : undefined,
    transcriptNodes: workflowTranscriptNodes,
    pending: assistant.pending,
    live: assistant.live,
    keepStreamMounted: assistant.keepStreamMounted,
    animateOnMount: assistant.animateOnMount,
    liveTone: assistant.liveTone,
    collapseTimeline,
  };
  const workflow = projectStableAssistantWorkflowDisplay({
    // A terminal failure notice owns the user-visible error. Rebuild from the
    // current nodes so a run.failed activity cached one frame earlier cannot
    // survive beside that notice; real tool activity remains in the nodes.
    previous: failure === undefined ? input.previousWorkflow : undefined,
    ...workflowInput,
  });
  return {
    display: {
      assistant,
      workflow: workflow.workflow,
      failure,
    },
    workflow,
  };
}

export function projectStableAssistantTurnDisplays<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(input: {
  readonly previousDisplays?: ReadonlyMap<string, StableAssistantTurnDisplay<TTurn, TNode, TDeliverable, TPending>>;
  readonly previousWorkflows?: ReadonlyMap<string, AssistantWorkflowDisplayState<TNode, TPending>>;
  readonly projectedTurns: readonly WorklineProjectedTurn<TTurn>[];
  readonly turns: readonly TTurn[];
  readonly latestAssistantTurnId: string | undefined;
  readonly previousEmptyShells: AssistantShellSnapshot;
  readonly assistantTurnSlotKeys?: readonly (string | undefined)[];
  readonly run?: AssistantTranscriptRunLike;
  readonly transcriptNodesByRunId: ReadonlyMap<string, readonly TNode[]>;
  readonly live?: LiveRunBuffer;
  readonly workView?: AssistantWorkViewOutput<TDeliverable>;
  readonly pending?: TPending;
}): {
  readonly displays: ReadonlyMap<string, StableAssistantTurnDisplay<TTurn, TNode, TDeliverable, TPending>>;
  readonly workflows: ReadonlyMap<string, AssistantWorkflowDisplayState<TNode, TPending>>;
} {
  const previousWorkflows = input.previousWorkflows ?? new Map<string, AssistantWorkflowDisplayState<TNode, TPending>>();
  const displays = new Map<string, StableAssistantTurnDisplay<TTurn, TNode, TDeliverable, TPending>>();
  const workflows = new Map<string, AssistantWorkflowDisplayState<TNode, TPending>>();
  input.projectedTurns.forEach((projection, turnIndex) => {
    const turn = projection.turn;
    if (turn.role !== "assistant") {
      return;
    }
    const previousDisplay = input.previousDisplays?.get(turn.turnId);
    const previousWorkflow = previousWorkflows.get(turn.turnId);
    const transcriptNodesForRun = transcriptNodesForRunId(input.transcriptNodesByRunId, projection.displayRunId);
    if (
      previousDisplay !== undefined &&
      previousWorkflow !== undefined &&
      canReusePreviousAssistantTurnDisplay({
        previousDisplay,
        previousWorkflow,
        projection,
        turnIndex,
        latestAssistantTurnId: input.latestAssistantTurnId,
        assistantTurnSlotKey: input.assistantTurnSlotKeys?.[turnIndex],
        transcriptNodesForRun,
        run: input.run,
        live: input.live,
        workView: input.workView,
        pending: input.pending,
      })
    ) {
      displays.set(turn.turnId, previousDisplay);
      workflows.set(turn.turnId, previousWorkflow);
      return;
    }
    const projected = projectStableAssistantTurnDisplay({
      previousWorkflow,
      projectedTurn: projection,
      turnIndex,
      turns: input.turns,
      latestAssistantTurnId: input.latestAssistantTurnId,
      previousEmptyShells: input.previousEmptyShells,
      assistantTurnSlotKey: input.assistantTurnSlotKeys?.[turnIndex],
      run: input.run,
      transcriptNodesForRun,
      live: input.live,
      workView: input.workView,
      pending: input.pending,
    });
    displays.set(turn.turnId, projected.display);
    workflows.set(turn.turnId, projected.workflow);
  });
  return { displays, workflows };
}

function canReusePreviousAssistantTurnDisplay<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(input: {
  readonly previousDisplay: StableAssistantTurnDisplay<TTurn, TNode, TDeliverable, TPending>;
  readonly previousWorkflow: AssistantWorkflowDisplayState<TNode, TPending>;
  readonly projection: WorklineProjectedTurn<TTurn>;
  readonly turnIndex: number;
  readonly latestAssistantTurnId: string | undefined;
  readonly assistantTurnSlotKey?: string;
  readonly transcriptNodesForRun: readonly TNode[];
  readonly run?: AssistantTranscriptRunLike;
  readonly live?: LiveRunBuffer;
  readonly workView?: AssistantWorkViewOutput<TDeliverable>;
  readonly pending?: TPending;
}): boolean {
  if (input.previousDisplay.workflow !== input.previousWorkflow.workflow) {
    return false;
  }
  const previousAssistant = input.previousDisplay.assistant;
  if (previousAssistant.turn !== input.projection.turn) {
    return false;
  }
  if (previousAssistant.displayRunId !== input.projection.displayRunId) {
    return false;
  }
  if (
    input.projection.turn.turnId === input.latestAssistantTurnId &&
    isLatestAssistantTurnActive(input)
  ) {
    return false;
  }
  if (isCurrentRunProjectionTurn(input)) {
    return false;
  }
  if (previousAssistant.runProjection.nodes !== input.transcriptNodesForRun) {
    return false;
  }
  if (previousAssistant.keepStreamMounted || previousAssistant.live || previousAssistant.pending !== undefined) {
    return false;
  }
  if (previousAssistant.animateOnMount) {
    return false;
  }
  return true;
}

function isLatestAssistantTurnActive<
  TTurn extends WorklineConversationTurn,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(input: {
  readonly projection: WorklineProjectedTurn<TTurn>;
  readonly run?: AssistantTranscriptRunLike;
  readonly live?: LiveRunBuffer;
  readonly workView?: AssistantWorkViewOutput<TDeliverable>;
  readonly pending?: TPending;
}): boolean {
  if (input.projection.displayRunId === undefined) {
    return input.live !== undefined || input.workView !== undefined || input.pending !== undefined;
  }
  return isCurrentRunProjectionTurn(input);
}

function isCurrentRunProjectionTurn<
  TTurn extends WorklineConversationTurn,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(input: {
  readonly projection: WorklineProjectedTurn<TTurn>;
  readonly run?: AssistantTranscriptRunLike;
  readonly live?: LiveRunBuffer;
  readonly workView?: AssistantWorkViewOutput<TDeliverable>;
  readonly pending?: TPending;
}): boolean {
  const displayRunId = input.projection.displayRunId;
  if (displayRunId === undefined) {
    return false;
  }
  return input.run?.runId === displayRunId ||
    input.live?.runId === displayRunId ||
    input.workView?.run.runId === displayRunId ||
    pendingMatchesDisplayRun(input.pending, displayRunId);
}

function pendingMatchesDisplayRun<TPending extends ConfirmationIdentity>(
  pending: TPending | undefined,
  displayRunId: string,
): boolean {
  return pending !== undefined &&
    (pending.ownerRunId === undefined || pending.ownerRunId === displayRunId);
}
