import type {
  AssistantDeliverableLike,
  AssistantWorkViewOutput,
} from "../panel-read-model/assistant/panel-assistant-message-output.js";
import {
  projectStableAssistantTurnDisplays,
  type StableAssistantTurnDisplay,
} from "../panel-read-model/assistant/panel-assistant-turn-display.js";
import type { LiveRunBuffer } from "../panel-read-model/run/panel-run-live-buffer.js";
import type { WorklineConversationTurn, WorklineProjectedTurn } from "../panel-read-model/assistant/panel-assistant-workline.js";
import {
  assistantShellSnapshot,
  latestAssistantTurnIdForTurns,
  precomputeAssistantTurnSlotKeys,
  type AssistantShellSnapshot,
  type AssistantTranscriptNodeLike,
  type AssistantTranscriptRunLike,
} from "../panel-read-model/transcript/panel-transcript-turn-projection.js";
import type { ConfirmationIdentity } from "../panel-read-model/transcript/panel-transcript-confirmation-projection.js";
import {
  materializeConversationTranscript,
  stableTranscriptNodesByRunIdMap,
} from "../panel-read-model/transcript/panel-transcript-materializer.js";
import type { LiveAnswerTone } from "../panel-read-model/transcript/panel-live-transcript.js";
import {
  projectStableAssistantWorkflowDisplay,
  type AssistantWorkflowDisplay,
  type AssistantWorkflowDisplayState,
} from "../panel-read-model/assistant/panel-assistant-workflow-display.js";
import {
  type AssistantTerminalStatus,
  assistantFailureParts,
  transcriptNodesWithoutFailureEcho,
  type AssistantFailureParts,
} from "../panel-read-model/assistant/panel-assistant-failure.js";

export type ConversationWorkflowDisplayState<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
> = {
  readonly conversationId?: string;
  readonly emptyAssistantShells: AssistantShellSnapshot;
  readonly transcriptNodesByRunId: ReadonlyMap<string, readonly TNode[]>;
  readonly assistantDisplaysByTurnId: ReadonlyMap<string, StableAssistantTurnDisplay<TTurn, TNode, TDeliverable, TPending>>;
  readonly assistantWorkflowsByTurnId: ReadonlyMap<string, AssistantWorkflowDisplayState<TNode, TPending>>;
  readonly assistantWorkflowsByRunId: ReadonlyMap<string, AssistantWorkflowDisplayState<TNode, TPending>>;
  readonly standaloneAssistant?: {
    readonly key: string;
    readonly runId?: string;
    readonly workflow: AssistantWorkflowDisplayState<TNode, TPending>;
  };
};

export function createConversationWorkflowDisplayState<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(): ConversationWorkflowDisplayState<TTurn, TNode, TDeliverable, TPending> {
  return {
    conversationId: undefined,
    emptyAssistantShells: assistantShellSnapshot([]),
    transcriptNodesByRunId: new Map<string, readonly TNode[]>(),
    assistantDisplaysByTurnId: new Map<string, StableAssistantTurnDisplay<TTurn, TNode, TDeliverable, TPending>>(),
    assistantWorkflowsByTurnId: new Map<string, AssistantWorkflowDisplayState<TNode, TPending>>(),
    assistantWorkflowsByRunId: new Map<string, AssistantWorkflowDisplayState<TNode, TPending>>(),
  };
}

export function projectConversationWorkflowDisplay<
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
}): {
  readonly state: ConversationWorkflowDisplayState<TTurn, TNode, TDeliverable, TPending>;
  readonly assistantDisplays: ReadonlyMap<string, StableAssistantTurnDisplay<TTurn, TNode, TDeliverable, TPending>>;
} {
  const previous = conversationWorkflowDisplayStateForConversation(input.previous, input.conversationId);
  const materializedTranscript = materializeConversationTranscript({
    conversationId: input.conversationId,
    cachedNodesByRunId: input.cachedNodesByRunId,
    currentRunId: input.currentRunId,
    currentRunNodes: input.currentRunNodes,
  });
  const transcriptNodesByRunId = stableTranscriptNodesByRunIdMap(
    previous?.transcriptNodesByRunId,
    materializedTranscript.nodesByRunId,
  );
  const assistantDisplays = projectStableAssistantTurnDisplays({
    previousDisplays: previous?.assistantDisplaysByTurnId,
    previousWorkflows: previousAssistantWorkflowsForTurns(previous, input.projectedTurns),
    projectedTurns: input.projectedTurns,
    turns: input.turns,
    latestAssistantTurnId: latestAssistantTurnIdForTurns(input.turns),
    previousEmptyShells: previous?.emptyAssistantShells ?? assistantShellSnapshot([]),
    assistantTurnSlotKeys: precomputeAssistantTurnSlotKeys(input.turns),
    run: input.run,
    transcriptNodesByRunId,
    live: input.live,
    workView: input.workView,
    pending: input.pending,
  });
  return {
    state: {
      conversationId: input.conversationId,
      emptyAssistantShells: assistantShellSnapshot(input.turns),
      transcriptNodesByRunId,
      assistantDisplaysByTurnId: assistantDisplays.displays,
      assistantWorkflowsByTurnId: assistantDisplays.workflows,
      assistantWorkflowsByRunId: assistantWorkflowsByRunIdForTurns(
        previous?.assistantWorkflowsByRunId,
        input.projectedTurns,
        assistantDisplays.workflows,
      ),
      standaloneAssistant: previous?.standaloneAssistant,
    },
    assistantDisplays: assistantDisplays.displays,
  };
}

