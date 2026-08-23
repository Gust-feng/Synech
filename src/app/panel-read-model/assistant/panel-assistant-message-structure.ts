import {
  projectAgentWorkTimelineView,
  type AgentWorkTimelineView,
} from "./panel-agent-work-timeline-view.js";
import {
  isVisibleOrdinaryActivityItem,
  type ActivityItem,
} from "../transcript/panel-transcript-activity-copy.js";
import type { ModelUsage } from "../../../domain/intelligence/index.js";
import {
  isModelNarrativeActivityItem,
  mergeModelNarrativeActivityItem,
  sameModelNarrativeActivity,
} from "./panel-assistant-activity-identity.js";
import { assistantActivitySegmentKey } from "./panel-assistant-segment-identity.js";
import type { ConfirmationIdentity } from "../transcript/panel-transcript-confirmation-projection.js";
import {
  isModelSideOutputNode,
  type ProjectableTranscriptNode,
  timelineVisibleNodes,
} from "../transcript/panel-transcript-node-projection.js";
import type { LiveAnswerTone } from "../transcript/panel-live-transcript.js";

export type AssistantMessageSegmentLifecycle = "open" | "settled" | "attention";

export type AssistantMessageSegment<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
> =
  | {
      readonly kind: "activity";
      readonly segmentKey: string;
      readonly lifecycle: AssistantMessageSegmentLifecycle;
      readonly defaultCollapsed: boolean;
      readonly timeline: AgentWorkTimelineView<TNode, TConfirmation>;
    }
  | {
      readonly kind: "body";
      readonly segmentKey: string;
      readonly lifecycle: AssistantMessageSegmentLifecycle;
      readonly text: string;
      readonly copyText: string;
      readonly live: boolean;
      readonly animateOnMount: boolean;
      readonly tone: LiveAnswerTone;
      readonly modelUsage?: ModelUsage;
    }
  | {
      readonly kind: "awaiting";
      readonly lifecycle: AssistantMessageSegmentLifecycle;
      readonly reason: "initial" | "continuation";
    };

export type AssistantMessageStructure<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
> = {
  readonly timeline: AgentWorkTimelineView<TNode, TConfirmation>;
  readonly hasTimeline: boolean;
  readonly awaitingFirstVisibleOutput: boolean;
  readonly segments: readonly AssistantMessageSegment<TNode, TConfirmation>[];
  readonly copyText: string;
};

export function projectAssistantMessageStructure<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
>(input: {
  readonly fallbackText?: string;
  readonly transcriptNodes?: readonly TNode[];
  readonly pending?: TConfirmation;
  readonly live?: boolean;
  readonly keepStreamMounted?: boolean;
  readonly animateOnMount?: boolean;
  readonly liveTone?: LiveAnswerTone;
  readonly preferTranscriptBodies?: boolean;
}): AssistantMessageStructure<TNode, TConfirmation> {
  const transcriptNodes = input.transcriptNodes ?? [];
  const live = input.live === true;
  const keepStreamMounted = live || input.keepStreamMounted === true;
  const animateOnMount = input.animateOnMount === true;
  const tone = input.liveTone ?? "formal";
  const preferTranscriptBodies = input.preferTranscriptBodies === true || keepStreamMounted;
  const bodySegments = assistantBodySegments<TNode, TConfirmation>({
    transcriptNodes,
    fallbackText: input.fallbackText,
    live,
    animateOnMount,
    tone,
    preferTranscriptBodies,
  });
  const timelineNodes = assistantTimelineNodes(transcriptNodes);
  const timeline = projectAgentWorkTimelineView<TNode, TConfirmation>({
    nodes: timelineNodes,
    pending: input.pending,
  });
  const segments = assistantMessageSegments({
    transcriptNodes,
    pending: input.pending,
    bodySegments,
    awaiting: bodySegments.length === 0 &&
      !assistantResponseHasStarted(timeline) &&
      keepStreamMounted,
  });
  return {
    timeline,
    hasTimeline: timeline.hasContent,
    awaitingFirstVisibleOutput: assistantMessageAwaitingFirstVisibleOutput(segments),
    segments,
    copyText: assistantMessageCopyTextFromSegments(segments),
  };
}

