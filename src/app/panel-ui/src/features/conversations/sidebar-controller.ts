import type React from "react";
import {
  type ConversationManagementResponse,
  isMissingConversationError,
  removeConversation,
  renameConversationTitle,
  updateConversationPinnedState,
  upsertConversationSummary,
} from "./conversation-management";
import type { AppState } from "../../workbench/state";
import type { ContextAttachment } from "../../contracts/context";

export type AppSidebarConversationController = {
  readonly renameConversation: (conversationId: string, title: string) => Promise<void>;
  readonly toggleConversationPinned: (conversationId: string, pinned: boolean) => Promise<void>;
  readonly deleteConversation: (conversationId: string) => Promise<void>;
};

export type AppSidebarConversationControllerOptions = {
  readonly app: AppState;
  readonly appRef: React.MutableRefObject<AppState>;
  readonly setApp: React.Dispatch<React.SetStateAction<AppState>>;
  readonly mountedRef: React.MutableRefObject<boolean>;
  readonly mutationConversationIdsRef: React.MutableRefObject<Set<string>>;
  readonly setMutationConversationIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  readonly resetChat: () => void;
  readonly setInputCloseSignal: React.Dispatch<React.SetStateAction<number>>;
  readonly setGoal: React.Dispatch<React.SetStateAction<string>>;
  readonly setAttachments: React.Dispatch<React.SetStateAction<readonly ContextAttachment[]>>;
  /** Owner 为空间的会话控制变更成功后刷新对应空间 read-model；失败静默。 */
  readonly refreshSpaceConversations?: (spaceId: string) => void | Promise<void>;
};

export function createAppSidebarConversationController(
  options: AppSidebarConversationControllerOptions,
): AppSidebarConversationController {
  async function renameConversation(conversationId: string, title: string): Promise<void> {
    const spaceId = spaceIdOfConversation(options.appRef.current, conversationId);
    await runConversationMutation(conversationId, async () => {
      const response = await renameConversationTitle(conversationId, title);
      if (!options.mountedRef.current) return;
      applyConversationManagementResponse(response);
      notifySpaceConversationChange(spaceId, options.refreshSpaceConversations);
    }, "重命名会话失败。");
  }

  async function toggleConversationPinned(conversationId: string, pinned: boolean): Promise<void> {
    const previousPinnedAt = conversationPinnedAt(options.appRef.current, conversationId);
    const optimisticPinnedAt = pinned ? new Date().toISOString() : undefined;
    const spaceId = spaceIdOfConversation(options.appRef.current, conversationId);
    await runConversationMutation(conversationId, async () => {
      options.setApp((previous) => patchConversationPinnedAt(previous, conversationId, optimisticPinnedAt));
      const response = await updateConversationPinnedState(conversationId, pinned);
      if (!options.mountedRef.current) return;
      applyConversationManagementResponse(response);
      notifySpaceConversationChange(spaceId, options.refreshSpaceConversations);
    }, "更新会话置顶失败。", (previous) => patchConversationPinnedAt(previous, conversationId, previousPinnedAt));
  }

  async function deleteConversation(conversationId: string): Promise<void> {
    const spaceId = spaceIdOfConversation(options.appRef.current, conversationId);
    await runConversationMutation(conversationId, async () => {
      const response = await removeConversation(conversationId);
      if (!options.mountedRef.current) return;
      if (options.appRef.current.conversation?.conversationId === conversationId) {
        options.resetChat();
      }
      options.setApp((previous) => ({
        ...previous,
        conversations: (response.conversations ?? previous.conversations).filter((item) => item.conversationId !== conversationId),
        error: undefined,
      }));
      notifySpaceConversationChange(spaceId, options.refreshSpaceConversations);
    }, "删除会话失败。", undefined, (error) => {
      if (isMissingConversationError(error)) {
        if (options.appRef.current.conversation?.conversationId === conversationId) {
          options.resetChat();
        }
        options.setApp((previous) => ({
          ...previous,
          conversations: previous.conversations.filter((item) => item.conversationId !== conversationId),
          error: undefined,
        }));
        return true;
      }
      return false;
    });
  }

  function applyConversationManagementResponse(response: ConversationManagementResponse): void {
    options.setApp((previous) => ({
      ...previous,
      conversations: response.conversations ?? upsertConversationSummary(previous.conversations, response.conversation),
      conversation:
        previous.conversation?.conversationId === response.conversation.conversationId
          ? response.conversation
          : previous.conversation,
      error: undefined,
    }));
  }

  async function runConversationMutation(
    conversationId: string,
    operation: () => Promise<void>,
    fallbackError: string,
    rollback?: (previous: AppState) => AppState,
    recover?: (error: unknown) => boolean,
  ): Promise<void> {
    if (options.mutationConversationIdsRef.current.has(conversationId)) return;
    setConversationMutation(conversationId, true);
    try {
      await operation();
    } catch (error: unknown) {
      if (!options.mountedRef.current || recover?.(error) === true) return;
      options.setApp((previous) => ({
        ...(rollback?.(previous) ?? previous),
        error: errorText(error, fallbackError),
      }));
    } finally {
      if (options.mountedRef.current) setConversationMutation(conversationId, false);
    }
  }

  function setConversationMutation(conversationId: string, pending: boolean): void {
    const next = new Set(options.mutationConversationIdsRef.current);
    if (pending) {
      next.add(conversationId);
    } else {
      next.delete(conversationId);
    }
    options.mutationConversationIdsRef.current = next;
    options.setMutationConversationIds(next);
  }

  return {
    renameConversation,
    toggleConversationPinned,
    deleteConversation,
  };
}

function conversationPinnedAt(app: AppState, conversationId: string): string | undefined {
  return app.conversation?.conversationId === conversationId
    ? app.conversation.pinnedAt
    : app.conversations.find((conversation) => conversation.conversationId === conversationId)?.pinnedAt;
}

/** 会话所属空间 id；非 Space owner 返回 undefined。 */
function spaceIdOfConversation(app: AppState, conversationId: string): string | undefined {
  const owner = app.conversation?.conversationId === conversationId
    ? app.conversation.owner
    : app.conversations.find((conversation) => conversation.conversationId === conversationId)?.owner;
  return owner?.kind === "space" ? owner.id : undefined;
}

function notifySpaceConversationChange(
  spaceId: string | undefined,
  refreshSpaceConversations: ((spaceId: string) => void | Promise<void>) | undefined,
): void {
  if (spaceId === undefined || refreshSpaceConversations === undefined) return;
  void Promise.resolve(refreshSpaceConversations(spaceId)).catch(() => undefined);
}

function patchConversationPinnedAt(
  app: AppState,
  conversationId: string,
  pinnedAt: string | undefined,
): AppState {
  return {
    ...app,
    conversations: app.conversations.map((conversation) =>
      conversation.conversationId === conversationId
        ? { ...conversation, pinnedAt }
        : conversation
    ),
    conversation: app.conversation?.conversationId === conversationId
      ? { ...app.conversation, pinnedAt }
      : app.conversation,
  };
}


function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
