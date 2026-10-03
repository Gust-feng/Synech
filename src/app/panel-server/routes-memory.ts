import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { MemoryOwner } from "../../domain/memory/index.js";
import type { ConversationOwner } from "../../domain/execution-scope/contracts.js";
import type { MemoryFeature, UpdateMemoryEntryInput } from "../memory/index.js";
import { PanelHttpError, readJsonBody, writeJson } from "./http-utils.js";

const conversationOwnerSchema = z.object({ kind: z.literal("space"), id: z.string().min(1) }).strict();

const memoryOwnerSchema = z.union([
  z.object({ kind: z.literal("global") }).strict(),
  conversationOwnerSchema,
]);

const setEnabledSchema = z.object({ op: z.literal("setEnabled"), enabled: z.boolean() }).strict();
const setRolloutSchema = z.object({ op: z.literal("setRollout"), rollout: z.enum(["off", "shadow", "active"]) }).strict();
const clearSchema = z.object({ op: z.literal("clearMemory"), scope: memoryOwnerSchema }).strict();
const updateMemorySchema = z.object({
  op: z.literal("updateMemory"),
  owner: conversationOwnerSchema,
  requestId: z.string().trim().min(1).max(256),
  // Semantic edit validation belongs to the single Application command.
  edit: z.unknown(),
}).strict();
const mutationBodySchema = z.discriminatedUnion("op", [
  setEnabledSchema,
  setRolloutSchema,
  clearSchema,
  updateMemorySchema,
]);

const diagnosticQuerySchema = z.object({
  ownerKind: z.literal("space").optional(),
  ownerId: z.string().min(1).max(256).optional(),
  conversationId: z.string().min(1).max(256).optional(),
}).strict();
const diagnosticSearchSchema = diagnosticQuerySchema.extend({
  ownerKind: z.literal("space"),
  ownerId: z.string().min(1).max(256),
  query: z.string().trim().min(1).max(2048),
  source: z.enum(["summary", "transcript", "all"]).default("all"),
});

export async function handleMemoryStatusRoute(
  feature: Pick<MemoryFeature, "queries">,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== "/api/memory/status") return false;
  const owner = optionalOwnerFromUrl(url);
  const status = await feature.queries.getStatus(owner === undefined ? {} : { owner });
  writeJson(response, 200, { ok: true, status });
  return true;
}

export async function handleMemoryDiagnosticsRoute(
  feature: Pick<MemoryFeature, "queries">,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method !== "GET") return false;
  if (url.pathname === "/api/memory/diagnostics/search") {
    const query = diagnosticSearchSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) throw new PanelHttpError(400, "memory_diagnostic_query_invalid", "检索参数无效。");
    writeJson(response, 200, {
      ok: true,
      result: await feature.queries.searchDiagnosticHistory({
        owner: { kind: query.data.ownerKind, id: query.data.ownerId },
        ...(query.data.conversationId === undefined ? {} : { conversationId: query.data.conversationId }),
        query: query.data.query,
        source: query.data.source,
      }),
    });
    return true;
  }
  if (url.pathname !== "/api/memory/diagnostics") return false;
  const parsed = diagnosticQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success || (parsed.data.ownerKind === undefined) !== (parsed.data.ownerId === undefined)) {
    throw new PanelHttpError(400, "memory_diagnostic_query_invalid", "诊断范围无效。");
  }
  const query = parsed.data.ownerKind === undefined
    ? { ...(parsed.data.conversationId === undefined ? {} : { conversationId: parsed.data.conversationId }) }
    : {
        owner: { kind: parsed.data.ownerKind, id: parsed.data.ownerId! },
        ...(parsed.data.conversationId === undefined ? {} : { conversationId: parsed.data.conversationId }),
      };
  writeJson(response, 200, { ok: true, diagnostics: await feature.queries.getDiagnosticSnapshot(query) });
  return true;
}

export async function handleMemoryDocumentRoute(
  feature: Pick<MemoryFeature, "queries">,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== "/api/memory/document") return false;
  const owner = requiredOwnerFromUrl(url, "memory_document_query_invalid", "缺少有效 owner。");
  const page = z.object({
    ownerKind: z.literal("space"), ownerId: z.string().min(1),
    entryId: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).max(4096).optional(),
  }).strict().safeParse(Object.fromEntries(url.searchParams));
  if (!page.success) throw new PanelHttpError(400, "memory_document_query_invalid", "记忆分页参数无效。");
  const { entryId, limit, cursor } = page.data;
  const view = await feature.queries.getMemoryView({ owner,
    ...(entryId === undefined ? {} : { entryId }), ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  writeJson(response, 200, { ok: true, view });
  return true;
}

export async function handleMemoryMutationRoute(
  feature: Pick<MemoryFeature, "commands">,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const parsed = mutationBodySchema.safeParse(body);
  if (!parsed.success) throw new PanelHttpError(400, "memory_mutation_invalid", parsed.error.message);
  const input = parsed.data;
  switch (input.op) {
    case "setEnabled": {
      const result = await feature.commands.setEnabled({ enabled: input.enabled });
      writeJson(response, 200, { ok: true, policyRevision: result.policyRevision });
      return;
    }
    case "setRollout": {
      const result = await feature.commands.setRollout({ rollout: input.rollout });
      writeJson(response, 200, { ok: true, policyRevision: result.policyRevision });
      return;
    }
    case "clearMemory": {
      const result = await feature.commands.clearMemory({ scope: input.scope as MemoryOwner });
      writeJson(response, 200, { ok: true, generation: result.generation });
      return;
    }
    case "updateMemory": {
      const result = await feature.commands.updateMemory({
        owner: input.owner as ConversationOwner,
        requestId: input.requestId,
        edit: input.edit as UpdateMemoryEntryInput["edit"],
      });
      writeJson(response, 200, { ok: true, ...result });
      return;
    }
  }
}

function optionalOwnerFromUrl(url: URL): ConversationOwner | undefined {
  const ownerKind = url.searchParams.get("ownerKind");
  const ownerId = url.searchParams.get("ownerId");
  if (ownerKind === null && ownerId === null) return undefined;
  return parseOwner(ownerKind, ownerId, "memory_owner_query_invalid", "记忆 owner 查询范围无效。");
}

function requiredOwnerFromUrl(url: URL, code: string, message: string): ConversationOwner {
  return parseOwner(url.searchParams.get("ownerKind"), url.searchParams.get("ownerId"), code, message);
}

function parseOwner(
  ownerKind: string | null,
  ownerId: string | null,
  code: string,
  message: string,
): ConversationOwner {
  const parsed = conversationOwnerSchema.safeParse({ kind: ownerKind, id: ownerId });
  if (!parsed.success) throw new PanelHttpError(400, code, message);
  return parsed.data;
}