function assistantResponseHasStarted<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(timeline: AgentWorkTimelineView<TNode, TConfirmation>): boolean {
  if (timeline.confirmation.current !== undefined) {
    return true;
  }
  // The waiting indicator may only yield to activity that the Ordinary
  // presentation can actually render. Internal narration or request setup
  // must not create an empty workflow frame between waiting and model text.
  return timeline.items.some(isVisibleOrdinaryActivityItem);
}

export function assistantMessageHasTimeline<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
>(
  segments: readonly AssistantMessageSegment<TNode, TConfirmation>[],
): boolean {
  return segments.some((segment) => segment.kind === "activity");
}

export function assistantMessageAwaitingFirstVisibleOutput<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
>(
  segments: readonly AssistantMessageSegment<TNode, TConfirmation>[],
): boolean {
  return segments.some((segment) => segment.kind === "awaiting" && segment.reason === "initial");
}

export function assistantMessageCopyTextFromSegments<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
>(
  segments: readonly AssistantMessageSegment<TNode, TConfirmation>[],
): string {
  return segments
    .filter((segment): segment is Extract<AssistantMessageSegment<TNode, TConfirmation>, { readonly kind: "body" }> => segment.kind === "body")
    .map((segment) => segment.copyText.trim())
    .filter((value) => value.length > 0)
    .join("\n\n");
}

export function assistantActivitySegmentLifecycle<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
>(
  timeline: AgentWorkTimelineView<TNode, TConfirmation>,
): AssistantMessageSegmentLifecycle {
  return activitySegmentLifecycle(timeline);
}

function assistantBodySegments<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
>(input: {
  readonly transcriptNodes: readonly TNode[];
  readonly fallbackText?: string;
  readonly live: boolean;
  readonly animateOnMount: boolean;
  readonly tone: LiveAnswerTone;
  readonly preferTranscriptBodies: boolean;
}): readonly BodySegmentWithNodeId<TNode, TConfirmation>[] {
  const bodyNodes = input.transcriptNodes
    .filter((node) => node.kind === "body")
    .filter((node) => (node.text ?? node.summary ?? "").trim().length > 0)
    .sort((left, right) => left.sequence - right.sequence || left.nodeId.localeCompare(right.nodeId));
  const drafts = bodyNodes.map((node) => {
    const text = (node.text ?? node.summary ?? "").trim();
    return {
      kind: "body" as const,
      segmentKey: `body:${node.nodeId}`,
      nodeId: node.nodeId,
      sequence: node.sequence,
      phase: node.phase === "noted" ? "noted" as const : "completed" as const,
      text,
      copyText: text,
      tone: input.tone,
      modelUsage: node.modelUsage,
    };
  });
  const fallbackText = input.fallbackText?.trim();
  const fallbackModelUsage = latestAnswerModelUsage(input.transcriptNodes);
  if (bodyNodes.length > 0 || input.preferTranscriptBodies) {
    return finalizeBodySegments(drafts, input.animateOnMount);
  }
  if (fallbackText === undefined || fallbackText.length === 0) {
    return finalizeBodySegments(drafts, input.animateOnMount);
  }
  return finalizeBodySegments(
    [fallbackBodyDraft<TNode, TConfirmation>({
      text: fallbackText,
      live: input.live,
      tone: input.tone,
      modelUsage: fallbackModelUsage,
    })],
    input.animateOnMount,
  );
}

function fallbackBodyDraft<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(fallback: {
  readonly text: string;
  readonly live: boolean;
  readonly tone: LiveAnswerTone;
  readonly modelUsage?: ModelUsage;
}): BodySegmentDraft<TNode, TConfirmation> {
  return {
    kind: "body",
    segmentKey: "body:fallback",
    nodeId: undefined,
    sequence: Number.POSITIVE_INFINITY,
    phase: fallback.live ? "noted" : "completed",
    text: fallback.text,
    copyText: fallback.text,
    tone: fallback.tone,
    modelUsage: fallback.modelUsage,
  };
}

function latestAnswerModelUsage<TNode extends ProjectableTranscriptNode>(
  nodes: readonly TNode[],
): ModelUsage | undefined {
  return [...nodes]
    .reverse()
    .find((node) => node.kind === "answer" && node.modelUsage !== undefined)
    ?.modelUsage;
}

