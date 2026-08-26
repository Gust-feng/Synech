import path from "node:path";

/** Shared serialization key for Space, Workspace and Conversation deletion coordination. */
export function deletionLifecycleLockKey(lockRoot: string): string {
  return path.join(lockRoot, ".deletion-lifecycle.lock");
}
