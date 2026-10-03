import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { CollaborationRuleScope, CollaborationRuleVersion } from "../collaboration-rules/index.js";
import {
  CollaborationRulesApplicationError,
  type CollaborationRulesApplication,
} from "../application/collaboration-rules-application.js";
import { PanelHttpError, readJsonBody, writeJson } from "./http-utils.js";

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("space"), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("workspace"), id: z.string().min(1) }).strict(),
]);
const versionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
  .transform((value): CollaborationRuleVersion => value as CollaborationRuleVersion);
/**
 * Transport guard only: the per-scope budget (2000 characters for the managed
 * store, 8000 tokens for a Workspace AGENTS.md) is enforced by the Application,
 * so this bound must not reject a legal Workspace file.
 */
const MAX_RULES_TRANSPORT_CHARS = 65_536;
const writeSchema = z.object({
  scope: scopeSchema,
  content: z.string().max(MAX_RULES_TRANSPORT_CHARS),
  expectedVersion: versionSchema,
}).strict();
const deleteSchema = z.object({
  scope: scopeSchema,
  expectedVersion: versionSchema,
}).strict();

/**
 * Structured Application failures for one rules scope.
 *
 * Unsupported/unavailable are scope facts the browser must distinguish from a
 * revision conflict; over-capacity is an invalid input. The shared Panel error
 * mapper owns the managed-store codes, so only the Application boundary is mapped
 * here.
 */
function applicationHttpError(error: CollaborationRulesApplicationError): PanelHttpError {
  switch (error.code) {
    case "collaboration_rules_capacity_exceeded":
      return new PanelHttpError(400, error.code, error.message);
    case "collaboration_rules_scope_unsupported":
    case "collaboration_rules_scope_unavailable":
      return new PanelHttpError(409, error.code, error.message);
  }
}

async function mapApplicationError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CollaborationRulesApplicationError) throw applicationHttpError(error);
    throw error;
  }
}

export async function handleCollaborationRulesRoute(
  application: CollaborationRulesApplication,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== "/api/collaboration-rules") return false;
  if (request.method === "GET") {
    writeJson(response, 200, { ok: true, document: await mapApplicationError(async () => await application.get(scopeFromUrl(url))) });
    return true;
  }
  if (request.method === "PUT") {
    const parsed = writeSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw new PanelHttpError(400, "collaboration_rule_input_invalid", parsed.error.message);
    const result = await mapApplicationError(async () => await application.write(parsed.data));
    if (result.status === "conflict") {
      throw new PanelHttpError(409, "collaboration_rule_revision_conflict", "协作规则已被更新，请重新读取后再保存。");
    }
    writeJson(response, 200, { ok: true, document: result.document });
    return true;
  }
  if (request.method === "DELETE") {
    const parsed = deleteSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw new PanelHttpError(400, "collaboration_rule_input_invalid", parsed.error.message);
    const result = await mapApplicationError(async () => await application.delete(parsed.data));
    if (result.status === "conflict") {
      throw new PanelHttpError(409, "collaboration_rule_revision_conflict", "协作规则已被更新，请重新读取后再删除。");
    }
    writeJson(response, 200, { ok: true, document: result.document });
    return true;
  }
  return false;
}

function scopeFromUrl(url: URL): CollaborationRuleScope {
  const kind = url.searchParams.get("scopeKind");
  const id = url.searchParams.get("scopeId");
  if (kind === null && id === null) return { kind: "global" } as const;
  if ((kind !== "space" && kind !== "workspace") || id === null || id.length === 0) {
    throw new PanelHttpError(400, "collaboration_rule_scope_invalid", "协作规则范围无效。");
  }
  return kind === "space" ? { kind: "space", id } : { kind: "workspace", id };
}