function finalizeBodySegments<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(
  drafts: readonly BodySegmentDraft<TNode, TConfirmation>[],
  animateOnMount: boolean,
): readonly BodySegmentWithNodeId<TNode, TConfirmation>[] {
  const lastIndex = drafts.length - 1;
  return drafts.map((draft, index) => ({
    ...draft,
    live: draft.phase === "noted",
    lifecycle: draft.phase === "noted" ? "open" : "settled",
    animateOnMount: animateOnMount && index === lastIndex,
  }));
}

function assistantMessageSegments<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
>(input: {
  readonly transcriptNodes: readonly TNode[];
  readonly pending?: TConfirmation;
  readonly bodySegments: readonly BodySegmentWithNodeId<TNode, TConfirmation>[];
  readonly awaiting: boolean;
}): readonly AssistantMessageSegment<TNode, TConfirmation>[] {
  if (input.awaiting) {
    return [{ kind: "awaiting", lifecycle: "open", reason: "initial" }];
  }
  const activityNodes = assistantTimelineNodes(input.transcriptNodes);
  const activityNodesById = new Map(activityNodes.map((node) => [node.nodeId, node]));
  if (input.bodySegments.length === 0) {
    const timeline = projectAgentWorkTimelineView<TNode, TConfirmation>({
      nodes: activityNodes,
      pending: input.pending,
    });
    return timeline.hasContent ? [{
      kind: "activity",
      segmentKey: assistantActivitySegmentKey({
        nodes: activityNodes,
        items: timeline.items,
        pending: input.pending,
        fallbackIndex: 0,
      }),
      lifecycle: activitySegmentLifecycle(timeline),
      defaultCollapsed: false,
      timeline,
    }] : [];
  }
  const result: AssistantMessageSegment<TNode, TConfirmation>[] = [];
  let pendingRendered = false;
  let activityBucket: TNode[] = [];
  const bodySegmentsByNodeId = new Map(
    input.bodySegments
      .filter((segment) => segment.nodeId !== undefined)
      .map((segment) => [segment.nodeId, segment]),
  );
  const fallbackBodySegments = input.bodySegments.filter((segment) => segment.nodeId === undefined);
  const pushActivity = (nodes: readonly TNode[], includeUnmatchedPending: boolean): void => {
    const pending = pendingForActivitySegment({
      nodes,
      pending: input.pending,
      pendingRendered,
      includeUnmatchedPending,
    });
    const timeline = projectAgentWorkTimelineView<TNode, TConfirmation>({ nodes, pending });
    if (timeline.hasContent) {
      result.push({
        kind: "activity",
        segmentKey: assistantActivitySegmentKey({
          nodes,
          items: timeline.items,
          pending,
          fallbackIndex: result.length,
        }),
        lifecycle: activitySegmentLifecycle(timeline),
        defaultCollapsed: false,
        timeline,
      });
      if (pending !== undefined) {
        pendingRendered = true;
      }
    }
  };
  const sortedNodes = [...input.transcriptNodes].sort(compareAssistantMessageNodeOrder);
  for (const node of sortedNodes) {
    const body = node.kind === "body" ? bodySegmentsByNodeId.get(node.nodeId) : undefined;
    if (body !== undefined) {
      pushActivity(activityBucket, false);
      activityBucket = [];
      result.push(body);
      continue;
    }
    const activityNode = activityNodesById.get(node.nodeId);
    if (activityNode !== undefined) {
      activityBucket.push(activityNode);
    }
  }
  pushActivity(activityBucket, true);
  for (const body of fallbackBodySegments) {
    result.push(body);
  }
  return withActivityCollapseHints(
    removeRepeatedModelActivityAcrossSegments(result),
  );
}

type BodySegmentWithNodeId<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
> = Extract<AssistantMessageSegment<TNode, TConfirmation>, { readonly kind: "body" }> & {
  readonly nodeId?: string;
  readonly sequence: number;
  readonly phase: "completed" | "noted";
};

type BodySegmentDraft<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
> = Omit<BodySegmentWithNodeId<TNode, TConfirmation>, "live" | "animateOnMount" | "lifecycle">;

