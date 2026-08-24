import {
  projectAssistantMessageView,
  type AssistantMessageSegment,
  type AssistantMessageView,
} from "./panel-assistant-message-view.js";
import type { AssistantMessageSegmentLifecycle } from "./panel-assistant-message-structure.js";
import {
  timelineCollapseDecision,
  type TimelineCollapseReason,
} from "./panel-assistant-timeline-collapse.js";
import type { ConfirmationIdentity } from "../transcript/panel-transcript-confirmation-projection.js";
import type { ProjectableTranscriptNode } from "../transcript/panel-transcript-node-projection.js";
import type {
  AssistantDeliverableLike,
} from "./panel-assistant-message-output.js";
import type { LiveAnswerTone } from "../transcript/panel-live-transcript.js";

export type AssistantWorkflowDisplaySegment<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
> =
  | {
      readonly kind: "activity";
      readonly segmentKey: string;
      readonly lifecycle: AssistantMessageSegmentLifecycle;
      readonly collapsed: boolean;
      readonly collapseReason: TimelineCollapseReason;
      readonly timeline: Extract<AssistantMessageSegment<TNode, TConfirmation>, { readonly kind: "activity" }>["timeline"];
    }
  | Extract<AssistantMessageSegment<TNode, TConfirmation>, { readonly kind: "body" | "awaiting" }>;

export type AssistantWorkflowDisplay<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
> = {
  readonly hasTimeline: boolean;
  readonly awaitingFirstVisibleOutput: boolean;
  readonly showCopyActions: boolean;
  readonly copyText: string;
  readonly segments: readonly AssistantWorkflowDisplaySegment<TNode, TConfirmation>[];
};

export type AssistantWorkflowDisplayState<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
> = {
  readonly messageView: AssistantMessageView<TNode, TConfirmation>;
  readonly workflow: AssistantWorkflowDisplay<TNode, TConfirmation>;
};

export function projectStableAssistantWorkflowDisplay<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
>(input: {
  readonly previous?: AssistantWorkflowDisplayState<TNode, TConfirmation>;
  readonly content: string;
  readonly deliverable?: AssistantDeliverableLike;
  readonly transcriptNodes?: readonly TNode[];
  readonly pending?: TConfirmation;
  readonly live?: boolean;
  readonly keepStreamMounted?: boolean;
  readonly animateOnMount?: boolean;
  readonly liveTone?: LiveAnswerTone;
  readonly collapseTimeline: boolean;
}): AssistantWorkflowDisplayState<TNode, TConfirmation> {
  const keepStreamMounted = input.keepStreamMounted === true;
  const live = input.live === true;
  const rawView = projectAssistantMessageView<TNode, TConfirmation>({
    content: input.content,
    deliverable: input.deliverable,
    transcriptNodes: input.transcriptNodes,
    pending: input.pending,
    live,
    keepStreamMounted,
    animateOnMount: input.animateOnMount,
    liveTone: input.liveTone,
    preferTranscriptBodies: keepStreamMounted || live,
  });
  // Transcript facts are projected from the current canonical nodes only.
  // Previous workflow state may influence disclosure presentation below, but
  // it must never decide which reasoning/body/tool facts exist.
  const messageView = rawView;
  const workflow = workflowDisplayFromMessageView({
    previous: input.previous?.workflow,
    messageView,
    showCopyActions: !keepStreamMounted,
    collapseTimeline: input.collapseTimeline,
  });
  return {
    messageView,
    workflow,
  };
}

function workflowDisplayFromMessageView<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(input: {
  readonly previous?: AssistantWorkflowDisplay<TNode, TConfirmation>;
  readonly messageView: AssistantMessageView<TNode, TConfirmation>;
  readonly showCopyActions: boolean;
  readonly collapseTimeline: boolean;
}): AssistantWorkflowDisplay<TNode, TConfirmation> {
  const hasBodySegments = input.messageView.segments.some((segment) => segment.kind === "body");
  return {
    hasTimeline: input.messageView.hasTimeline,
    awaitingFirstVisibleOutput: input.messageView.awaitingFirstVisibleOutput,
    showCopyActions: input.showCopyActions,
    copyText: input.messageView.copyText,
    segments: input.messageView.segments.map((segment) => {
      if (segment.kind !== "activity") {
        return segment;
      }
      const currentDecision = timelineCollapseDecision({
        collapseTimeline: input.collapseTimeline,
        defaultCollapsed: segment.defaultCollapsed,
        lifecycle: segment.lifecycle,
        items: segment.timeline.items,
        hasCurrentConfirmation: segment.timeline.confirmation.current !== undefined,
        hasBodySegments,
      });
      const forceVisible = activitySegmentForcesVisible(segment);
      // When the turn has definitively settled, override orphaned
      // intermediate phases (executing/noted/preparing) that were never
      // reconciled by a terminal tool/note event.
      const settledOverride =
        input.collapseTimeline &&
        !forceVisible &&
        !currentDecision.collapsed &&
        currentDecision.reason !== "needs_attention"
          ? { collapsed: true, reason: "turn_settled" as const }
          : undefined;
      const effectiveDecision = forceVisible
        ? { collapsed: false, reason: "expanded" as const }
        : settledOverride ?? currentDecision;
      const previousCollapse = previousCollapseState(input.previous, segment.segmentKey);
      const inheritPreviousCollapse = previousCollapse.collapsed &&
        segment.lifecycle === "settled" &&
        !forceVisible &&
        !activitySegmentNeedsAttention(segment, effectiveDecision);
      return {
        kind: "activity",
        segmentKey: segment.segmentKey,
        lifecycle: settledOverride ? "settled" as const : segment.lifecycle,
        timeline: segment.timeline,
        collapsed: inheritPreviousCollapse || effectiveDecision.collapsed,
        collapseReason: inheritPreviousCollapse ? previousCollapse.reason : effectiveDecision.reason,
      };
    }),
  };
}

function activitySegmentForcesVisible<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(
  segment: Extract<AssistantMessageSegment<TNode, TConfirmation>, { readonly kind: "activity" }>,
): boolean {
  return segment.timeline.items.some((item) => item.variant === "context_compaction");
}

function activitySegmentNeedsAttention<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(
  segment: Extract<AssistantMessageSegment<TNode, TConfirmation>, { readonly kind: "activity" }>,
  decision: { readonly reason: TimelineCollapseReason },
): boolean {
  return segment.lifecycle === "attention" ||
    segment.timeline.confirmation.current !== undefined ||
    decision.reason === "needs_attention";
}

function previousCollapseState<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(
  previous: AssistantWorkflowDisplay<TNode, TConfirmation> | undefined,
  segmentKey: string,
): { readonly collapsed: boolean; readonly reason: TimelineCollapseReason } {
  const segment = previous?.segments.find((item) => item.kind === "activity" && item.segmentKey === segmentKey);
  return segment?.kind === "activity"
    ? { collapsed: segment.collapsed, reason: segment.collapseReason }
    : { collapsed: false, reason: "expanded" };
}
