import type { ActivityItem } from "../transcript/panel-transcript-activity-copy.js";
import type { ConfirmationIdentity } from "../transcript/panel-transcript-confirmation-projection.js";
import type { ProjectableTranscriptNode } from "../transcript/panel-transcript-node-projection.js";

type SegmentIdentityActivityItem = Pick<ActivityItem, "nodeId" | "key" | "tone" | "copy">;

export function assistantActivitySegmentKey<
  TNode extends ProjectableTranscriptNode,
  TConfirmation extends ConfirmationIdentity = ConfirmationIdentity,
>(input: {
  readonly nodes: readonly TNode[];
  readonly items: readonly SegmentIdentityActivityItem[];
  readonly pending?: TConfirmation;
  readonly fallbackIndex?: number;
  readonly fallbackKey?: string;
}): string {
  const nodesById = new Map(input.nodes.map((node) => [node.nodeId, node]));
  const operational = input.items.find((item) => !isModelNarrativeActivityItem(item));
  if (operational !== undefined) {
    return `activity:${operationalActivityItemIdentity(operational, nodesById)}`;
  }
  const pendingKey = confirmationSegmentKey(input.pending);
  if (pendingKey !== undefined) {
    return pendingKey;
  }
  const narrative = input.items.find(isModelNarrativeActivityItem);
  if (narrative !== undefined) {
    return `activity:narrative:${modelNarrativeActivityItemIdentity(narrative, nodesById)}`;
  }
  if (input.fallbackKey !== undefined) {
    return input.fallbackKey;
  }
  return `activity:fallback:${input.fallbackIndex ?? 0}`;
}

function operationalActivityItemIdentity(
  item: SegmentIdentityActivityItem,
  nodesById: ReadonlyMap<string, ProjectableTranscriptNode>,
): string {
  const node = nodesById.get(item.nodeId);
  const toolCallId = refId(node, "tool_call");
  if (toolCallId !== undefined) {
    return `tool-call:${keyPart(node?.runId)}:${keyPart(toolCallId)}`;
  }
  const confirmationId = node?.confirmation?.confirmationId ?? refId(node, "confirmation");
  if (confirmationId !== undefined) {
    return `confirmation:${keyPart(node?.runId)}:${keyPart(confirmationId)}`;
  }
  if (node !== undefined) {
    return node.nodeId;
  }
  return item.key;
}

function modelNarrativeActivityItemIdentity(
  item: SegmentIdentityActivityItem,
  nodesById: ReadonlyMap<string, ProjectableTranscriptNode>,
): string {
  const node = nodesById.get(item.nodeId);
  const modelCallId = refId(node, "model_call");
  if (modelCallId !== undefined) {
    return `${keyPart(node?.runId)}:${keyPart(modelCallId)}`;
  }
  const runId = node?.runId;
  const text = [item.copy.label, item.copy.detail]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join("\n");
  const fingerprint = stableTextFingerprint(text);
  if (runId !== undefined && fingerprint !== undefined) {
    return `${keyPart(runId)}:${fingerprint}`;
  }
  if (fingerprint !== undefined) {
    return fingerprint;
  }
  return node?.nodeId ?? item.key;
}

function confirmationSegmentKey(confirmation: ConfirmationIdentity | undefined): string | undefined {
  if (confirmation === undefined) {
    return undefined;
  }
  return `activity:pending:${keyPart(confirmation.ownerRunId)}:${keyPart(confirmation.confirmationId)}`;
}

function refId(node: ProjectableTranscriptNode | undefined, kind: string): string | undefined {
  return node?.refs.find((ref) => ref.kind === kind)?.id;
}

function isModelNarrativeActivityItem(item: { readonly tone: string }): boolean {
  return item.tone === "thinking" || item.tone === "narration";
}

function stableTextFingerprint(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `text-${(hash >>> 0).toString(36)}`;
}

function keyPart(value: string | undefined): string {
  return encodeURIComponent(value ?? "unknown");
}
