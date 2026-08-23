export type RefreshableConversationSummary = {
  readonly status?: string;
  readonly activeRunId?: string;
  readonly queuedRunIds?: readonly string[];
  readonly queuedRunCount?: number;
  readonly requiresUserAction?: boolean;
};

const REFRESHABLE_CONVERSATION_STATUSES = new Set([
  "pending",
  "queued",
  "planning",
  "running",
  "approval_needed",
  "needs_input",
]);

export function conversationSummaryNeedsRefresh(conversation: RefreshableConversationSummary): boolean {
  if (conversation.requiresUserAction === true) return true;
  if (conversation.activeRunId !== undefined) return true;
  if ((conversation.queuedRunCount ?? conversation.queuedRunIds?.length ?? 0) > 0) return true;
  return conversation.status !== undefined && REFRESHABLE_CONVERSATION_STATUSES.has(conversation.status);
}

export function conversationSummariesNeedRefresh(conversations: readonly RefreshableConversationSummary[]): boolean {
  return conversations.some(conversationSummaryNeedsRefresh);
}