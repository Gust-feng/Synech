import type React from "react";
import { isObservedRunSettled, shouldKeepRefreshing, stopLiveUpdates, stopPolling } from "./runtime-controls";
import type { AppState } from "../../../workbench/state";
import {
  isLiveAppendOnlyEvent,
} from "@panel-api/ui-read-model";
import {
  appStateWithSettledConversationGuard,
  appStateWithAppendOnlyRunEvents,
  appStateWithObservedRunEvent,
  appStateWithObservedRunProjection,
  createRunObservationGuard,
  createAppendOnlyRunEventBatcher,
} from "./observation-state";
import {
  appStateWithSettledRunProjection,
  loadSettledRunProjection,
  type SettledRunProjection,
  refreshingFollowUpRun,
} from "./observation-settlement";
import {
  openOrdinaryRunStream,
  ordinaryWorkViewFromRunView,
  safeOrdinaryRunView,
} from "../../../workbench/run-client";
import { transcriptNodesFrom } from "./projection";
import { updateTranscriptRunCache } from "../transcript/store";
import type { OrdinaryRun, OrdinaryRunCursor, RunEvent } from "../../../contracts/run";

const FALLBACK_POLL_INTERVAL_MS = 1_200;
const STREAM_BOOTSTRAP_POLL_INTERVAL_MS = 500;
const STREAM_BOOTSTRAP_POLL_LIMIT = 12;
const STREAM_RECONCILIATION_POLL_INTERVAL_MS = 4_000;
const STREAM_STALE_AFTER_MS = 15_000;
const APPEND_ONLY_FLUSH_INTERVAL_MS = 16;

export type LiveRunUpdateController = {
  readonly startLiveUpdates: (input: LiveRunSubscription) => void;
  readonly startPolling: (input: LiveRunSubscription) => void;
};

export type LiveRunUpdateControllerOptions = {
  readonly setApp: React.Dispatch<React.SetStateAction<AppState>>;
  readonly mountedRef: React.MutableRefObject<boolean>;
  readonly pollTimer: React.MutableRefObject<number | undefined>;
  readonly streamRef: React.MutableRefObject<EventSource | undefined>;
  readonly fallbackPollRef: React.MutableRefObject<AbortController | undefined>;
  readonly activeRunIdRef: React.MutableRefObject<string | undefined>;
  readonly viewEpochRef: React.MutableRefObject<number>;
  readonly refreshConversations: () => Promise<void>;
};

export type LiveRunSubscription = {
  readonly runId: string;
  readonly cursor?: OrdinaryRunCursor;
  readonly conversationId?: string;
  readonly epoch: number;
};

