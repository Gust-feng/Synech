import type { MutableRefObject } from "react";
import type { OrdinaryRun } from "../../../contracts/run";

export function stopPolling(ref: MutableRefObject<number | undefined>): void {
  if (ref.current !== undefined) {
    window.clearInterval(ref.current);
    ref.current = undefined;
  }
}

export function stopStream(ref: MutableRefObject<EventSource | undefined>): void {
  ref.current?.close();
  ref.current = undefined;
}

export function stopFallbackPoll(ref: MutableRefObject<AbortController | undefined>): void {
  ref.current?.abort();
  ref.current = undefined;
}

export function stopLiveUpdates(
  pollRef: MutableRefObject<number | undefined>,
  streamRef: MutableRefObject<EventSource | undefined>,
  fallbackPollRef: MutableRefObject<AbortController | undefined>,
): void {
  stopPolling(pollRef);
  stopStream(streamRef);
  stopFallbackPoll(fallbackPollRef);
}

export function shouldKeepRefreshing(status: OrdinaryRun["status"]): boolean {
  return status === "queued" || status === "planning" || status === "running";
}

export function isObservedRunSettled(run: OrdinaryRun): boolean {
  return !shouldKeepRefreshing(run.status);
}
