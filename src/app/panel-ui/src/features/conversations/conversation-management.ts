import { ApiError, deleteJson, postJson } from "../../api";
import type { Conversation, ConversationSummary } from "../../contracts/conversation";

export type ConversationManagementResponse = {
  readonly conversation: Conversation;
  readonly conversations?: readonly ConversationSummary[];
};

export type ConversationDeleteResponse = {
  readonly conversations?: readonly ConversationSummary[];
};

export function renameConversationTitle(
  conversationId: string,
  title: string
): Promise<ConversationManagementResponse> {
  return postJson<ConversationManagementResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/rename`,
    { title }
  );
}

export function updateConversationPinnedState(
  conversationId: string,
  pinned: boolean
): Promise<ConversationManagementResponse> {
  return postJson<ConversationManagementResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/pin`,
    { pinned }
  );
}

export function removeConversation(conversationId: string): Promise<ConversationDeleteResponse> {
  return deleteJson<ConversationDeleteResponse>(`/api/conversations/${encodeURIComponent(conversationId)}`);
}

export function upsertConversationSummary(
  conversations: readonly ConversationSummary[],
  conversation: Conversation
): readonly ConversationSummary[] {
  const summary: ConversationSummary = {
    conversationId: conversation.conversationId,
    owner: conversation.owner,
    spaceId: conversation.spaceId,
    title: conversation.title,
    titleEditedAt: conversation.titleEditedAt,
    activeRunId: conversation.activeRunId,
    latestRunId: conversation.latestRunId,
    workspaceFolder: conversation.workspaceFolder,
    queuedRunIds: conversation.queuedRunIds,
    queuedRunCount: conversation.queuedRunIds?.length,
    pinnedAt: conversation.pinnedAt,
    updatedAt: conversation.updatedAt,
  };
  return conversations.some((item) => item.conversationId === conversation.conversationId)
    ? conversations.map((item) => item.conversationId === conversation.conversationId ? { ...item, ...summary } : item)
    : [summary, ...conversations];
}

export function isMissingConversationError(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 404
    && (error.code === "conversation_not_found" || error.code === "not_found");
}
