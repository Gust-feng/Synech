import type { ActivityItem } from "../transcript/panel-transcript-activity-copy.js";

export function isModelNarrativeActivityItem(item: { readonly tone: string }): boolean {
  return item.tone === "thinking" || item.tone === "narration";
}

export function sameModelNarrativeActivity(
  left: Pick<ActivityItem, "key" | "tone">,
  right: Pick<ActivityItem, "key" | "tone">,
): boolean {
  return isModelNarrativeActivityItem(left) &&
    isModelNarrativeActivityItem(right) &&
    left.key === right.key &&
    left.tone === right.tone;
}

export function mergeModelNarrativeActivityItem(previous: ActivityItem, incoming: ActivityItem): ActivityItem {
  return previous === incoming ? previous : incoming;
}