export function createLiveRunUpdateController(
  options: LiveRunUpdateControllerOptions
): LiveRunUpdateController {
  const appendOnlyBatcher = createAppendOnlyRunEventBatcher<{
    readonly subscription: LiveRunSubscription;
    readonly event: RunEvent;
  }>({
    schedule: scheduleAppendOnlyFlush,
    apply: (items) => {
      if (!options.mountedRef.current) {
        return;
      }
      options.setApp((previous) => {
        const applicable = items.filter((item) => canApplyAppendOnlyToState(previous, item.subscription));
        const latest = applicable.at(-1);
        if (latest === undefined) {
          return previous;
        }
        const events = applicable
          .filter((item) => item.subscription.runId === latest.subscription.runId)
          .map((item) => item.event);
        return events.length === 0
          ? previous
          : appStateWithAppendOnlyRunEvents(previous, {
              runId: latest.subscription.runId,
              events,
            });
      });
    },
  });

  const commitSettledProjection = (
    subscription: LiveRunSubscription,
    settled: SettledRunProjection,
    observe: (previous: AppState) => AppState,
  ): void => {
    if (!subscriptionIsCurrent(subscription)) {
      return;
    }
    cacheSettledRunTranscriptNodes(settled);
    options.setApp((previous) => {
      if (!canApplyToState(previous, subscription)) {
        return previous;
      }
      return appStateWithSettledConversationGuard(previous, {
        expectedConversationId: subscription.conversationId,
        next: appStateWithSettledRunProjection(observe(previous), settled),
      });
    });
  };

  function startPolling(subscription: LiveRunSubscription): void {
    if (!subscriptionIsCurrent(subscription)) return;
    appendOnlyBatcher.clear();
    const { runId } = subscription;
    stopLiveUpdates(options.pollTimer, options.streamRef, options.fallbackPollRef);
    let pollingTimer: number | undefined;
    const pollingIsCurrent = (): boolean =>
      subscriptionIsCurrent(subscription) &&
      pollingTimer !== undefined && options.pollTimer.current === pollingTimer;
    let lastCursor = subscription.cursor;
    const tick = async (): Promise<void> => {
      if (!pollingIsCurrent() || options.fallbackPollRef.current !== undefined) return;
      const abortController = new AbortController();
      options.fallbackPollRef.current = abortController;
      const requestIsCurrent = (): boolean =>
        pollingIsCurrent() && !abortController.signal.aborted &&
        options.fallbackPollRef.current === abortController;
      try {
        const runView = await fetchOrdinaryRunView(runId, lastCursor, abortController.signal);
        if (!requestIsCurrent()) return;
        lastCursor = runView.replay.cursor.token;
        await applyRunViewProjection(subscription, runView, false, requestIsCurrent);
      } catch (error) {
        if (isAbortError(error) || !requestIsCurrent()) return;
        options.setApp((previous) =>
          pollingIsCurrent() && canApplyToState(previous, subscription)
            ? {
                ...previous,
                error: error instanceof Error ? error.message : "刷新运行状态失败。",
              }
            : previous
        );
      } finally {
        if (options.fallbackPollRef.current === abortController) {
          options.fallbackPollRef.current = undefined;
        }
      }
    };
    pollingTimer = window.setInterval(() => void tick(), FALLBACK_POLL_INTERVAL_MS);
    options.pollTimer.current = pollingTimer;
    void tick();
  }

  function startLiveUpdates(subscription: LiveRunSubscription): void {
    const guard = createRunObservationGuard(options, subscription);
    if (!guard.canStart()) return;
    appendOnlyBatcher.clear();
    const { runId } = subscription;
    stopLiveUpdates(options.pollTimer, options.streamRef, options.fallbackPollRef);
    options.activeRunIdRef.current = runId;
    let ownedStream: EventSource | undefined;
    const isCurrent = (): boolean =>
      guard.isCurrent() && options.streamRef.current === ownedStream;
    let lastCursor = subscription.cursor;
    let streamDeliveredEvent = false;
    let reconciliationStarted = false;
    let lastStreamSignalAt = Date.now();
    let liveRunSettled = false;
    let streamWork = Promise.resolve();
    const refreshAfterEvent = async (event: RunEvent, cursor: OrdinaryRunCursor): Promise<void> => {
      if (!isCurrent()) return;
      // The SSE id is the backend cursor for every activity included in the frame.
      // Advance it before reconciliation so coalesced deltas are not replayed individually.
      lastCursor = cursor;
      if (isLiveAppendOnlyEvent(event)) {
        if (isCurrent()) {
          appendOnlyBatcher.enqueue({ subscription, event });
        }
        return;
      }
      appendOnlyBatcher.flush();
      const runView = await fetchOrdinaryRunView(runId, lastCursor);
      if (!isCurrent()) return;
      lastCursor = runView.replay.cursor.token;
      const run = runView.run;
      const workView = ordinaryWorkViewFromRunView(runView);
      const capabilityResolution = runView.capabilityResolution;
      const detail = runView.detail;
      if (run !== undefined && !shouldKeepRefreshing(run.status)) {
        const settled = await loadSettledRunProjection({ runId, run, workView, capabilityResolution });
        if (!isCurrent()) return;
        liveRunSettled = true;
        stopLiveUpdates(options.pollTimer, options.streamRef, options.fallbackPollRef);
        commitSettledProjection(subscription, settled, (previous) => appStateWithObservedRunEvent(previous, {
          runId,
          run,
          event,
          workView,
          capabilityResolution,
          detail,
        }));
        const followUp = refreshingFollowUpRun(settled);
        if (followUp !== undefined) {
          options.activeRunIdRef.current = followUp.runId;
          startLiveUpdates({
            ...subscription,
            runId: followUp.runId,
            cursor: followUp.cursor,
          });
        } else {
          void options.refreshConversations();
        }
        return;
      }
      if (isCurrent()) {
        options.setApp((previous) =>
          canApplyToState(previous, subscription)
            ? appStateWithObservedRunEvent(previous, {
                runId,
                run,
                event,
                workView,
                capabilityResolution,
                detail,
              })
            : previous
        );
      }
    };
    const stopBootstrapPolling = (): void => stopPolling(options.pollTimer);
    const reconcile = async (): Promise<void> => {
      if (!isCurrent()) return;
      const runView = await fetchOrdinaryRunView(runId, lastCursor);
      if (!isCurrent()) return;
      lastCursor = runView.replay.cursor.token;
      await applyRunViewProjection(subscription, runView, false, isCurrent);
    };
    const startReconciliationPolling = (): void => {
      if (reconciliationStarted || liveRunSettled || !isCurrent()) return;
      reconciliationStarted = true;
      stopPolling(options.pollTimer);
      options.pollTimer.current = window.setInterval(() => {
        if (!isCurrent()) {
          return;
        }
        if (Date.now() - lastStreamSignalAt >= STREAM_STALE_AFTER_MS) {
          fallback();
          return;
        }
        enqueueStreamWork(reconcile);
      }, STREAM_RECONCILIATION_POLL_INTERVAL_MS);
    };
    const noteStreamSignal = (): void => {
      if (!isCurrent()) return;
      lastStreamSignalAt = Date.now();
      streamDeliveredEvent = true;
      if (!reconciliationStarted) {
        stopBootstrapPolling();
        startReconciliationPolling();
      }
    };
    const startBootstrapPolling = (): void => {
      let attempts = 0;
      let inFlight = false;
      const poll = async (): Promise<void> => {
        if (streamDeliveredEvent || inFlight || !isCurrent()) {
          return;
        }
        attempts += 1;
        inFlight = true;
        try {
          const runView = await fetchOrdinaryRunView(runId, lastCursor);
          // Once SSE has delivered any signal, its ordered stream owns live progress.
          // An older bootstrap response may contain the same raw deltas that SSE
          // already delivered as one coalesced frame, so applying it would duplicate text.
          if (streamDeliveredEvent || !isCurrent()) {
            return;
          }
          lastCursor = runView.replay.cursor.token;
          await applyRunViewProjection(subscription, runView, false, isCurrent);
          if (runView.replay.events.length > 0 && !streamDeliveredEvent) {
            attempts = 0;
          }
        } catch {
          fallback();
        } finally {
          inFlight = false;
          if (
            isCurrent() &&
            (streamDeliveredEvent || attempts >= STREAM_BOOTSTRAP_POLL_LIMIT)
          ) {
            stopBootstrapPolling();
          }
        }
      };
      void poll();
      options.pollTimer.current = window.setInterval(() => void poll(), STREAM_BOOTSTRAP_POLL_INTERVAL_MS);
    };
    const fallback = (): void => {
      if (liveRunSettled || !isCurrent()) return;
      appendOnlyBatcher.flush();
      startPolling({ ...subscription, cursor: lastCursor });
    };
    const refreshAfterReset = async (resetCursor: OrdinaryRunCursor): Promise<void> => {
      if (!isCurrent()) return;
      lastCursor = resetCursor;
      appendOnlyBatcher.clear();
      const runView = await fetchOrdinaryRunView(runId, undefined);
      if (!isCurrent()) return;
      lastCursor = runView.replay.cursor.token;
      await applyRunViewProjection(subscription, runView, true, isCurrent);
    };
    const enqueueStreamWork = (work: () => Promise<void>): void => {
      if (!isCurrent()) return;
      streamWork = streamWork.then(work, work).catch(() => fallback());
    };
    const stream = openOrdinaryRunStream({
      runId,
      cursor: subscription.cursor,
      onEvent: (event, cursor) => {
        noteStreamSignal();
        enqueueStreamWork(() => refreshAfterEvent(event, cursor));
      },
      onReset: (cursor) => {
        noteStreamSignal();
        enqueueStreamWork(() => refreshAfterReset(cursor));
      },
      onHeartbeat: noteStreamSignal,
      onError: fallback,
    });
    if (stream === undefined) {
      startPolling(subscription);
      return;
    }
    ownedStream = stream;
    options.streamRef.current = stream;
    startBootstrapPolling();
  }

  async function applyRunViewProjection(
    subscription: LiveRunSubscription,
    runView: Awaited<ReturnType<typeof fetchOrdinaryRunView>>,
    forceReset: boolean,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent()) return;
    const reset = forceReset || runView.replay.reset;
    if (reset) appendOnlyBatcher.clear();
    else appendOnlyBatcher.flush();
    const { runId } = subscription;
    if (!isObservedRunSettled(runView.run)) {
      if (isCurrent()) {
        options.setApp((previous) =>
          canApplyToState(previous, subscription)
            ? appStateWithObservedRunProjection(previous, {
                runId,
                run: runView.run,
                events: runView.replay.events,
                workView: ordinaryWorkViewFromRunView(runView),
                capabilityResolution: runView.capabilityResolution,
                detail: runView.detail,
                reset,
              })
            : previous
        );
      }
      return;
    }
    const settled = await loadSettledRunProjection({
      runId,
      run: runView.run,
      workView: ordinaryWorkViewFromRunView(runView),
      capabilityResolution: runView.capabilityResolution,
    });
    if (!isCurrent()) return;
    stopLiveUpdates(options.pollTimer, options.streamRef, options.fallbackPollRef);
    commitSettledProjection(subscription, settled, (previous) => appStateWithObservedRunProjection(previous, {
      runId,
      run: runView.run,
      events: runView.replay.events,
      workView: ordinaryWorkViewFromRunView(runView),
      capabilityResolution: runView.capabilityResolution,
      detail: runView.detail,
      reset,
    }));
    const followUp = refreshingFollowUpRun(settled);
    if (followUp !== undefined) {
      options.activeRunIdRef.current = followUp.runId;
      startLiveUpdates({
        ...subscription,
        runId: followUp.runId,
        cursor: followUp.cursor,
      });
    } else {
      void options.refreshConversations();
    }
  }

  return { startLiveUpdates, startPolling };

  function subscriptionIsCurrent(subscription: LiveRunSubscription): boolean {
    return createRunObservationGuard(options, subscription).isCurrent();
  }

  function canApplyToState(previous: AppState, subscription: LiveRunSubscription): boolean {
    return createRunObservationGuard(options, subscription).isCurrent(previous);
  }

  function canApplyAppendOnlyToState(previous: AppState, subscription: LiveRunSubscription): boolean {
    return canApplyToState(previous, subscription) &&
      previous.run?.runId === subscription.runId &&
      previous.run !== undefined &&
      shouldKeepRefreshing(previous.run.status);
  }
}

