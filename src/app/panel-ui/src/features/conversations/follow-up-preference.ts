import { readLocalPreference, writeLocalPreference } from "../../shell/local-preferences";
import type { ConversationFollowUpMode } from "../../contracts/composer";

const FOLLOW_UP_MODE_STORAGE_KEY = "conversation.follow-up-mode";

/** Keep follow-ups local by default; guiding is an explicit user action. */
export function getConversationFollowUpMode(): ConversationFollowUpMode {
  return readLocalPreference(FOLLOW_UP_MODE_STORAGE_KEY) === "guide" ? "guide" : "queue";
}

export function saveConversationFollowUpMode(mode: ConversationFollowUpMode): void {
  writeLocalPreference(FOLLOW_UP_MODE_STORAGE_KEY, mode);
}
