/** Conversation 的单一 owner，创建时必选且只能选一个，创建后不可切换。 */
export type ConversationOwner =
  | { readonly kind: "space"; readonly id: string }
  | { readonly kind: "workspace"; readonly id: string };

/** owner 的稳定字符串键，用于对话列表按 owner 分组、去重与 read-model 关联。 */
export function conversationOwnerKey(owner: ConversationOwner): string {
  return `${owner.kind}:${owner.id}`;
}

/** 校验任意输入是否为合法 ConversationOwner；不合法时抛错。 */
export function validateConversationOwner(value: unknown): ConversationOwner {
  if (typeof value !== "object" || value === null) {
    throw new Error("conversation owner must be an object with kind and id");
  }
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;
  if (kind !== "space" && kind !== "workspace") {
    throw new Error(`conversation owner kind must be "space" or "workspace", got ${String(kind)}`);
  }
  const id = candidate.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("conversation owner id must be a non-empty string");
  }
  return { kind, id } as ConversationOwner;
}