function cacheSettledRunTranscriptNodes(settled: SettledRunProjection): void {
  const conversationId = settled.conversation?.conversationId ?? settled.run.conversationId;
  if (conversationId === undefined) {
    return;
  }
  const nodes = transcriptNodesFrom(settled.workView)
    .filter((node) => node.runId === settled.runId);
  const toolResults = settled.detail?.toolResults ?? [];
  if (nodes.length === 0 && toolResults.length === 0) {
    return;
  }
  updateTranscriptRunCache(conversationId, {
    nodesByRunId: { [settled.runId]: nodes },
    toolResultsByRunId: { [settled.runId]: toolResults },
  });
}

function scheduleAppendOnlyFlush(flush: () => void): () => void {
  if (typeof window.requestAnimationFrame === "function") {
    const frame = window.requestAnimationFrame(() => flush());
    return () => window.cancelAnimationFrame(frame);
  }
  const timer = window.setTimeout(() => flush(), APPEND_ONLY_FLUSH_INTERVAL_MS);
  return () => window.clearTimeout(timer);
}

async function fetchOrdinaryRunView(
  runId: string,
  cursor: OrdinaryRunCursor | undefined,
  signal?: AbortSignal,
): Promise<{
  readonly run: OrdinaryRun;
  readonly capabilityResolution?: NonNullable<Awaited<ReturnType<typeof safeOrdinaryRunView>>>["capabilityResolution"];
  readonly workView: NonNullable<Awaited<ReturnType<typeof safeOrdinaryRunView>>>["workView"];
  readonly detail: NonNullable<Awaited<ReturnType<typeof safeOrdinaryRunView>>>["detail"];
  readonly replay: NonNullable<Awaited<ReturnType<typeof safeOrdinaryRunView>>>["replay"];
}> {
  signal?.throwIfAborted();
  const view = signal === undefined
    ? await safeOrdinaryRunView(runId, cursor)
    : await safeOrdinaryRunView(runId, cursor, { signal });
  signal?.throwIfAborted();
  if (view === undefined) {
    throw new Error("读取运行视图失败。");
  }
  return view;
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException
    ? reason.name === "AbortError"
    : reason instanceof Error && reason.name === "AbortError";
}
