import type { ConversationOwner } from "../execution-scope/contracts.js";

/** Stable identity for long-lived memory; never a cwd or path hash. */
export type MemoryOwner =
  | { readonly kind: "global" }
  | ConversationOwner;

export type MemoryContentKind = "note" | "path_dependency";

export function memoryOwnerKey(owner: MemoryOwner): string {
  return owner.kind === "global" ? "global" : `${owner.kind}:${owner.id}`;
}

export function memoryOwnersForConversation(owner: ConversationOwner): readonly MemoryOwner[] {
  return [{ kind: "global" }, owner];
}

export function isMemoryOwner(value: unknown): value is MemoryOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { readonly kind?: unknown; readonly id?: unknown };
  if (candidate.kind === "global") return candidate.id === undefined;
  return (candidate.kind === "space" || candidate.kind === "workspace") &&
    typeof candidate.id === "string" && candidate.id.length > 0;
}

export function memoryOwnerLabel(owner: MemoryOwner): string {
  return owner.kind === "global" ? "global" : `${owner.kind}:${owner.id}`;
}
