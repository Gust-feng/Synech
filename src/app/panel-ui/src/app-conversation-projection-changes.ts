import { useEffect, useRef } from "react";
import type React from "react";
import type { SynechProjectionChange } from "../../panel-api-contracts";
import { getJson } from "./api";
import { subscribeSynechProjectionChanges } from "./app-synech-projection-changes";
import { invalidateUsageStatistics } from "./usage-statistics-query";
import type { AppState } from "./app-state";
import type { LiveRunSubscription } from "./app-live-run-updates";
import type { ConversationSummary } from "./contracts/conversation";

export type ConversationProjectionChangeDeps = {
  readonly fetchConversations: () => Promise<readonly ConversationSummary[]>;
  readonly applyConversations: (conversations: readonly ConversationSummary[]) => void;
  readonly openConversationId: () => string | undefined;
  readonly observedRunId: () => string | undefined;
  readonly currentEpoch: () => number;
  readonly startLiveUpdates: (subscription: LiveRunSubscription) => void;
};

/**
 * 外部提交/取消/审批产生的会话变更没有本地 UI 动作可感知。收到 Host 的
 * `conversations` 投影失效后：重读会话列表；若变更命中当前打开的会话且出现
 * 桌面尚未观察的 run，则按 follow-up run 的既有模式接上直播，让正文实时生长，
 * 而不是整体重载（重载会清空已暂存的附件等编辑器状态）。
 */
export async function handleConversationProjectionChange(
  change: SynechProjectionChange,
  deps: ConversationProjectionChangeDeps,
): Promise<void> {
  if (!change.owners.includes("conversations")) return;
  const conversations = await deps.fetchConversations();
  deps.applyConversations(conversations);
  const openId = deps.openConversationId();
  if (openId === undefined) return;
  if (change.conversationIds !== undefined && !change.conversationIds.includes(openId)) return;
  const summary = conversations.find((conversation) => conversation.conversationId === openId);
  const runId = summary?.activeRunId;
  if (runId === undefined || runId === deps.observedRunId()) return;
  deps.startLiveUpdates({ runId, conversationId: openId, epoch: deps.currentEpoch() });
}

export function useConversationProjectionChanges(input: {
  readonly appRef: React.MutableRefObject<AppState>;
  readonly setApp: React.Dispatch<React.SetStateAction<AppState>>;
  readonly mountedRef: React.MutableRefObject<boolean>;
  readonly activeRunIdRef: React.MutableRefObject<string | undefined>;
  readonly viewEpochRef: React.MutableRefObject<number>;
  readonly startLiveUpdates: (subscription: LiveRunSubscription) => void;
}): void {
  // 控制器随渲染重建；订阅只建立一次，经 ref 转发到最新实例。
  const startLiveUpdatesRef = useRef(input.startLiveUpdates);
  startLiveUpdatesRef.current = input.startLiveUpdates;

  useEffect(() => {
    let disposed = false;
    const unsubscribe = subscribeSynechProjectionChanges((change) => {
      void handleConversationProjectionChange(change, {
        fetchConversations: async () => {
          const response = await getJson<{ readonly conversations: readonly ConversationSummary[] }>("/api/conversations");
          return response.conversations ?? [];
        },
        applyConversations: (conversations) => {
          if (disposed || !input.mountedRef.current) return;
          input.setApp((previous) => ({ ...previous, conversations }));
          // 外部 run 同样消耗模型用量，与本地提交后的列表刷新保持同一失效行为。
          invalidateUsageStatistics();
        },
        openConversationId: () =>
          disposed || !input.mountedRef.current ? undefined : input.appRef.current.conversation?.conversationId,
        observedRunId: () => input.activeRunIdRef.current,
        currentEpoch: () => input.viewEpochRef.current,
        startLiveUpdates: (subscription) => startLiveUpdatesRef.current(subscription),
      }).catch(() => {
        // 失效通知只是提示；权威读取失败时等待下一次通知或用户操作兜底。
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [input.activeRunIdRef, input.appRef, input.mountedRef, input.setApp, input.viewEpochRef]);
}