function pendingForActivitySegment<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(input: {
  readonly nodes: readonly TNode[];
  readonly pending?: TConfirmation;
  readonly pendingRendered: boolean;
  readonly includeUnmatchedPending: boolean;
}): TConfirmation | undefined {
  if (input.pending === undefined || input.pendingRendered) {
    return undefined;
  }
  const hasMatchingConfirmationNode = input.nodes.some((node) =>
    node.kind === "confirmation" &&
    node.confirmation?.confirmationId === input.pending?.confirmationId,
  );
  if (hasMatchingConfirmationNode) {
    return input.pending;
  }
  return input.includeUnmatchedPending ? input.pending : undefined;
}

function assistantTimelineNodes<TNode extends ProjectableTranscriptNode>(nodes: readonly TNode[]): readonly TNode[] {
  return timelineVisibleNodes(nodes);
}

function removeRepeatedModelActivityAcrossSegments<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(
  segments: readonly AssistantMessageSegment<TNode, TConfirmation>[],
): readonly AssistantMessageSegment<TNode, TConfirmation>[] {
  const represented: RepresentedModelActivity[] = [];
  const result: AssistantMessageSegment<TNode, TConfirmation>[] = [];
  for (const segment of segments) {
    if (segment.kind !== "activity") {
      result.push(segment);
      continue;
    }
    const items: ActivityItem[] = [];
    const nextRepresented: Array<{ readonly itemIndex: number; readonly item: ActivityItem }> = [];
    for (const item of segment.timeline.items) {
      if (!isModelNarrativeActivityItem(item)) {
        items.push(item);
        continue;
      }
      const duplicate = represented.find((previous) => sameModelNarrativeActivity(previous.item, item));
      if (duplicate !== undefined) {
        mergeRepresentedModelActivity(result, duplicate, item);
        continue;
      }
      const localDuplicateIndex = items.findIndex((existing) =>
        isModelNarrativeActivityItem(existing) && sameModelNarrativeActivity(existing, item)
      );
      if (localDuplicateIndex >= 0) {
        const existing = items[localDuplicateIndex];
        if (existing !== undefined) {
          items[localDuplicateIndex] = mergeModelNarrativeActivityItem(existing, item);
        }
        continue;
      }
      nextRepresented.push({ itemIndex: items.length, item });
      items.push(item);
    }
    const resultIndex = result.length;
    if (items.length === segment.timeline.items.length) {
      result.push(segment);
      for (const entry of nextRepresented) {
        represented.push({
          segmentIndex: resultIndex,
          itemIndex: entry.itemIndex,
          item: entry.item,
        });
      }
      continue;
    }
    const hasContent = items.length > 0 || segment.timeline.confirmation.current !== undefined;
    if (!hasContent) {
      continue;
    }
    const itemNodeIds = new Set(items.map((item) => item.nodeId));
    const timeline = {
      ...segment.timeline,
      items,
      nodes: segment.timeline.nodes.filter((node) =>
        itemNodeIds.has(node.nodeId) ||
        (node.kind === "confirmation" && segment.timeline.confirmation.currentNodeId === node.nodeId)
      ),
      hasContent,
    };
    result.push({
      ...segment,
      segmentKey: assistantActivitySegmentKey({
        nodes: timeline.nodes,
        items,
        pending: timeline.confirmation.current,
        fallbackKey: segment.segmentKey,
      }),
      lifecycle: activitySegmentLifecycle(timeline),
      timeline,
    });
    const pushed = result[resultIndex];
    if (pushed?.kind === "activity") {
      for (const entry of nextRepresented) {
        const representedItem = pushed.timeline.items[entry.itemIndex];
        if (representedItem === undefined || !isModelNarrativeActivityItem(representedItem)) {
          continue;
        }
        represented.push({
          segmentIndex: resultIndex,
          itemIndex: entry.itemIndex,
          item: representedItem,
        });
      }
    }
  }
  return result;
}

type RepresentedModelActivity = {
  readonly segmentIndex: number;
  readonly itemIndex: number;
  readonly item: ActivityItem;
};

