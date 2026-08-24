import { friendlyFailureCopy } from "../../../text-projection/failure-copy.js";

export function sanitizeFailureCopy(value: string): string {
  const text = userVisibleAnswer(value).trim();
  const message = friendlyFailureCopy(text);
  return message.length <= 1_000 ? message : `${message.slice(0, 999)}…`;
}

export function userVisibleAnswer(text: string): string {
  return stripInternalAssistantText(text);
}

export function normalizeComparableText(value: string): string {
  return userVisibleAnswer(value).replace(/\s+/g, " ").trim();
}

function stripInternalAssistantText(text: string): string {
  return text
    .replace(/<\s*(?:tool_call|function_call|use_tool|internal_action|internal_control|query|arguments)\b[^>]*>[\s\S]*?<\s*\/\s*(?:tool_call|function_call|use_tool|internal_action|internal_control|query|arguments)\s*>/gi, "")
    .replace(/<\s*\/?\s*(?:tool_call|function_call|use_tool|internal_action|internal_control|query|arguments)\b[^>]*>/gi, "");
}
