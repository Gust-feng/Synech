import { useEffect, useRef } from "react";
import type React from "react";
import { getJson } from "./api";
import type { AppState } from "./app-state";
import type { ConversationSummary } from "./contracts/conversation";
export {
  conversationSummariesNeedRefresh,
  conversationSummaryNeedsRefresh,
} from "./conversation-refresh-policy";
import { conversationSummariesNeedRefresh } from "./conversation-refresh-policy";

export const CONVERSATION_SUMMARY_REFRESH_INTERVAL_MS = 2_500;

export function useConversationSummaryRefresh(input: {
  readonly conversations: readonly ConversationSummary[];
  readonly setApp: React.Dispatch<React.SetStateAction<AppState>>;
  readonly mountedRef: React.MutableRefObject<boolean>;
  readonly intervalMs?: number;
}): void {
  const inFlightRef = useRef(false);
  const shouldRefresh = conversationSummariesNeedRefresh(input.conversations);

  useEffect(() => {
    if (!shouldRefresh) return;

    let stopped = false;
    const intervalMs = input.intervalMs ?? CONVERSATION_SUMMARY_REFRESH_INTERVAL_MS;
    const refresh = async (): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const response = await getJson<{ readonly conversations: readonly ConversationSummary[] }>("/api/conversations");
        if (!stopped && input.mountedRef.current) {
          input.setApp((previous) => ({
            ...previous,
            conversations: response.conversations ?? [],
          }));
        }
      } catch {
        // Background task freshness must not interrupt the current work session.
      } finally {
        inFlightRef.current = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [input.intervalMs, input.mountedRef, input.setApp, shouldRefresh]);
}