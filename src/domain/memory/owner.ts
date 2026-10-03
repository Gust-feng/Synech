import type { ConversationOwner } from "../execution-scope/contracts.js";

/** Stable identity for long-lived memory; never a cwd or path hash. */
export type MemoryOwner =
  | { readonly kind: "global" }
  | { readonly kind: "space"; readonly id: string };

export function memoryOwnerKey(owner: MemoryOwner): string {
  return owner.kind === "global" ? "global" : `space:${owner.id}`;
}

export function memoryOwnersForConversation(owner: ConversationOwner): readonly MemoryOwner[] {
  return [{ kind: "global" }, { kind: "space", id: owner.id }];
}

export function isMemoryOwner(value: unknown): value is MemoryOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { readonly kind?: unknown; readonly id?: unknown };
  if (candidate.kind === "global") return candidate.id === undefined;
  return candidate.kind === "space" && typeof candidate.id === "string" && candidate.id.length > 0;
}

export function memoryOwnerLabel(owner: MemoryOwner): string {
  return owner.kind === "global" ? "global" : `space:${owner.id}`;
}
