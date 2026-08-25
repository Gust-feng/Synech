import type React from "react";
import { ApiError, getJson } from "../../api";
import { transcriptNodesFrom } from "./run/projection";
import { shouldKeepRefreshing, stopLiveUpdates } from "./run/runtime-controls";
import type { AppState } from "../../workbench/state";
import { liveRunForObservedReplay } from "./run/task-submit-flow";
import { mergeTranscriptNodesByRunId } from "@panel-api/ui-read-model";
import { resetTranscriptCache, updateTranscriptRunCache } from "./transcript/store";
import type { PanelToolCallResult as ToolCallResult } from "@panel-api/ordinary-agent";
import type { Conversation } from "../../contracts/conversation";
import type { TranscriptNode } from "../../contracts/run";
import { ordinaryWorkViewFromRunView, safeOrdinaryRunView } from "../../workbench/run-client";
import type { LiveRunSubscription } from "./run/live-run-updates";
import {
  initialVisibleTranscriptTurnCount,
  runIdsForTurnWindow,
  transcriptVisibleTurnWindow,
} from "./transcript/window";

const HISTORICAL_RUN_LOAD_CONCURRENCY = 4;

export type ConversationSessionControllerOptions = {
  readonly app: AppState;
  readonly setApp: React.Dispatch<React.SetStateAction<AppState>>;
  readonly setGoal: (goal: string) => void;
  readonly setAttachments: React.Dispatch<React.SetStateAction<readonly import("../../contracts/context").ContextAttachment[]>>;
  readonly mountedRef: React.MutableRefObject<boolean>;
  readonly pollTimer: React.MutableRefObject<number | undefined>;
  readonly streamRef: React.MutableRefObject<EventSource | undefined>;
  readonly fallbackPollRef: React.MutableRefObject<AbortController | undefined>;
  readonly activeRunIdRef: React.MutableRefObject<string | undefined>;
  readonly viewEpochRef: React.MutableRefObject<number>;
  readonly conversationLoadAbortRef: React.MutableRefObject<AbortController | undefined>;
  readonly conversationLoadTargetRef: React.MutableRefObject<string | undefined>;
  readonly refreshConversations: () => Promise<void>;
  readonly startLiveUpdates: (input: LiveRunSubscription) => void;
};

