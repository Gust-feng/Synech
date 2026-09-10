import type { MemoryOwner as DomainMemoryOwner } from "../../domain/memory/index.js";
import type { MemoryDiagnosticSnapshot, MemoryDiagnosticQuery, MemoryDiagnosticSearchInput, HistorySearchResult } from "../memory/contracts.js";
export type { MemoryDiagnosticSnapshot, MemoryDiagnosticQuery, MemoryDiagnosticJob, MemoryDiagnosticContext,
  MemoryMaintenanceOutcomeTrace, MemoryDiagnosticSearchInput, HistorySearchResult } from "../memory/contracts.js";

export type MemoryRolloutMode = "off" | "shadow" | "active";
export type MemoryRuntimeHealth = "ready" | "degraded" | "unavailable";
export type MemoryEffective = "off" | "shadow" | "active";

export type MemoryCapabilityStatus = {
  readonly globalConsent: boolean;
  readonly rollout: MemoryRolloutMode;
  readonly health: MemoryRuntimeHealth;
  readonly effective: MemoryEffective;
  readonly spaceParticipation?: boolean;
};

export type MemoryCapabilityQuery = {
  readonly owner?: DomainMemoryOwner;
};

export type SpaceMemoryDocumentView = {
  readonly revisionId: string;
  readonly revision: number;
  readonly origin: "model" | "user_edit";
  readonly markdown: string;
  readonly generation: number;
  readonly updatedAt: number;
};

export type SpaceMemorySourceView = {
  readonly conversationId: string;
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
  readonly title?: string;
  /** 来源会话最近更新时间；不是事实发生时间。 */
  readonly sourceTime?: string;
};

export type SpaceMemoryView = {
  readonly document: SpaceMemoryDocumentView | undefined;
  readonly sources: readonly SpaceMemorySourceView[];
  readonly summaryCount: number;
  readonly lastMaintenanceAt: number | null;
};

export type SetMemoryConsentInput = { readonly globalConsent: boolean };
export type SetMemoryRolloutInput = { readonly rollout: MemoryRolloutMode };
export type SetMemorySpaceParticipationInput = { readonly spaceId: string; readonly enabled: boolean };
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
  const suffix = query.toString();
  const response = await fetch(`/api/memory/capability${suffix.length === 0 ? "" : `?${suffix}`}`, { method: "GET" });
  await assertMemoryResponse(response, "无法读取记忆状态");
  return (await response.json()) as { readonly ok: true; readonly status: MemoryCapabilityStatus };
}

export async function fetchMemoryDiagnostics(input: MemoryDiagnosticQuery = {}, signal?: AbortSignal): Promise<{
  readonly ok: true;
  readonly diagnostics: MemoryDiagnosticSnapshot;
}> {
  const query = new URLSearchParams();
  if (input.spaceId !== undefined) query.set("spaceId", input.spaceId);
  if (input.conversationId !== undefined) query.set("conversationId", input.conversationId);
  const response = await fetch(`/api/memory/diagnostics?${query}`, { method: "GET", signal });
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

export async function setMemoryRollout(input: SetMemoryRolloutInput): Promise<MemoryMutationResult> {
  return postJson<MemoryMutationResult>({ op: "setRollout", ...input });
}

export async function setMemorySpaceParticipation(input: SetMemorySpaceParticipationInput): Promise<MemoryMutationResult> {
  return postJson<MemoryMutationResult>({ op: "setSpaceParticipation", ...input });
}

export async function clearImplicitMemory(input: ClearImplicitMemoryInput): Promise<ClearMemoryResult> {
  return postJson<ClearMemoryResult>({ op: "clearImplicitMemory", scope: input.scope });
}

export type WriteSpaceMemoryInput = {
  readonly spaceId: string;
  readonly expectedRevisionId: string | null;
  readonly markdown: string;
  readonly requestId: string;
};
export type WriteSpaceMemoryResult = { readonly ok: true; readonly revisionId: string; readonly revision: number };

export async function writeSpaceMemory(input: WriteSpaceMemoryInput): Promise<WriteSpaceMemoryResult> {
  return postJson<WriteSpaceMemoryResult>({ op: "writeSpaceMemory", ...input });
}

export async function fetchSpaceMemoryView(spaceId: string): Promise<{
  readonly ok: true;
  readonly view: SpaceMemoryView;
}> {
  const query = new URLSearchParams({ spaceId });
  const response = await fetch(`/api/memory/space?${query.toString()}`, { method: "GET" });
  await assertMemoryResponse(response, "无法读取 Space 记忆");
  return (await response.json()) as { readonly ok: true; readonly view: SpaceMemoryView };
}

export async function searchMemoryDiagnostics(input: MemoryDiagnosticSearchInput, signal?: AbortSignal): Promise<HistorySearchResult> {
  const query = new URLSearchParams({ spaceId: input.spaceId, query: input.query, source: input.source });
  if (input.conversationId !== undefined) query.set("conversationId", input.conversationId);
  const response = await fetch(`/api/memory/diagnostics/search?${query}`, { method: "GET", signal });
  await assertMemoryResponse(response, "无法搜索历史");
  const payload = await response.json() as { readonly result: HistorySearchResult };
  return payload.result;
}
