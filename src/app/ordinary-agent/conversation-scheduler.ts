import type { OrdinaryRunState } from "./contracts.js";
import { isTerminal } from "./run-lifecycle-policy.js";

export type OrdinaryRunSchedulingFacts = {
  readonly unsettledToolWork: boolean;
  readonly sessionFinalizationPending: boolean;
  readonly executionActive: boolean;
};

export function isSchedulingBarrierCleared(
  state: OrdinaryRunState,
  facts: OrdinaryRunSchedulingFacts,
): boolean {
  if (!isTerminal(state) ||
      state.pendingToolRound !== undefined ||
      state.pendingNestedToolCalls !== undefined ||
      facts.unsettledToolWork ||
      facts.sessionFinalizationPending) {
    return false;
  }

  // Cancellation closes admission before an abort-ignoring model call exits.
  // Accepted tool work remains a barrier through unsettledToolWork above.
  return state.status.kind === "cancelled" || !facts.executionActive;
}

export function nextEligibleQueuedRun(
  runs: readonly OrdinaryRunState[],
  schedulingFacts: (runId: string) => OrdinaryRunSchedulingFacts,
): OrdinaryRunState | undefined {
  for (const run of runs) {
    if (run.status.kind === "queued") return run;
    if (!isSchedulingBarrierCleared(run, schedulingFacts(run.runId))) return undefined;
  }
  return undefined;
}

export function orderedConversationRuns(
  conversationId: string,
  runs: Iterable<OrdinaryRunState>,
): readonly OrdinaryRunState[] {
  return [...runs]
    .filter((run) => run.turn.conversationId === conversationId)
    .sort((left, right) => left.turn.ordinal - right.turn.ordinal);
}
