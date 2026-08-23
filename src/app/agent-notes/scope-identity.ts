import type { AgentNoteOwner, AgentNoteScope } from "./contracts.js";

/**
 * Stable identity used for in-process serialization and storage naming.
 *
 * This deliberately does not normalize or inspect a filesystem path. A path is an execution
 * fact, not a memory owner; using it here would make a Workspace remount silently select a
 * different notebook.
 */
export function agentNoteScopeIdentity(scope: AgentNoteScope): string {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.id}`;
}

/** Public helper for Host adapters that need the owner key without importing storage code. */
export function agentNoteOwnerIdentity(owner: AgentNoteOwner): string {
  return agentNoteScopeIdentity(owner);
}
