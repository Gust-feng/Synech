import type { ConversationSummary } from "./contracts/conversation";
import { conversationUserActionKind } from "./conversation-state";

/**
 * 侧栏会话行的运行状态标志投影。
 *
 * 只打扰值得打扰的状态：运行/排队中显示循环圆环，等待用户决定显示强调点，
 * 失败显示三角感叹号，正常完成显示安静的小圆点。idle（从未运行）与用户主动
 * 取消不显示任何标志——它们不需要用户注意，保持侧栏安静。
 */
export type ConversationStatusMarker =
  | { readonly kind: "working"; readonly label: string }
  | { readonly kind: "attention"; readonly label: string }
  | { readonly kind: "failed"; readonly label: string }
  | { readonly kind: "done"; readonly label: string };

export function conversationStatusMarker(
  conversation: ConversationSummary,
): ConversationStatusMarker | undefined {
  // 等待用户决定比运行中更紧迫：确认门、等待输入、被阻塞的 run 都要求用户行动。
  if (conversation.status === "approval_needed") {
    return { kind: "attention", label: "需要确认" };
  }
  if (conversationUserActionKind(conversation) !== undefined) {
    return { kind: "attention", label: "需要处理" };
  }
  if ((conversation.queuedRunCount ?? conversation.queuedRunIds?.length ?? 0) > 0) {
    return { kind: "working", label: "排队中" };
  }
  if (conversation.status === "running" || conversation.status === "pending") {
    return { kind: "working", label: "处理中" };
  }
  if (conversation.status === "failed") {
    return { kind: "failed", label: "运行失败" };
  }
  if (conversation.status === "completed") {
    return { kind: "done", label: "已完成" };
  }
  // idle / cancelled / 未知状态：安静，不显示标志。
  return undefined;
}
