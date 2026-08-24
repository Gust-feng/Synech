/**
 * 统一运行作用域。
 *
 * Conversation owner 是 Conversation 创建时冻结的唯一归属事实；Run 出生前由 Host
 * 根据 owner 解析 ConversationExecutionScope，同一份 scope 被 Pi 执行环境、文件工具、
 * Shell、Notes、Skills、Sub-Agent roots、后台进程和 Panel 投影一致消费。
 *
 * 任何模块不得重新从全局配置猜测 cwd 或 owner。
 */

/** Conversation 的单一 owner，创建时必选且只能选一个，创建后不可切换。 */
export type ConversationOwner =
  | { readonly kind: "space"; readonly id: string }
  | { readonly kind: "workspace"; readonly id: string };

/**
 * Run 级确认模式。
 *
 * "confirm_each" 与中性工具层的 ToolConfirmationPolicy("prompt") 对应，每轮执行前
 * 通过 ToolCenter 取得用户确认；"full_access" 是 Run 级冻结模式，同时覆盖 Shell
 * 确认和文件工具路径集合限制，但仍受明确删除/撤权 deny 约束。
 */
export type ConfirmationPolicy = "confirm_each" | "full_access";

/** Space 对某个 Workspace 的一次有效引用授权（mountVersion 校验 + linkId 追溯）。 */
export type WorkspaceGrant = {
  readonly workspaceId: string;
  readonly linkId?: string;
  readonly mountVersion: string;
  readonly rootPath: string;
  readonly sourceIdentity: string;
};

/** 用户本轮明确选择的附件授权，随 Run 冻结。 */
export type AttachmentGrant = {
  readonly attachmentId: string;
  readonly kind: "uploaded" | "local_file" | "local_project";
  readonly path: string;
  readonly sourceIdentity?: string;
};

/** Run 出生前由 Host 生成并冻结的统一执行作用域。 */
export type ConversationExecutionScope = {
  readonly owner: ConversationOwner;
  readonly ownerTitle: string;
  /** Workspace owner：当前 mount 根目录；Space owner：managedRoot。 */
  readonly cwd: string;
  /** 仅 Space owner 存在：runtime/synech/space-files/<spaceId>/files。 */
  readonly managedRoot?: string;
  readonly workspaceGrants: readonly WorkspaceGrant[];
  readonly attachmentGrants: readonly AttachmentGrant[];
  readonly confirmationPolicy: ConfirmationPolicy;
};

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

/** Owner 的默认 cwd 解析；缺失时返回 undefined 由 Host 显式失败。 */
export function defaultOwnerCwd(
  owner: ConversationOwner,
  input: {
    readonly workspaceMountRoot?: string;
    readonly spaceManagedRoot?: string;
  },
): string | undefined {
  return owner.kind === "workspace" ? input.workspaceMountRoot : input.spaceManagedRoot;
}