export async function loadConversationSession(
  options: ConversationSessionControllerOptions,
  conversationId: string
): Promise<boolean> {
  const currentLoad = options.conversationLoadAbortRef.current;
  if (currentLoad !== undefined && !currentLoad.signal.aborted) {
    if (options.conversationLoadTargetRef.current === conversationId) {
      return true;
    }
    currentLoad.abort();
    options.conversationLoadAbortRef.current = undefined;
    options.conversationLoadTargetRef.current = undefined;
  }
  if (options.conversationLoadAbortRef.current !== undefined) {
    options.conversationLoadAbortRef.current.abort();
    options.conversationLoadAbortRef.current = undefined;
    options.conversationLoadTargetRef.current = undefined;
  }
  const abortController = new AbortController();
  options.conversationLoadAbortRef.current = abortController;
  options.conversationLoadTargetRef.current = conversationId;
  if (abortController.signal.aborted) {
    return false;
  }
  const epoch = options.viewEpochRef.current + 1;
  options.viewEpochRef.current = epoch;
  stopLiveUpdates(options.pollTimer, options.streamRef, options.fallbackPollRef);
  let response: { readonly conversation: Conversation };
  try {
    response = await getJson<{ readonly conversation: Conversation }>(
      `/api/conversations/${encodeURIComponent(conversationId)}`,
      { signal: abortController.signal }
    );
  } catch (error) {
    if (options.conversationLoadAbortRef.current === abortController) {
      options.conversationLoadAbortRef.current = undefined;
      options.conversationLoadTargetRef.current = undefined;
    }
    if (abortController.signal.aborted) return false;
    if (isMissingConversationError(error)) {
      resetConversationSession(options);
      options.setApp((previous) => ({
        ...previous,
        conversations: previous.conversations.filter((conversation) => conversation.conversationId !== conversationId),
        error: undefined,
      }));
      try {
        await options.refreshConversations();
      } catch {
        // The main screen is already valid; a later refresh can reconcile the list.
      }
      return false;
    }
    throw error;
  }
  if (abortController.signal.aborted) return false;
  const currentRun = response.conversation.currentRun;
  const latestRunId = currentRun?.run.runId ?? response.conversation.activeRunId ?? response.conversation.latestRunId;
  options.activeRunIdRef.current = latestRunId;
  const detail = currentRun?.detail;
  const run = currentRun?.run;
  const replay = currentRun?.replay;
  const workView = ordinaryWorkViewFromRunView(currentRun);
  const capabilityResolution = currentRun?.capabilityResolution;
  const transcriptNodes = transcriptNodesFrom(workView);
  if (!options.mountedRef.current || options.viewEpochRef.current !== epoch) return false;
  const previousConversationId = options.app.conversation?.conversationId;
  if (previousConversationId !== undefined && previousConversationId !== response.conversation.conversationId) {
    resetTranscriptCache(previousConversationId);
  }

  // ── Phase 1: Switch to the new conversation immediately ──────────────
  //
  // The conversation metadata fetch is a single fast API call (~100 ms).
  // As soon as it resolves we switch the screen so the user sees the new
  // conversation right away — no freeze, no loading spinner.
  //
  // These three synchronous dispatches are batched by React 18 into a
  // single commit.  We intentionally do NOT wrap them in startTransition:
  // the render is fast (~50 ms with stable grouping + memo) and keeping
  // the update synchronous avoids a race condition where startLiveUpdates
  // (fired right below) would merge live events into the old conversation
  // state before a deferred transition commits.
  //
  // At this point only the CURRENT run's transcript nodes are available.
  // Historical runs are loaded silently in Phase 2 below.
  options.setApp((previous) => ({
    ...previous,
    conversation: response.conversation,
    run,
    workView,
    capabilityResolution,
    capabilityResolutionRunId: capabilityResolution === undefined ? undefined : run?.runId,
    detail,
    transcriptNodes,
    transcriptNodesByRunId: mergeTranscriptNodesByRunId({}, latestRunId, transcriptNodes),
    events: replay?.events ?? [],
    live: run !== undefined && latestRunId !== undefined && shouldKeepRefreshing(run.status)
      ? liveRunForObservedReplay({
          observedRunId: latestRunId,
          observedRun: run,
          previousLive: undefined,
          replayEvents: replay?.events ?? [],
        })
      : undefined,
    error: undefined,
  }));
  options.setAttachments([]);
  if (run !== undefined && shouldKeepRefreshing(run.status)) {
    options.startLiveUpdates({
      runId: run.runId,
      cursor: replay?.cursor.token,
      conversationId: response.conversation.conversationId,
      epoch,
    });
  }

  // ── Phase 2: Load historical runs in the background ──────────────────
  //
  // Two key optimizations over the original code:
  //
  // 1. BOUNDED parallel fetch — historical runs are requested with fixed
  //    concurrency so long conversations do not overload the browser.
  //
  // 2. EXTERNAL cache — historical nodes are written to a module-level
  //    transcript store instead of app state. Only
  //    ConversationTranscript subscribes via useSyncExternalStore, so the
  //    rest of the workbench does
  //    NOT re-render.  The historical nodes carry no data-entering
  //    attribute, so no CSS animation fires — the user perceives a
  //    silent background fill-in with zero flicker.
  const initialVisibleWindow = transcriptVisibleTurnWindow(
    response.conversation.turns.length,
    initialVisibleTranscriptTurnCount(response.conversation.turns.length)
  );
  const historicalRunIds = runIdsForTurnWindow(response.conversation.turns, initialVisibleWindow.startIndex)
    .filter((id) => id !== latestRunId);
  if (historicalRunIds.length > 0) {
    // Historical runs fill the external transcript cache without blocking the
    // navigation contract. A slow or failed backfill must not turn an already
    // active conversation into a failed open operation.
    void hydrateHistoricalTranscript({
      conversationId: response.conversation.conversationId,
      runIds: historicalRunIds,
      epoch,
      abortController,
      options,
    });
  } else {
    if (options.conversationLoadAbortRef.current === abortController) {
      options.conversationLoadAbortRef.current = undefined;
      options.conversationLoadTargetRef.current = undefined;
    }
  }
  return true;
}

