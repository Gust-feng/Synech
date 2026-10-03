export type CollaborationRuleScope =
  | { readonly kind: "global" }
  | { readonly kind: "space"; readonly id: string }
  | { readonly kind: "workspace"; readonly id: string };

/**
 * 规则正文的真实来源。`managed` 是 Product Home 内由 Synech 维护的小文档；
 * `workspace_file` 是工作区根 AGENTS.md，保存创建、清空写空正文。
 */
export type CollaborationRuleSource =
  | { readonly kind: "managed" }
  | { readonly kind: "workspace_file"; readonly path?: string };

export type CollaborationRulesDocument = {
  readonly scope: CollaborationRuleScope;
  readonly content: string;
  readonly version: string;
  readonly updatedAt: string | undefined;
  /** 仅用于既有测试 fixtures；运行响应始终由服务端提供来源。 */
  readonly source?: CollaborationRuleSource;
};

export async function fetchCollaborationRules(scope: CollaborationRuleScope, signal?: AbortSignal): Promise<CollaborationRulesDocument> {
  const query = new URLSearchParams();
  if (scope.kind !== "global") {
    query.set("scopeKind", scope.kind);
    query.set("scopeId", scope.id);
  }
  const suffix = query.size === 0 ? "" : `?${query}`;
  const response = await fetch(`/api/collaboration-rules${suffix}`, { method: "GET", signal });
  await assertResponse(response, "无法读取协作规则");
  return (await response.json() as { readonly document: CollaborationRulesDocument }).document;
}

/**
 * 保存即覆盖当前正文：global/Space 写入 managed 文档，Workspace 写入根 AGENTS.md。
 * 版本冲突返回 409，由调用方保留编辑草稿并反馈，不得覆盖。
 */
export async function saveCollaborationRules(input: {
  readonly scope: CollaborationRuleScope;
  readonly content: string;
  readonly expectedVersion: string;
}): Promise<CollaborationRulesDocument> {
  const response = await fetch("/api/collaboration-rules", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await assertResponse(response, "无法保存协作规则");
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