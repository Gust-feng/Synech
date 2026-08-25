import { createHash, randomUUID } from "node:crypto";

export type IdFactory = (prefix: string) => string;

export function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Build a stable, Synech-owned invocation id by hashing the inputs that fully
 * identify one accepted tool call. The result is opaque (no prefix, no
 * provider id, no tool name visible) so the value never accidentally aliases
 * a provider or tool fact, but it remains stable across retry, UI reconnect,
 * and re-delivery of the exact same call.
 *
 * `roundId` is a per-message token from the owning loop (typically the durable
 * Session entry id of the assistant message). Including it prevents collisions
 * when a provider protocol reuses the same provider call id across different
 * model rounds inside one run.
 */
export function createStableInvocationId(input: {
  readonly runId: string;
  readonly roundId: string;
  readonly parentInvocationId?: string;
  readonly providerCallId: string;
}): string {
  const material = input.parentInvocationId === undefined
    ? `${input.runId}\u0000root\u0000${input.roundId}\u0000${input.providerCallId}`
    : `${input.runId}\u0000nested\u0000${input.roundId}\u0000${input.parentInvocationId}\u0000${input.providerCallId}`;
  return createHash("sha256").update(material).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}
