import { friendlyFailureCopy } from "../../../text-projection/failure-copy.js";

export function sanitizeFailureCopy(value: string): string {
  const text = userVisibleAnswer(value).trim();
  const message = friendlyFailureCopy(text);
  return message.length <= 1_000 ? message : `${message.slice(0, 999)}…`;
}

export function userVisibleAnswer(text: string): string {
  return text;
}

export function normalizeComparableText(value: string): string {
  return userVisibleAnswer(value).replace(/\s+/g, " ").trim();
}
