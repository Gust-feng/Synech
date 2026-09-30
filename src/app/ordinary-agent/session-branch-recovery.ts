import type {
  AgentSessionCheckpointPosition,
  AgentSessionCheckpointRef,
  AgentSessionRef,
  AgentSessionRepository,
} from "../model-runtime/agent-session.js";
import { OrdinaryFeatureError, type OrdinaryRunState } from "./contracts.js";

/** The checkpoint this run would restore the live branch to. */
function rollbackCheckpoint(state: OrdinaryRunState): AgentSessionCheckpointRef | null {
  switch (state.session.phase) {
    case "not_started": return null;
    case "started": return state.session.startCheckpoint;
    case "rollbackable": return state.session.endCheckpoint;
    case "completion_candidate": return state.session.rollbackCheckpoint;
  }
}

/**
 * Resolves the deepest durable checkpoint this conversation recorded.
 *
 * The product contributes only the checkpoints it recorded itself; the runtime
 * provider answers where each one sits on the live transcript. Product code
 * therefore never interprets branch structure, so a provider change to branch
 * layout cannot silently change recovery behaviour.
 */
export async function recoveredSessionCheckpoint(
  store: Pick<AgentSessionRepository, "locateSessionCheckpoints">,
  runs: readonly OrdinaryRunState[],
  sessionRef: AgentSessionRef,
  conversationId: string,
): Promise<AgentSessionCheckpointRef | null> {
  const recorded = runs
    .map(rollbackCheckpoint)
    .filter((checkpoint): checkpoint is AgentSessionCheckpointRef => checkpoint !== null);
  if (recorded.length === 0) return null;
  const located = await store.locateSessionCheckpoints({ sessionRef, checkpoints: recorded });
  const deepest = located.reduce<AgentSessionCheckpointPosition | undefined>(
    (best, item) => (best === undefined || item.position > best.position ? item : best),
    undefined,
  );
  if (deepest !== undefined) return deepest.checkpoint;
  throw new OrdinaryFeatureError(
    "ordinary_run_state_conflict",
    `Ordinary conversation ${conversationId} has no persisted safe checkpoint on its active Session branch`,
  );
}

export function sameSessionCheckpoint(
  left: AgentSessionCheckpointRef | null,
  right: AgentSessionCheckpointRef | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.sessionId === right.sessionId && left.checkpointId === right.checkpointId;
}
