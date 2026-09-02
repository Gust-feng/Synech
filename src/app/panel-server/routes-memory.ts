import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { MemoryOwner } from "../../domain/memory/index.js";
import type { MemoryFeature } from "../memory/index.js";
import { PanelHttpError, readJsonBody, writeJson } from "./http-utils.js";

const memoryOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("space"), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("workspace"), id: z.string().min(1) }).strict(),
]);

const setConsentSchema = z.object({ op: z.literal("setConsent"), globalConsent: z.boolean() }).strict();
const setSpaceSchema = z.object({ op: z.literal("setSpaceParticipation"), spaceId: z.string().min(1), enabled: z.boolean() }).strict();
const setConversationSchema = z.object({ op: z.literal("setConversationParticipation"), conversationId: z.string().min(1), excluded: z.boolean() }).strict();
const clearSchema = z.object({ op: z.literal("clearImplicitMemory"), scope: memoryOwnerSchema }).strict();
const mutationBodySchema = z.discriminatedUnion("op", [setConsentSchema, setSpaceSchema, setConversationSchema, clearSchema]);

export async function handleMemoryCapabilityRoute(
  feature: Pick<MemoryFeature, "queries">,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== "/api/memory/capability") return false;
  const query = capabilityQueryFromUrl(url);
  const status = await feature.queries.getCapabilityStatus(query);
  writeJson(response, 200, { ok: true, status });
  return true;
}

export async function handleMemoryDiagnosticsRoute(
  feature: Pick<MemoryFeature, "queries">,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== "/api/memory/diagnostics") return false;
  writeJson(response, 200, { ok: true, diagnostics: await feature.queries.getDiagnosticSnapshot() });
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
    case "setConsent": {
      const result = await feature.commands.setConsent({ globalConsent: input.globalConsent });
      writeJson(response, 200, { ok: true, policyRevision: result.policyRevision });
      return;
    }
    case "setSpaceParticipation": {
      const result = await feature.commands.setSpaceParticipation({ spaceId: input.spaceId, enabled: input.enabled });
      writeJson(response, 200, { ok: true, policyRevision: result.policyRevision });
      return;
    }
    case "setConversationParticipation": {
      const result = await feature.commands.setConversationParticipation({ conversationId: input.conversationId, excluded: input.excluded });
      writeJson(response, 200, { ok: true, policyRevision: result.policyRevision });
      return;
    }
    case "clearImplicitMemory": {
      const result = await feature.commands.clearImplicitMemory({ scope: input.scope as MemoryOwner });
      writeJson(response, 200, { ok: true, generation: result.generation });
      return;
    }
  }
}

function capabilityQueryFromUrl(url: URL): {
  readonly owner?: MemoryOwner;
  readonly conversationId?: string;
} {
  const ownerKind = url.searchParams.get("ownerKind");
  const ownerId = url.searchParams.get("ownerId");
  if (ownerKind === null && ownerId === null) {
    const conversationId = url.searchParams.get("conversationId");
    return conversationId === null ? {} : { conversationId };
  }
  if ((ownerKind !== "space" && ownerKind !== "workspace") || ownerId === null || ownerId.length === 0) {
    throw new PanelHttpError(400, "memory_capability_query_invalid", "记忆状态查询范围无效。");
  }
  const conversationId = url.searchParams.get("conversationId");
  return {
    owner: { kind: ownerKind, id: ownerId },
    ...(conversationId === null ? {} : { conversationId }),
  };
}