async function hydrateHistoricalTranscript(input: {
  readonly conversationId: string;
  readonly runIds: readonly string[];
  readonly epoch: number;
  readonly abortController: AbortController;
  readonly options: ConversationSessionControllerOptions;
}): Promise<void> {
  const { conversationId, runIds, epoch, abortController, options } = input;
  try {
    const entries = await loadHistoricalTranscriptRunEntries(runIds, abortController.signal);
    if (!options.mountedRef.current || options.viewEpochRef.current !== epoch || abortController.signal.aborted) return;
    const nodesByRunId: Record<string, readonly TranscriptNode[]> = {};
    const toolResultsByRunId: Record<string, readonly ToolCallResult[]> = {};
    for (const entry of entries) {
      nodesByRunId[entry.runId] = entry.nodes;
      toolResultsByRunId[entry.runId] = entry.toolResults;
    }
    updateTranscriptRunCache(conversationId, { nodesByRunId, toolResultsByRunId });
  } catch {
    // The conversation is already active. Historical backfill is best effort;
    // a later open or transcript refresh can retry it without changing the
    // visible navigation state.
  } finally {
    if (options.conversationLoadAbortRef.current === abortController) {
      options.conversationLoadAbortRef.current = undefined;
      options.conversationLoadTargetRef.current = undefined;
    }
  }
}

function isMissingConversationError(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 404
    && (error.code === "conversation_not_found" || error.code === "not_found");
}

export function resetConversationSession(options: ConversationSessionControllerOptions): void {
  const conversationId = options.app.conversation?.conversationId;
  if (conversationId !== undefined) {
    resetTranscriptCache(conversationId);
  }
  options.conversationLoadAbortRef.current?.abort();
  options.conversationLoadAbortRef.current = undefined;
  options.conversationLoadTargetRef.current = undefined;
  options.viewEpochRef.current += 1;
  stopLiveUpdates(options.pollTimer, options.streamRef, options.fallbackPollRef);
  options.activeRunIdRef.current = undefined;
  options.setGoal("");
  options.setAttachments([]);
  options.setApp((previous) => ({
    ...previous,
    conversation: undefined,
    run: undefined,
    workView: undefined,
    capabilityResolution: undefined,
    capabilityResolutionRunId: undefined,
    transcriptNodes: [],
    transcriptNodesByRunId: {},
    events: [],
    live: undefined,
    detail: undefined,
    error: undefined,
  }));
}

export async function loadHistoricalTranscriptRunEntries(
  runIds: readonly string[],
  signal?: AbortSignal
): Promise<readonly HistoricalTranscriptRunEntry[]> {
  const entries: HistoricalTranscriptRunEntry[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(HISTORICAL_RUN_LOAD_CONCURRENCY, runIds.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < runIds.length) {
      if (signal?.aborted) return;
      const runId = runIds[nextIndex]!;
      nextIndex += 1;
      const view = await safeOrdinaryRunView(runId, undefined, { signal });
      const nodes = transcriptNodesFrom(ordinaryWorkViewFromRunView(view))
        .filter((node: TranscriptNode) => node.runId === runId);
      entries.push({ runId, nodes, toolResults: view?.detail.toolResults ?? [] });
    }
  }));
  return entries.sort((left, right) => runIds.indexOf(left.runId) - runIds.indexOf(right.runId));
}

export type HistoricalTranscriptRunEntry = {
  readonly runId: string;
  readonly nodes: readonly TranscriptNode[];
  readonly toolResults: readonly ToolCallResult[];
};
