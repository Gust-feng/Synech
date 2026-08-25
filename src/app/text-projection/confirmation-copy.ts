import type { ConfirmationDecision } from "../../domain/confirmation/index.js";
import { sanitizeAssistantVisibleText } from "./visible-text-safety.js";

export function cleanConfirmationSummary(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function confirmationActionSummaryText(input: {
  readonly question?: string;
  readonly consequence?: string;
  readonly fallback?: string;
}): string {
  const question = cleanConfirmationSummary(input.question ?? "");
  const consequence = cleanConfirmationSummary(input.consequence ?? "");
  return question || consequence || cleanConfirmationSummary(input.fallback ?? "") || "等待你判断。";
}

export function basicConfirmationDecisionSummary(
  decision: Pick<ConfirmationDecision, "decision" | "guidance">
): string {
  if (decision.decision === "approve_once") {
    return "已允许。";
  }
  if (decision.decision === "deny") {
    return "已不执行。";
  }
  const guidance = decision.guidance === undefined ? undefined : compactSafeText(decision.guidance, 240);
  return guidance === undefined || guidance.length === 0
    ? "已补充要求。"
    : guidance;
}

function compactSafeText(value: string, maxLength: number): string {
  const normalized = sanitizeAssistantVisibleText(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
