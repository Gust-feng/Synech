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

export function handleMemoryCapabilityRoute(
  feature: Pick<MemoryFeature, "queries">,
  response: ServerResponse,
): void {
  void feature.queries.getCapabilityStatus()
    .then((status) => writeJson(response, 200, { ok: true, status }))
    .catch((error) => respondError(response, error));
}

export async function handleMemoryMutationRoute(
  feature: Pick<MemoryFeature, "commands">,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
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
        // conversation scope 在 UI 层不传 memory 域（conversation 不属于 MemoryOwner）；
        // UI 上"本对话不参与"只写 conversation_exclusion policy 行，不触发清除。
        if (input.scope.kind === "conversation") {
          throw new PanelHttpError(400, "memory_scope_invalid", "conversation scope cannot be cleared via memory API");
        }
        const result = await feature.commands.clearImplicitMemory({ scope: input.scope as MemoryOwner });
        writeJson(response, 200, { ok: true, generation: result.generation });
        return;
      }
    }
  } catch (error) {
    respondError(response, error);
  }
}

function respondError(response: ServerResponse, error: unknown): void {
  if (error instanceof PanelHttpError) {
    writeJson(response, error.statusCode, { ok: false, code: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : "memory_route_failed";
  writeJson(response, 500, { ok: false, code: "memory_route_failed", message });
}
