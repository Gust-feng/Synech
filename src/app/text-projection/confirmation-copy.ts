import type { ConfirmationDecision } from "../../domain/confirmation/index.js";
import { compactOrdinaryText } from "../tool-projection/safe-projection.js";

export function cleanConfirmationSummary(value: string): string {
  const cleaned = value
    .replace(/^User approval was requested\.?\s*/i, "")
    .replace(/^Approval required\.?\s*/i, "")
    .replace(/^需要确认[:：]?\s*/i, "")
    .replace(/^需要你判断[:：]?\s*/i, "")
    .replace(/^待处理[:：]?\s*/i, "")
    .replace(/请求执行执行操作/g, "请求执行操作")
    .replace(/\btool:call[_:A-Za-z0-9-]+\b/g, "")
    .replace(/[:：]\s*[:：]/g, "：")
    .replace(/^[，,。.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return isGenericConfirmationPrompt(cleaned) ? "" : cleaned;
}

export function isGenericApprovalDecisionText(value: string | undefined): boolean {
  const normalized = normalizedConfirmationPrompt(value ?? "");
  return normalized.length === 0 || GENERIC_APPROVAL_DECISION_TEXT.has(normalized);
}

export function confirmationActionSummaryText(input: {
  readonly question?: string;
  readonly consequence?: string;
  readonly fallback?: string;
}): string {
  const question = cleanConfirmationSummary(input.question ?? "");
  const consequence = cleanConfirmationSummary(input.consequence ?? "");
  if (question.length > 0 && !isGenericConfirmationPrompt(question)) {
    return question;
  }
  if (consequence.length > 0) {
    return consequence;
  }
  if (question.length > 0) {
    return question;
  }
  return cleanConfirmationSummary(input.fallback ?? "") || "等待你判断。";
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
  const normalized = compactOrdinaryText(value, maxLength).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isGenericConfirmationPrompt(value: string): boolean {
  const normalized = normalizedConfirmationPrompt(value);
  return GENERIC_CONFIRMATION_PROMPTS.has(normalized) || GENERIC_APPROVAL_DECISION_TEXT.has(normalized);
}

function normalizedConfirmationPrompt(value: string): string {
  return value
    .replace(/[。.!！?？；;:：、，,\s]/g, "")
    .trim();
}

const GENERIC_CONFIRMATION_PROMPTS = new Set([
  "确认",
  "需要确认",
  "待确认",
  "继续",
  "是否继续",
  "确认继续",
  "确认下一步",
  "等待确认",
  "等待用户确认下一步",
  "需要你判断",
  "等待你判断后继续",
  "等待你判断下一步",
  "等待用户补充要求",
  "需要你补充材料后继续",
  "待处理",
  "等待你判断",
]);

const GENERIC_APPROVAL_DECISION_TEXT = new Set([
  "已继续",
  "已允许",
  "继续处理",
  "继续执行",
  "工作继续推进",
  "用户反馈已收到工作继续推进",
  "用户已批准",
  "已批准",
]);
