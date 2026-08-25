import type { AgentSessionEntryRef } from "../model-runtime/agent-session.js";
import { OrdinaryFeatureError, type OrdinaryRunState } from "./contracts.js";

export function sessionEntryKey(ref: AgentSessionEntryRef): string {
  return `${ref.sessionId}\u0000${ref.entryId}`;
}

function rollbackLeafRef(state: OrdinaryRunState): AgentSessionEntryRef | null {
  switch (state.session.phase) {
    case "not_started": return null;
    case "started": return state.session.startLeafRef;
    case "rollbackable": return state.session.endLeafRef;
    case "completion_candidate": return state.session.rollbackLeafRef;
  }
}

export function recoveredSessionLeaf(
  runs: readonly OrdinaryRunState[],
  activeBranch: readonly AgentSessionEntryRef[],
  conversationId: string,
): AgentSessionEntryRef | null {
  const branchIndex = new Map(activeBranch.map((entry, index) => [sessionEntryKey(entry), index]));
  const durableLeaves = runs
    .map(rollbackLeafRef)
    .filter((entry): entry is AgentSessionEntryRef => entry !== null);
  let target: { readonly entry: AgentSessionEntryRef; readonly index: number } | undefined;
  for (const entry of durableLeaves) {
    const index = branchIndex.get(sessionEntryKey(entry));
    if (index !== undefined && (target === undefined || index > target.index)) target = { entry, index };
  }
  if (target !== undefined) return target.entry;
  if (durableLeaves.length > 0) {
    throw new OrdinaryFeatureError(
      "ordinary_run_state_conflict",
      `Ordinary conversation ${conversationId} has no persisted safe leaf on its active Session branch`,
    );
  }
  return null;
}

export function sameSessionEntryRef(left: AgentSessionEntryRef | null, right: AgentSessionEntryRef | null): boolean {
  return left === null || right === null
    ? left === right
    : left.sessionId === right.sessionId && left.entryId === right.entryId;
}