export function projectStandaloneAssistantWorkflowDisplay<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(input: {
  readonly previous?: ConversationWorkflowDisplayState<TTurn, TNode, TDeliverable, TPending>;
  readonly conversationId?: string;
  readonly key: string;
  readonly runId?: string;
  readonly content: string;
  readonly deliverable?: AssistantDeliverableLike;
  readonly terminalStatus?: AssistantTerminalStatus;
  readonly transcriptNodes?: readonly TNode[];
  readonly pending?: TPending;
  readonly live?: boolean;
  readonly keepStreamMounted?: boolean;
  readonly animateOnMount?: boolean;
  readonly liveTone?: LiveAnswerTone;
  readonly collapseTimeline: boolean;
}): {
  readonly nextStandalone: NonNullable<ConversationWorkflowDisplayState<TTurn, TNode, TDeliverable, TPending>["standaloneAssistant"]>;
  readonly workflow: AssistantWorkflowDisplay<TNode, TPending>;
  readonly failure?: AssistantFailureParts;
} {
  const previous = conversationWorkflowDisplayStateForConversation(input.previous, input.conversationId);
  const previousRunWorkflow = input.runId === undefined
    ? undefined
    : previous?.assistantWorkflowsByRunId.get(input.runId);
  const previousWorkflow = previousRunWorkflow ?? (previous?.standaloneAssistant?.key === input.key
    ? previous.standaloneAssistant.workflow
    : undefined);
  const failure = input.terminalStatus === undefined ? undefined : assistantFailureParts(input.content);
  const workflowTranscriptNodes = transcriptNodesWithoutFailureEcho(
    input.transcriptNodes,
    failure,
  );
  const workflow = projectStableAssistantWorkflowDisplay({
    previous: previousWorkflow,
    content: failure?.previous ?? input.content,
    deliverable: failure === undefined ? input.deliverable : undefined,
    transcriptNodes: workflowTranscriptNodes,
    pending: input.pending,
    live: input.live,
    keepStreamMounted: input.keepStreamMounted,
    animateOnMount: input.animateOnMount,
    liveTone: input.liveTone,
    collapseTimeline: input.collapseTimeline,
  });
  return {
    nextStandalone: {
      key: input.key,
      runId: input.runId,
      workflow,
    },
    workflow: workflow.workflow,
    failure,
  };
}

function conversationWorkflowDisplayStateForConversation<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(
  previous: ConversationWorkflowDisplayState<TTurn, TNode, TDeliverable, TPending> | undefined,
  conversationId: string | undefined,
): ConversationWorkflowDisplayState<TTurn, TNode, TDeliverable, TPending> | undefined {
  return previous?.conversationId === conversationId ? previous : undefined;
}

function previousAssistantWorkflowsForTurns<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
>(
  previous: ConversationWorkflowDisplayState<TTurn, TNode, TDeliverable, TPending> | undefined,
  projectedTurns: readonly WorklineProjectedTurn<TTurn>[],
): ReadonlyMap<string, AssistantWorkflowDisplayState<TNode, TPending>> | undefined {
  if (previous === undefined) {
    return undefined;
  }
  const workflows = new Map(previous.assistantWorkflowsByTurnId);
  for (const projection of projectedTurns) {
    if (projection.turn.role !== "assistant" || projection.displayRunId === undefined) {
      continue;
    }
    const workflow = previous.assistantWorkflowsByRunId.get(projection.displayRunId);
    if (workflow !== undefined) {
      workflows.set(projection.turn.turnId, workflow);
    }
  }
  return workflows;
}

function assistantWorkflowsByRunIdForTurns<
  TTurn extends WorklineConversationTurn,
  TNode extends AssistantTranscriptNodeLike,
  TPending extends ConfirmationIdentity,
>(
  previous: ReadonlyMap<string, AssistantWorkflowDisplayState<TNode, TPending>> | undefined,
  projectedTurns: readonly WorklineProjectedTurn<TTurn>[],
  workflowsByTurnId: ReadonlyMap<string, AssistantWorkflowDisplayState<TNode, TPending>>,
): ReadonlyMap<string, AssistantWorkflowDisplayState<TNode, TPending>> {
  const workflows = new Map<string, AssistantWorkflowDisplayState<TNode, TPending>>();
  for (const projection of projectedTurns) {
    if (projection.turn.role !== "assistant" || projection.displayRunId === undefined) {
      continue;
    }
    const workflow = workflowsByTurnId.get(projection.turn.turnId) ?? previous?.get(projection.displayRunId);
    if (workflow !== undefined) {
      workflows.set(projection.displayRunId, workflow);
    }
  }
  return workflows;
}
