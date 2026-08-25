import {
  projectChatActive,
  type ChatActiveConversation,
  type ChatActiveProjection,
  type ChatActiveRun,
  type ChatActiveStatusNotice,
  type ChatActiveTranscriptNode,
} from "./active-projection.js";
import type { LiveRunBuffer } from "@panel-api/ui-read-model";
import {
  resolveAssistantAnswer,
  visibleDeliverable,
  type AssistantDeliverableLike,
} from "@panel-api/ui-read-model";
import {
  visibleResultText,
  visibleRunProblem,
  type AssistantRunDetailLike,
  type AssistantWorkViewProblemLike,
} from "@panel-api/ui-read-model";
import { activityVisibleNodes } from "@panel-api/ui-read-model";
import type { ConfirmationIdentity } from "@panel-api/ui-read-model";

export type ChatActiveWorkViewLike<
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
  TNode extends ChatActiveTranscriptNode,
> = AssistantWorkViewProblemLike & {
  readonly run: {
    readonly runId: string;
  };
  readonly answer?: {
    readonly content?: string;
  };
  readonly deliverable?: TDeliverable;
  readonly pendingConfirmation?: TPending;
  readonly transcriptNodes?: readonly TNode[];
};

export type ChatActiveDetailLike<TNode extends ChatActiveTranscriptNode> = AssistantRunDetailLike & {
  readonly runId?: string;
  readonly transcript?: {
    readonly transcriptNodes?: readonly TNode[];
  };
};

export type ChatActiveViewInput<
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
  TNode extends ChatActiveTranscriptNode,
> = {
  readonly conversation?: ChatActiveConversation;
  readonly run?: ChatActiveRun;
  readonly workView?: ChatActiveWorkViewLike<TDeliverable, TPending, TNode>;
  readonly transcriptNodes: readonly TNode[];
  readonly detail?: ChatActiveDetailLike<TNode>;
  readonly live?: LiveRunBuffer;
  readonly error?: string;
  readonly pendingConfirmation?: TPending;
};

export type ChatActiveViewProjection<
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
> = ChatActiveProjection<TDeliverable, TPending>;

export type { ChatActiveStatusNotice as ChatStatusNotice };

export function projectChatActiveView<
  TDeliverable extends AssistantDeliverableLike,
  TPending extends ConfirmationIdentity,
  TNode extends ChatActiveTranscriptNode,
>(input: ChatActiveViewInput<TDeliverable, TPending, TNode>): ChatActiveViewProjection<TDeliverable, TPending> {
  const transcriptNodes = activityVisibleNodes(input.transcriptNodes);
  const currentRunId = input.run?.runId ?? input.conversation?.activeRunId ?? input.conversation?.latestRunId ?? input.live?.runId;
  const currentRunAssistantTurn = currentRunId === undefined
    ? undefined
    : [...(input.conversation?.turns ?? [])].reverse().find((turn) => (
        turn.role === "assistant" &&
        turn.runId === currentRunId &&
        turn.content.trim().length > 0
      ));
  const detailAnswer = input.detail?.runId === undefined || currentRunId === undefined || input.detail.runId === currentRunId
    ? visibleResultText(input.detail)
    : undefined;
  const workViewAnswer = input.workView?.answer?.content;
  const resolvedAnswer = resolveAssistantAnswer({
    runStatus: input.run?.status ?? currentRunAssistantTurn?.status,
    interruption: currentRunAssistantTurn?.interruption,
    conversationText: currentRunAssistantTurn?.content,
    workViewText: workViewAnswer,
    projection: detailAnswer === undefined ? undefined : { text: detailAnswer },
  });
  const answer = resolvedAnswer.source === "none" ? undefined : resolvedAnswer.text;
  const pending = input.workView?.pendingConfirmation ?? input.pendingConfirmation;
  return projectChatActive({
    conversation: input.conversation,
    run: input.run,
    transcriptNodes,
    live: input.live,
    workViewAnswer,
    detailAnswer,
    pending,
    deliverable: visibleDeliverable(input.workView?.deliverable, answer, currentRunAssistantTurn?.content),
    problem: visibleRunProblem(input.run, input.workView, input.detail, input.error),
    appError: input.error,
  });
}
