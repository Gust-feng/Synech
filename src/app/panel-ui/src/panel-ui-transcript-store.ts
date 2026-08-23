/**
 * External transcript cache for historical runs.
 *
 * Historical transcript nodes and canonical tool results are stored OUTSIDE React's app state so that
 * loading them does NOT trigger a full workbench render cascade. Only the
 * active workbench transcript subscribes to this
 * cache via useSyncExternalStore, keeping the rest of the UI stable during
 * background conversation loading.
 */
import type { TranscriptNode } from "./contracts/run";
import type { ToolCallResult } from "../../../domain/tools";
import {
  resetConversationTranscriptNodes,
  transcriptNodesByRunIdForConversation,
  updateConversationTranscriptNodes,
  type TranscriptNodesByConversationId,
} from "../../panel-read-model/transcript/panel-transcript-cache";

export type TranscriptNodesCache = Readonly<Record<string, readonly TranscriptNode[]>>;
export type TranscriptToolResultsCache = Readonly<Record<string, readonly ToolCallResult[]>>;
export type TranscriptStoreSnapshot = {
  readonly nodesByConversationId: TranscriptNodesByConversationId<TranscriptNode>;
  readonly toolResultsByConversationId: TranscriptNodesByConversationId<ToolCallResult>;
};

export type TranscriptRunCachePatch = {
  readonly nodesByRunId?: TranscriptNodesCache;
  readonly toolResultsByRunId?: TranscriptToolResultsCache;
};

let cache: TranscriptStoreSnapshot = {
  nodesByConversationId: {},
  toolResultsByConversationId: {},
};
const listenersByConversationId = new Map<string | undefined, Set<() => void>>();

export function getTranscriptCache(): TranscriptStoreSnapshot {
  return cache;
}

export function transcriptNodesCacheForConversation(
  snapshot: TranscriptStoreSnapshot,
  conversationId: string | undefined
): TranscriptNodesCache {
  return transcriptNodesByRunIdForConversation(snapshot.nodesByConversationId, conversationId);
}

export function transcriptToolResultsCacheForConversation(
  snapshot: TranscriptStoreSnapshot,
  conversationId: string | undefined
): TranscriptToolResultsCache {
  return transcriptNodesByRunIdForConversation(snapshot.toolResultsByConversationId, conversationId);
}

export function subscribeTranscriptCache(
  conversationId: string | undefined,
  listener: () => void
): () => void {
  let listeners = listenersByConversationId.get(conversationId);
  if (listeners === undefined) {
    listeners = new Set();
    listenersByConversationId.set(conversationId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      listenersByConversationId.delete(conversationId);
    }
  };
}

/**
 * Merge new entries into the cache and notify subscribers.
 * If the merge produces no actual changes for this conversation, notification
 * is suppressed to avoid spurious re-renders.
 */
export function updateTranscriptRunCache(
  conversationId: string,
  patch: TranscriptRunCachePatch
): void {
  const nextNodesByConversationId = updateConversationTranscriptNodes(
    cache.nodesByConversationId,
    conversationId,
    patch.nodesByRunId ?? {},
  );
  const nextToolResultsByConversationId = updateConversationTranscriptNodes(
    cache.toolResultsByConversationId,
    conversationId,
    patch.toolResultsByRunId ?? {},
  );
  if (
    nextNodesByConversationId === cache.nodesByConversationId &&
    nextToolResultsByConversationId === cache.toolResultsByConversationId
  ) return;
  cache = {
    nodesByConversationId: nextNodesByConversationId,
    toolResultsByConversationId: nextToolResultsByConversationId,
  };
  notifyTranscriptCache(conversationId);
}

export function resetTranscriptCache(conversationId?: string): void {
  const nextNodesByConversationId = resetConversationTranscriptNodes(
    cache.nodesByConversationId,
    conversationId,
  );
  const nextToolResultsByConversationId = resetConversationTranscriptNodes(
    cache.toolResultsByConversationId,
    conversationId,
  );
  if (
    nextNodesByConversationId === cache.nodesByConversationId &&
    nextToolResultsByConversationId === cache.toolResultsByConversationId
  ) return;
  cache = {
    nodesByConversationId: nextNodesByConversationId,
    toolResultsByConversationId: nextToolResultsByConversationId,
  };
  if (conversationId === undefined) {
    notifyAllTranscriptCache();
  } else {
    notifyTranscriptCache(conversationId);
  }
}

function notifyTranscriptCache(conversationId: string | undefined): void {
  const listeners = listenersByConversationId.get(conversationId);
  if (listeners === undefined) return;
  for (const listener of listeners) listener();
}

function notifyAllTranscriptCache(): void {
  for (const listeners of listenersByConversationId.values()) {
    for (const listener of listeners) listener();
  }
}