import {
  mergeReplacingTranscriptNodeLists,
  mergeTranscriptNodeLists,
  type TranscriptNodeIdentityLike,
} from "./panel-transcript-node-identity.js";

export type TranscriptNodeCacheItem = {
  readonly nodeId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly eventType?: string;
  readonly kind?: string;
  readonly phase?: string;
  readonly summary?: string;
  readonly text?: string;
  readonly timestamp?: string;
  readonly refs?: readonly {
    readonly kind: string;
    readonly id: string;
    readonly label?: string;
  }[];
} & TranscriptNodeIdentityLike;

export type ConversationRunTurn = {
  readonly role: "user" | "assistant";
  readonly runId?: string;
};

export type TranscriptNodesByRunId<T> = Readonly<Record<string, readonly T[]>>;
export type TranscriptNodesByConversationId<T> = Readonly<Record<string, TranscriptNodesByRunId<T>>>;

const emptyTranscriptNodesByRunId: TranscriptNodesByRunId<never> = Object.freeze({});

export function transcriptNodesByRunIdForConversation<T>(
  snapshot: TranscriptNodesByConversationId<T>,
  conversationId: string | undefined
): TranscriptNodesByRunId<T> {
  if (conversationId === undefined) {
    return emptyTranscriptNodesByRunId as TranscriptNodesByRunId<T>;
  }
  return snapshot[conversationId] ?? emptyTranscriptNodesByRunId as TranscriptNodesByRunId<T>;
}

export function updateConversationTranscriptNodes<T>(
  previous: TranscriptNodesByConversationId<T>,
  conversationId: string,
  patch: TranscriptNodesByRunId<T>
): TranscriptNodesByConversationId<T> {
  const patchKeys = Object.keys(patch);
  if (patchKeys.length === 0) return previous;
  const current = transcriptNodesByRunIdForConversation(previous, conversationId);
  let changed = false;
  const nextConversationNodes: Record<string, readonly T[]> = { ...current };
  for (const runId of patchKeys) {
    if (current[runId] === patch[runId]) continue;
    nextConversationNodes[runId] = patch[runId] ?? [];
    changed = true;
  }
  if (!changed) return previous;
  return {
    ...previous,
    [conversationId]: nextConversationNodes,
  };
}

export function resetConversationTranscriptNodes<T>(
  previous: TranscriptNodesByConversationId<T>,
  conversationId?: string
): TranscriptNodesByConversationId<T> {
  if (conversationId === undefined) {
    return Object.keys(previous).length === 0 ? previous : {};
  }
  if (previous[conversationId] === undefined) return previous;
  const { [conversationId]: _removed, ...next } = previous;
  return next;
}

export function mergeTranscriptNodesByRunId<T extends TranscriptNodeCacheItem>(
  previous: Record<string, readonly T[]>,
  runId: string | undefined,
  nodes: readonly T[]
): Record<string, readonly T[]> {
  const next = { ...previous };
  if (runId !== undefined) {
    next[runId] = mergeReplacingTranscriptNodeLists(
      previous[runId] ?? [],
      nodes.filter((node) => node.runId === runId),
    );
  }
  for (const node of nodes) {
    if (node.runId.length === 0) continue;
    if (runId !== undefined && node.runId === runId) continue;
    next[node.runId] = mergeTranscriptNodeLists(next[node.runId] ?? [], [node]);
  }
  return next;
}

export function transcriptNodesForConversation<T extends TranscriptNodeCacheItem>(
  turns: readonly ConversationRunTurn[],
  byRunId: Record<string, readonly T[]>
): readonly T[] {
  return runIdsForConversation(turns).flatMap((runId) => byRunId[runId] ?? []);
}

export function runIdsForConversation(turns: readonly ConversationRunTurn[]): readonly string[] {
  const runIds = turns
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.runId)
    .filter((runId): runId is string => runId !== undefined && runId.trim().length > 0);
  return Array.from(new Set(runIds));
}

export { mergeReplacingTranscriptNodeLists, mergeTranscriptNodeLists };
