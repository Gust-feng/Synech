import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import type {
  HistorySearchResult,
  MemoryCapabilityStatus,
  MemoryDiagnosticQuery,
  MemoryDiagnosticSearchInput,
  MemoryDiagnosticSnapshot,
  MemoryRolloutMode,
  OwnerMemoryBackground,
} from "../memory/contracts.js";

import type { MemoryEntryAdminPort, UpdateMemoryEntryInput, UpdateMemoryEntryResult } from "../memory/entry-contracts.js";
export type { MemoryEntryRevisionView, MemorySourceView, MemoryRevisionKind } from "../memory/entry-contracts.js";

export type {
  HistorySearchResult,
  MemoryCapabilityStatus,
  MemoryDiagnosticContext,
  MemoryDiagnosticJob,
  MemoryDiagnosticQuery,
  MemoryDiagnosticSearchInput,
  MemoryDiagnosticSnapshot,
  MemoryMaintenanceOutcomeTrace,
  MemoryRolloutMode,
  MemoryRuntimeHealth,
} from "../memory/contracts.js";

/**
 * Panel HTTP DTO facade for the memory administration contract. These aliases
 * intentionally reuse the Memory owner’s source types rather than mirror their
 * status, document, or diagnostics shapes in the UI layer.
 */
export type MemoryEffective = MemoryCapabilityStatus["effective"];
export type MemoryScope = import("../../domain/memory/index.js").MemoryOwner;
export type MemoryStatusQuery = { readonly owner?: ConversationOwner };
export type MemoryDocumentView = OwnerMemoryBackground;
export type MemoryView = Awaited<ReturnType<MemoryEntryAdminPort["getMemoryView"]>>;
export type SetMemoryEnabledInput = { readonly enabled: boolean };
export type ClearMemoryInput = { readonly scope: MemoryScope };
export type UpdateMemoryInput = UpdateMemoryEntryInput;
export type SetMemoryRolloutInput = { readonly rollout: MemoryRolloutMode };

export type MemoryMutationResult = { readonly ok: true; readonly policyRevision: string };
export type ClearMemoryResult = { readonly ok: true; readonly generation: number };
export type UpdateMemoryResult = { readonly ok: true } & UpdateMemoryEntryResult;

function ownerSearchParams(owner: ConversationOwner | undefined): URLSearchParams {
  const query = new URLSearchParams();
  if (owner !== undefined) {
    query.set("ownerKind", owner.kind);
    query.set("ownerId", owner.id);
  }
  return query;
}

function querySuffix(query: URLSearchParams): string {
  const value = query.toString();
  return value.length === 0 ? "" : `?${value}`;
}

export class MemoryApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "MemoryApiError"; }
}

async function assertMemoryResponse(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  let message = fallback;
  let code: string | undefined;
  try {
    const payload = await response.json() as {
      readonly error?: { readonly message?: unknown; readonly code?: unknown };
      readonly message?: unknown;
    };
    code = typeof payload.error?.code === "string" ? payload.error.code : undefined;
    const candidate = payload.error?.message ?? payload.message;
    if (typeof candidate === "string" && candidate.length > 0) message = candidate;
  } catch {
    // Keep the stable user-facing fallback when the error body is not JSON.
  }
  throw new MemoryApiError(message, response.status, code);
}

async function postJson<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const response = await fetch("/api/memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await assertMemoryResponse(response, fallback);
  return (await response.json()) as T;
}

/** GET /api/memory/status：省略 owner 时读取全局开关状态。 */
export async function fetchMemoryStatus(
  input: MemoryStatusQuery = {},
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly status: MemoryCapabilityStatus }> {
  const response = await fetch(`/api/memory/status${querySuffix(ownerSearchParams(input.owner))}`, { method: "GET", signal });
  await assertMemoryResponse(response, "无法读取记忆状态");
  return (await response.json()) as { readonly ok: true; readonly status: MemoryCapabilityStatus };
}

/** GET /api/memory/document：owner 级正文、来源与整理元数据。 */
export async function fetchMemoryView(
  input: Parameters<MemoryEntryAdminPort["getMemoryView"]>[0],
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly view: MemoryView }> {
  const query = ownerSearchParams(input.owner);
  if (input.entryId !== undefined) query.set("entryId", input.entryId);
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  const response = await fetch(`/api/memory/document${querySuffix(query)}`, { method: "GET", signal });
  await assertMemoryResponse(response, "无法读取长期记忆");
  return (await response.json()) as { readonly ok: true; readonly view: MemoryView };
}

export async function setMemoryEnabled(input: SetMemoryEnabledInput): Promise<MemoryMutationResult> {
  return postJson<MemoryMutationResult>({ op: "setEnabled", ...input }, "记忆开关更新失败");
}

export async function clearMemory(input: ClearMemoryInput): Promise<ClearMemoryResult> {
  return postJson<ClearMemoryResult>({ op: "clearMemory", scope: input.scope }, "记忆清除失败");
}

export async function updateMemory(input: UpdateMemoryInput): Promise<UpdateMemoryResult> {
  return postJson<UpdateMemoryResult>({ op: "updateMemory", ...input }, "记忆保存失败");
}

/** 开发者装配开关；不是用户可见模式。 */
export async function setMemoryRollout(input: SetMemoryRolloutInput): Promise<MemoryMutationResult> {
  return postJson<MemoryMutationResult>({ op: "setRollout", ...input }, "记忆开关更新失败");
}

export async function fetchMemoryDiagnostics(
  input: MemoryDiagnosticQuery = {},
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly diagnostics: MemoryDiagnosticSnapshot }> {
  const query = ownerSearchParams(input.owner);
  if (input.conversationId !== undefined) query.set("conversationId", input.conversationId);
  const response = await fetch(`/api/memory/diagnostics${querySuffix(query)}`, { method: "GET", signal });
  await assertMemoryResponse(response, "无法读取记忆诊断");
  return (await response.json()) as { readonly ok: true; readonly diagnostics: MemoryDiagnosticSnapshot };
}

export async function searchMemoryDiagnostics(
  input: MemoryDiagnosticSearchInput,
  signal?: AbortSignal,
): Promise<HistorySearchResult> {
  const query = ownerSearchParams(input.owner);
  query.set("query", input.query);
  query.set("source", input.source);
  if (input.conversationId !== undefined) query.set("conversationId", input.conversationId);
  const response = await fetch(`/api/memory/diagnostics/search${querySuffix(query)}`, { method: "GET", signal });
  await assertMemoryResponse(response, "无法搜索历史");
  const payload = await response.json() as { readonly result: HistorySearchResult };
  return payload.result;
}