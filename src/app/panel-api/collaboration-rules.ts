export type CollaborationRuleScope =
  | { readonly kind: "global" }
  | { readonly kind: "space"; readonly id: string }
  | { readonly kind: "workspace"; readonly id: string };

export type CollaborationRulesDocument = {
  readonly scope: CollaborationRuleScope;
  readonly content: string;
  readonly version: string;
  readonly updatedAt: string | undefined;
};

export async function fetchCollaborationRules(scope: CollaborationRuleScope): Promise<CollaborationRulesDocument> {
  const query = new URLSearchParams();
  if (scope.kind !== "global") {
    query.set("scopeKind", scope.kind);
    query.set("scopeId", scope.id);
  }
  const suffix = query.size === 0 ? "" : `?${query}`;
  const response = await fetch(`/api/collaboration-rules${suffix}`, { method: "GET" });
  await assertResponse(response, "无法读取协作规则");
  return (await response.json() as { readonly document: CollaborationRulesDocument }).document;
}

export async function saveCollaborationRules(input: {
  readonly scope: CollaborationRuleScope;
  readonly content: string;
  readonly expectedVersion: string;
}): Promise<CollaborationRulesDocument> {
  return await mutate("PUT", input, "无法保存协作规则");
}

export async function deleteCollaborationRules(input: {
  readonly scope: CollaborationRuleScope;
  readonly expectedVersion: string;
}): Promise<CollaborationRulesDocument> {
  return await mutate("DELETE", input, "无法删除协作规则");
}

async function mutate(method: "PUT" | "DELETE", body: Record<string, unknown>, fallback: string): Promise<CollaborationRulesDocument> {
  const response = await fetch("/api/collaboration-rules", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await assertResponse(response, fallback);
  return (await response.json() as { readonly document: CollaborationRulesDocument }).document;
}

async function assertResponse(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  let message = fallback;
  try {
    const payload = await response.json() as { readonly error?: { readonly message?: unknown } };
    if (typeof payload.error?.message === "string" && payload.error.message.length > 0) message = payload.error.message;
  } catch {
    // Keep the stable panel-facing fallback for non-JSON error responses.
  }
  throw new Error(`${message}（${response.status}）`);
}
