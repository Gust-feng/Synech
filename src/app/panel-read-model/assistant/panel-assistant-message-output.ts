import { firstNonEmptyText } from "./panel-assistant-output.js";
import { normalizeComparableText, userVisibleAnswer } from "./panel-assistant-visible-text.js";

export type DeliverableFileChangeLike = {
  readonly kind?: string;
  readonly path?: string;
  readonly summary?: string;
  readonly preview?: string;
  readonly bytes?: number;
  readonly replacements?: number;
  readonly previousLength?: number;
  readonly nextLength?: number;
  readonly append?: boolean;
  readonly truncated?: boolean;
};

export type AssistantDeliverableLike = {
  readonly title: string;
  readonly summary: string;
  readonly sections: readonly {
    readonly title: string;
    readonly content: string;
  }[];
  readonly fileChanges?: readonly DeliverableFileChangeLike[];
  readonly nextActions?: readonly string[];
};

export type AssistantWorkViewOutput<TDeliverable extends AssistantDeliverableLike> = {
  readonly run: {
    readonly runId: string;
  };
  readonly answer?: {
    readonly content?: string;
  };
  readonly deliverable?: TDeliverable;
};

export type AssistantMessageOutput = {
  readonly text: string;
  readonly hasAnswer: boolean;
};

export function assistantMessageOutput(input: {
  readonly content: string;
  readonly deliverable?: AssistantDeliverableLike;
}): AssistantMessageOutput {
  const visible = userVisibleAnswer(input.content);
  const fallbackDeliverableText = input.deliverable === undefined ? "" : deliverableAsLinearText(input.deliverable);
  const text = visible.trim().length > 0 ? visible : fallbackDeliverableText;
  return {
    text,
    hasAnswer: text.trim().length > 0,
  };
}

export function answerForWorkViewTurn<TDeliverable extends AssistantDeliverableLike>(
  workView: AssistantWorkViewOutput<TDeliverable> | undefined,
  runId: string | undefined,
  fallback: string
): string {
  if (runId === undefined || workView?.run.runId !== runId) {
    return fallback;
  }
  return firstNonEmptyText([workView.answer?.content, fallback]) ?? "";
}

export function deliverableForWorkViewTurn<TDeliverable extends AssistantDeliverableLike>(
  workView: AssistantWorkViewOutput<TDeliverable> | undefined,
  runId: string | undefined,
  answer: string | undefined
): TDeliverable | undefined {
  if (runId === undefined || workView?.run.runId !== runId) {
    return undefined;
  }
  return visibleDeliverable(workView.deliverable, answer, answer);
}

export function visibleDeliverable<TDeliverable extends AssistantDeliverableLike>(
  deliverable: TDeliverable | undefined,
  answer: string | undefined,
  latestAssistantContent: string | undefined
): TDeliverable | undefined {
  if (deliverable === undefined) return undefined;
  if (isDuplicateAnswerDeliverable(deliverable, answer) || isDuplicateAnswerDeliverable(deliverable, latestAssistantContent)) {
    return undefined;
  }
  return deliverable;
}

export function deliverableAsLinearText(deliverable: AssistantDeliverableLike): string {
  const parts = [
    `## ${deliverable.title}`,
    deliverable.summary,
    ...deliverable.sections.slice(0, 4).flatMap((section) => [
      `### ${section.title}`,
      section.content,
    ]),
  ];
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function isDuplicateAnswerDeliverable(deliverable: AssistantDeliverableLike, answer: string | undefined): boolean {
  if (answer === undefined || answer.trim().length === 0) return false;
  const normalizedAnswer = normalizeComparableText(answer);
  if (normalizeComparableText(deliverable.summary) === normalizedAnswer) return true;
  return deliverable.sections.some((section) => normalizeComparableText(section.content) === normalizedAnswer);
}
