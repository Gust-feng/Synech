import type { MemoryRuntimeHealth } from "./contracts.js";

/**
 * Process-local health projection for optional Memory work.
 *
 * This never changes policy and deliberately requires consecutive faults before
 * reporting degraded: a one-off timeout or provider hiccup should not make the
 * ordinary settings surface noisy. A successful operation clears only its own
 * capture or recall lane, so an unrelated no-hit cannot mask a failed writer.
 * Shared SQLite startup failures remain process-level failures rather
 * than being hidden behind this optional projection.
 */
export type MemoryRuntimeHealthTracker = {
  read(): Promise<MemoryRuntimeHealth>;
  reportSuccess(lane: MemoryRuntimeHealthLane): void;
  reportFault(lane: MemoryRuntimeHealthLane): void;
};

export type MemoryRuntimeHealthLane = "capture" | "recall";

export function createMemoryRuntimeHealthTracker(
  degradedAfterConsecutiveFaults = 2,
): MemoryRuntimeHealthTracker {
  const consecutiveFaults: Record<MemoryRuntimeHealthLane, number> = {
    capture: 0,
    recall: 0,
  };
  return {
    async read() {
      return Object.values(consecutiveFaults).some((count) => count >= degradedAfterConsecutiveFaults)
        ? "degraded"
        : "ready";
    },
    reportSuccess(lane) {
      consecutiveFaults[lane] = 0;
    },
    reportFault(lane) {
      consecutiveFaults[lane] += 1;
    },
  };
}
