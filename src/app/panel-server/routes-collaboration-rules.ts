import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { MemoryOwner } from "../../domain/memory/index.js";
import type { CollaborationRuleVersion } from "../collaboration-rules/index.js";
import type { CollaborationRulesApplication } from "../application/collaboration-rules-application.js";
import { PanelHttpError, readJsonBody, writeJson } from "./http-utils.js";

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("space"), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("workspace"), id: z.string().min(1) }).strict(),
]);
const versionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
  .transform((value): CollaborationRuleVersion => value as CollaborationRuleVersion);
const writeSchema = z.object({
  scope: scopeSchema,
  content: z.string().max(2_000),
  expectedVersion: versionSchema,
}).strict();
const deleteSchema = z.object({
  scope: scopeSchema,
  expectedVersion: versionSchema,
}).strict();

export async function handleCollaborationRulesRoute(
  application: CollaborationRulesApplication,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== "/api/collaboration-rules") return false;
  if (request.method === "GET") {
    writeJson(response, 200, { ok: true, document: await application.get(scopeFromUrl(url)) });
    return true;
  }
  if (request.method === "PUT") {
    const parsed = writeSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw new PanelHttpError(400, "collaboration_rule_input_invalid", parsed.error.message);
    const result = await application.write(parsed.data);
    if (result.status === "conflict") {
      throw new PanelHttpError(409, "collaboration_rule_revision_conflict", "协作规则已被更新，请重新读取后再保存。");
    }
    writeJson(response, 200, { ok: true, document: result.document });
    return true;
  }
  if (request.method === "DELETE") {
    const parsed = deleteSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw new PanelHttpError(400, "collaboration_rule_input_invalid", parsed.error.message);
    const result = await application.delete(parsed.data);
    if (result.status === "conflict") {
      throw new PanelHttpError(409, "collaboration_rule_revision_conflict", "协作规则已被更新，请重新读取后再删除。");
    }
    writeJson(response, 200, { ok: true, document: result.document });
    return true;
  }
  return false;
}

function scopeFromUrl(url: URL): MemoryOwner {
  const kind = url.searchParams.get("scopeKind");
  const id = url.searchParams.get("scopeId");
  if (kind === null && id === null) return { kind: "global" } as const;
  if ((kind !== "space" && kind !== "workspace") || id === null || id.length === 0) {
    throw new PanelHttpError(400, "collaboration_rule_scope_invalid", "协作规则范围无效。");
  }
  return kind === "space" ? { kind: "space", id } : { kind: "workspace", id };
}