function mergeRepresentedModelActivity<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(
  result: AssistantMessageSegment<TNode, TConfirmation>[],
  represented: RepresentedModelActivity,
  incoming: ActivityItem,
): void {
  const segment = result[represented.segmentIndex];
  if (segment?.kind !== "activity") {
    return;
  }
  const current = segment.timeline.items[represented.itemIndex];
  if (current === undefined || !sameModelNarrativeActivity(current, incoming)) {
    return;
  }
  const merged = mergeModelNarrativeActivityItem(current, incoming);
  if (merged === current) {
    return;
  }
  const items = segment.timeline.items.map((item, index) => index === represented.itemIndex ? merged : item);
  const timeline = {
    ...segment.timeline,
    items,
  };
  result[represented.segmentIndex] = {
    ...segment,
    lifecycle: activitySegmentLifecycle(timeline),
    timeline,
  };
}

function withActivityCollapseHints<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(
  segments: readonly AssistantMessageSegment<TNode, TConfirmation>[],
): readonly AssistantMessageSegment<TNode, TConfirmation>[] {
  return segments.map((segment, index) => {
    if (segment.kind !== "activity") {
      return segment;
    }
    return {
      kind: "activity",
      segmentKey: segment.segmentKey,
      lifecycle: segment.lifecycle,
      defaultCollapsed: shouldDefaultCollapseActivitySegment(segments, index, segment),
      timeline: segment.timeline,
    };
  });
}

function shouldDefaultCollapseActivitySegment<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(
  segments: readonly AssistantMessageSegment<TNode, TConfirmation>[],
  index: number,
  segment: Extract<AssistantMessageSegment<TNode, TConfirmation>, { readonly kind: "activity" }>,
): boolean {
  if (!hasLaterSegmentContent(segments, index)) {
    return false;
  }
  if (isLeadingPreBodyActivitySegment(segments, index)) {
    return false;
  }
  return isClosedActivitySegment(segment);
}

function hasLaterSegmentContent<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(
  segments: readonly AssistantMessageSegment<TNode, TConfirmation>[],
  index: number,
): boolean {
  return segments.slice(index + 1).some((segment) => segment.kind !== "awaiting");
}

function isLeadingPreBodyActivitySegment<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(
  segments: readonly AssistantMessageSegment<TNode, TConfirmation>[],
  index: number,
): boolean {
  const current = segments[index];
  if (current?.kind !== "activity") {
    return false;
  }
  if (segments.slice(0, index).some((segment) => segment.kind === "body")) {
    return false;
  }
  return segments.slice(index + 1).some((segment) => segment.kind === "body");
}

function isClosedActivitySegment<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(segment: Extract<AssistantMessageSegment<TNode, TConfirmation>, { readonly kind: "activity" }>): boolean {
  return segment.lifecycle === "settled" && segment.timeline.items.length > 0;
}

function activitySegmentLifecycle<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity,
>(timeline: AgentWorkTimelineView<TNode, TConfirmation>): AssistantMessageSegmentLifecycle {
  if (timeline.confirmation.current !== undefined || timeline.items.some((item) => isAttentionActivityPhase(item.phase))) {
    return "attention";
  }
  if (timeline.items.some((item) => isOpenActivityPhase(item.phase))) {
    return "open";
  }
  return "settled";
}

function isOpenActivityPhase(phase: ProjectableTranscriptNode["phase"]): boolean {
  return phase === "noted" ||
    phase === "preparing" ||
    phase === "executing";
}

function isAttentionActivityPhase(phase: ProjectableTranscriptNode["phase"]): boolean {
  return phase === "waiting_approval" ||
    phase === "failed" ||
    phase === "blocked";
}

function compareAssistantMessageNodeOrder(
  left: ProjectableTranscriptNode,
  right: ProjectableTranscriptNode,
): number {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  const rank = assistantMessageNodeOrderRank(left) - assistantMessageNodeOrderRank(right);
  if (rank !== 0) {
    return rank;
  }
  if (left.nodeId === right.nodeId) {
    return 0;
  }
  return left.nodeId.localeCompare(right.nodeId);
}

function assistantMessageNodeOrderRank(node: ProjectableTranscriptNode): number {
  if (node.kind === "thinking") return 0;
  if (isModelSideOutputNode(node)) return 1;
  if (node.kind === "body") return 2;
  if (node.kind === "tool") return 3;
  if (node.kind === "confirmation") return 4;
  if (node.kind === "user_decision") return 5;
  if (node.kind === "system") return 6;
  return 6;
}
