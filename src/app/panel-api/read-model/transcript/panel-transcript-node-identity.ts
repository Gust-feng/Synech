export type TranscriptNodeRefLike = {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
};

export type TranscriptNodeIdentityLike = {
  readonly nodeId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly eventType?: string;
  readonly kind?: string;
  readonly phase?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly text?: string;
  readonly timestamp?: string;
  readonly modelUsage?: unknown;
  readonly refs?: readonly TranscriptNodeRefLike[];
};

type StructuredTranscriptFamily = "reasoning" | "side" | "body" | "tool_active" | "tool_terminal";

export function isModelSideTranscriptNode(node: TranscriptNodeIdentityLike): boolean {
  return node.kind === "system" &&
    (node.eventType === "model.side.completed" || node.eventType === "model.output.side");
}

export function isMergeableModelTranscriptNode(node: TranscriptNodeIdentityLike): boolean {
  return node.kind === "thinking" || isModelSideTranscriptNode(node);
}

/**
 * Canonical identity is derived only from run-born structural facts.
 * Reasoning, side narration and answer body intentionally remain different
 * families even when providers emit identical text.
 */
export function transcriptNodeIdentityKey(node: TranscriptNodeIdentityLike): string {
  const family = structuredTranscriptFamily(node);
  const ownerId = family === "tool_active" || family === "tool_terminal"
    ? firstRefId(node, "tool_call")
    : family === undefined ? undefined : firstRefId(node, "model_call");
  return ownerId === undefined
    ? `${node.runId}:node:${node.nodeId}`
    : `${node.runId}:${family}:${ownerId}`;
}

export function sameTranscriptNodeIdentity(
  left: TranscriptNodeIdentityLike,
  right: TranscriptNodeIdentityLike,
): boolean {
  if (left.runId !== right.runId) return false;
  if (left.nodeId === right.nodeId) return true;
  const leftFamily = structuredTranscriptFamily(left);
  const rightFamily = structuredTranscriptFamily(right);
  if (leftFamily === undefined || leftFamily !== rightFamily) return false;
  const refKind = leftFamily === "tool_active" || leftFamily === "tool_terminal" ? "tool_call" : "model_call";
  const leftOwner = firstRefId(left, refKind);
  const rightOwner = firstRefId(right, refKind);
  return leftOwner !== undefined && leftOwner === rightOwner;
}

/**
 * Reconciles two observations of one structurally identified fact. Content is
 * never spliced or selected by textual similarity: terminal facts outrank live
 * facts, then the newer sequence wins. The reconciled node keeps the first
 * observation's identity slot and earliest sequence so the fact stays at the
 * position where it first appeared in the raw stream (e.g. thinking deltas
 * recorded before a later durable completion transition).
 */
export function mergeTranscriptNodes<TNode extends TranscriptNodeIdentityLike>(
  previous: TNode,
  incoming: TNode,
): TNode {
  if (!sameTranscriptNodeIdentity(previous, incoming)) return incoming;
  const winner = transcriptNodeAuthority(incoming) >= transcriptNodeAuthority(previous)
    ? incoming
    : previous;
  const loser = winner === incoming ? previous : incoming;
  return {
    ...winner,
    nodeId: loser.nodeId,
    sequence: Math.min(previous.sequence, incoming.sequence),
    modelUsage: winner.modelUsage ?? loser.modelUsage,
    refs: mergeTranscriptRefs(winner.refs ?? [], loser.refs ?? []),
  } as TNode;
}

export function mergeTranscriptNodeLists<TNode extends TranscriptNodeIdentityLike>(
  previous: readonly TNode[],
  incoming: readonly TNode[],
): readonly TNode[] {
  const merged = [...previous];
  for (const node of incoming) {
    const existingIndex = merged.findIndex((item) => sameTranscriptNodeIdentity(item, node));
    if (existingIndex < 0) {
      merged.push(node);
      continue;
    }
    merged[existingIndex] = mergeTranscriptNodes(merged[existingIndex]!, node);
  }
  return sortTranscriptNodes(merged);
}

export function mergeReplacingTranscriptNodeLists<TNode extends TranscriptNodeIdentityLike>(
  previous: readonly TNode[],
  incoming: readonly TNode[],
): readonly TNode[] {
  const merged: TNode[] = [];
  for (const node of incoming) {
    const alreadyMergedIndex = merged.findIndex((item) => sameTranscriptNodeIdentity(item, node));
    if (alreadyMergedIndex >= 0) {
      merged[alreadyMergedIndex] = mergeTranscriptNodes(merged[alreadyMergedIndex]!, node);
      continue;
    }
    const previousNode = previous.find((item) => sameTranscriptNodeIdentity(item, node));
    merged.push(previousNode === undefined ? node : mergeTranscriptNodes(previousNode, node));
  }
  return sortTranscriptNodes(merged);
}

export function mergeTranscriptRefs<TRef extends TranscriptNodeRefLike>(
  left: readonly TRef[],
  right: readonly TRef[],
): readonly TRef[] {
  const seen = new Set<string>();
  const result: TRef[] = [];
  for (const ref of [...left, ...right]) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function structuredTranscriptFamily(node: TranscriptNodeIdentityLike): StructuredTranscriptFamily | undefined {
  if (node.kind === "thinking") return "reasoning";
  if (isModelSideTranscriptNode(node)) return "side";
  if (node.kind === "body") return "body";
  if (node.kind === "tool") return isTerminalTranscriptNode(node) ? "tool_terminal" : "tool_active";
  return undefined;
}

function firstRefId(node: TranscriptNodeIdentityLike, kind: string): string | undefined {
  return node.refs?.find((ref) => ref.kind === kind && ref.id.length > 0)?.id;
}

function transcriptNodeAuthority(node: TranscriptNodeIdentityLike): number {
  const terminalRank = isTerminalTranscriptNode(node) ? 1_000_000_000 : 0;
  return terminalRank + Math.max(0, node.sequence);
}

function isTerminalTranscriptNode(node: TranscriptNodeIdentityLike): boolean {
  return node.phase === "completed" ||
    node.phase === "failed" ||
    node.phase === "blocked" ||
    node.phase === "cancelled" ||
    node.eventType?.endsWith(".completed") === true ||
    node.eventType === "tool.failed" ||
    node.eventType === "tool.cancelled";
}

function sortTranscriptNodes<TNode extends TranscriptNodeIdentityLike>(nodes: readonly TNode[]): readonly TNode[] {
  return [...nodes].sort((left, right) => left.sequence - right.sequence || left.nodeId.localeCompare(right.nodeId));
}
