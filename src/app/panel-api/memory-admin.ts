import type { MemoryOwner as DomainMemoryOwner } from "../../domain/memory/index.js";

export type MemoryRolloutMode = "off" | "shadow" | "active";
export type MemoryRuntimeHealth = "ready" | "degraded" | "unavailable";
export type MemoryEffective = "off" | "shadow" | "active";

export type MemoryCapabilityStatus = {
  readonly globalConsent: boolean;
  readonly rollout: MemoryRolloutMode;
  readonly health: MemoryRuntimeHealth;
  readonly effective: MemoryEffective;
  readonly scopeParticipation?: boolean;
  readonly conversationExcluded?: boolean;
};

export type MemoryCapabilityQuery = {
  readonly owner?: DomainMemoryOwner;
  readonly conversationId?: string;
};

export type MemoryDiagnosticSnapshot = {
  readonly enabled: boolean;
  readonly traces: readonly {
    readonly at: number;
    readonly ownerKey: string;
    readonly conversationId?: string;
    readonly recallId: string;
    readonly effective: "off" | "shadow" | "active";
    readonly outcome: "off" | "no_hit" | "degraded" | "ok" | "invalidated";
    readonly policyRevision: string;
    readonly generation: number;
    readonly retrievedRefs: readonly { readonly id: string; readonly revision: number }[];
    readonly injectedRefs: readonly { readonly id: string; readonly revision: number }[];
    readonly latencyMs: number;
  }[];
  readonly shadowWouldInject: readonly {
    readonly at: number;
    readonly ownerKey: string;
    readonly conversationId?: string;
    readonly recallId: string;
    readonly policyRevision: string;
    readonly generation: number;
    readonly candidateRefs: readonly { readonly id: string; readonly revision: number }[];
  }[];
  readonly jobs: {
    readonly queued: number;
    readonly running: number;
    readonly done: number;
    readonly failed: number;
  };
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
  await assertMemoryResponse(response, "记忆操作失败");
  return (await response.json()) as T;
}

export async function fetchMemoryCapability(
  input: MemoryCapabilityQuery = {},
): Promise<{ readonly ok: true; readonly status: MemoryCapabilityStatus }> {
  const query = new URLSearchParams();
  if (input.owner !== undefined && input.owner.kind !== "global") {
    query.set("ownerKind", input.owner.kind);
    query.set("ownerId", input.owner.id);
  }
  if (input.conversationId !== undefined) query.set("conversationId", input.conversationId);
  const suffix = query.toString();
  const response = await fetch(`/api/memory/capability${suffix.length === 0 ? "" : `?${suffix}`}`, { method: "GET" });
  await assertMemoryResponse(response, "无法读取记忆状态");
  return (await response.json()) as { readonly ok: true; readonly status: MemoryCapabilityStatus };
}

export async function fetchMemoryDiagnostics(): Promise<{
  readonly ok: true;
  readonly diagnostics: MemoryDiagnosticSnapshot;
}> {
  const response = await fetch("/api/memory/diagnostics", { method: "GET" });
  await assertMemoryResponse(response, "无法读取记忆诊断");
  return (await response.json()) as { readonly ok: true; readonly diagnostics: MemoryDiagnosticSnapshot };
}

async function assertMemoryResponse(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  let message = fallback;
  try {
    const payload = await response.json() as {
      readonly error?: { readonly message?: unknown };
      readonly message?: unknown;
    };
    const candidate = payload.error?.message ?? payload.message;
    if (typeof candidate === "string" && candidate.length > 0) message = candidate;
  } catch {
    // Keep the stable user-facing fallback when the error body is not JSON.
  }
  throw new Error(`${message}（${response.status}）`);
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
