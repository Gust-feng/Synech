import type { MemoryOwner as DomainMemoryOwner } from "../../domain/memory/index.js";

export type MemoryRolloutMode = "off" | "shadow" | "active";
export type MemoryRuntimeHealth = "ready" | "degraded" | "unavailable";
export type MemoryEffective = "off" | "shadow" | "active";

export type MemoryCapabilityStatus = {
  readonly globalConsent: boolean;
  readonly rollout: MemoryRolloutMode;
  readonly health: MemoryRuntimeHealth;
  readonly effective: MemoryEffective;
};

export type SetMemoryConsentInput = { readonly globalConsent: boolean };
export type SetMemorySpaceParticipationInput = { readonly spaceId: string; readonly enabled: boolean };
export type SetMemoryConversationParticipationInput = { readonly conversationId: string; readonly excluded: boolean };
export type ClearImplicitMemoryInput = { readonly scope: DomainMemoryOwner };

export type MemoryMutationResult = { readonly ok: true; readonly policyRevision: string };
export type ClearMemoryResult = { readonly ok: true; readonly generation: number };

async function postJson<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`memory API failed: ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchMemoryCapability(): Promise<{ readonly ok: true; readonly status: MemoryCapabilityStatus }> {
  const response = await fetch("/api/memory/capability", { method: "GET" });
  if (!response.ok) throw new Error(`memory capability failed: ${response.status}`);
  return (await response.json()) as { readonly ok: true; readonly status: MemoryCapabilityStatus };
}

export async function setMemoryConsent(input: SetMemoryConsentInput): Promise<MemoryMutationResult> {
  return postJson<MemoryMutationResult>({ op: "setConsent", ...input });
}

export async function setMemorySpaceParticipation(input: SetMemorySpaceParticipationInput): Promise<MemoryMutationResult> {
  return postJson<MemoryMutationResult>({ op: "setSpaceParticipation", ...input });
}

export async function setMemoryConversationParticipation(input: SetMemoryConversationParticipationInput): Promise<MemoryMutationResult> {
  return postJson<MemoryMutationResult>({ op: "setConversationParticipation", ...input });
}

export async function clearImplicitMemory(input: ClearImplicitMemoryInput): Promise<ClearMemoryResult> {
  return postJson<ClearMemoryResult>({ op: "clearImplicitMemory", scope: input.scope });
}
