import {
  assistantMessageOutput,
  type AssistantDeliverableLike,
} from "./panel-assistant-message-output.js";
import {
  projectAssistantMessageStructure,
  type AssistantMessageSegment,
  type AssistantMessageStructure,
} from "./panel-assistant-message-structure.js";
import type { ConfirmationIdentity } from "../transcript/panel-transcript-confirmation-projection.js";
import type { ProjectableTranscriptNode } from "../transcript/panel-transcript-node-projection.js";
import type { LiveAnswerTone } from "../transcript/panel-live-transcript.js";

export type { AssistantMessageSegment, AssistantMessageStructure };

export type AssistantMessageAnswerView = {
  readonly text: string;
  readonly copyText: string;
  readonly showActions: boolean;
  readonly live: boolean;
  readonly animateOnMount: boolean;
  readonly tone: LiveAnswerTone;
};

export type AssistantMessageView<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
> = AssistantMessageStructure<TNode, TConfirmation> & {
  readonly answer?: AssistantMessageAnswerView;
};

export function projectAssistantMessageView<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
>(input: {
  readonly content: string;
  readonly deliverable?: AssistantDeliverableLike;
  readonly transcriptNodes?: readonly TNode[];
  readonly pending?: TConfirmation;
  readonly live?: boolean;
  readonly keepStreamMounted?: boolean;
  readonly animateOnMount?: boolean;
  readonly liveTone?: LiveAnswerTone;
  readonly preferTranscriptBodies?: boolean;
}): AssistantMessageView<TNode, TConfirmation> {
  const output = assistantMessageOutput({ content: input.content, deliverable: input.deliverable });
  const live = input.live === true;
  const keepStreamMounted = live || input.keepStreamMounted === true;
  const animateAnswerOnMount = input.animateOnMount === true;
  const tone = input.liveTone ?? "formal";
  const structure = projectAssistantMessageStructure<TNode, TConfirmation>({
    fallbackText: output.hasAnswer ? output.text : undefined,
    transcriptNodes: input.transcriptNodes,
    pending: input.pending,
    live,
    keepStreamMounted,
    animateOnMount: animateAnswerOnMount,
    liveTone: tone,
    preferTranscriptBodies: input.preferTranscriptBodies,
  });
  return {
    ...structure,
    answer: output.hasAnswer
      ? {
          text: output.text,
          copyText: output.text,
          showActions: !keepStreamMounted,
          live: keepStreamMounted,
          animateOnMount: animateAnswerOnMount,
          tone,
        }
      : undefined,
  };
}
