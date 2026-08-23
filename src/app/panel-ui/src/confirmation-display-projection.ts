import { cleanConfirmationSummary } from "../../text-projection/confirmation-copy.js";

export type DisplayableConfirmation = {
  readonly title?: string;
  readonly question?: string;
  readonly actionSummary?: string;
  readonly affectedResources?: readonly string[];
  readonly riskLevel?: string;
  readonly resumeAvailability?: "live" | "lost_after_restart";
};

export type ConfirmationDisplayProjection = {
  readonly title: string;
  readonly actionPreview: string;
  readonly showActionPreview: boolean;
  readonly resources: readonly string[];
  readonly riskLevel: "low" | "medium" | "high";
  readonly resumeLost: boolean;
  readonly resumeLostSummary?: string;
};

export function projectConfirmationDisplay(
  confirmation: DisplayableConfirmation | undefined
): ConfirmationDisplayProjection {
  const action = confirmationAction(confirmation);
  const title = confirmationDisplayTitle(confirmation, action);
  const actionPreview = confirmationActionPreview(action);
  return {
    title,
    actionPreview,
    showActionPreview: actionPreview.length > 0 && !sameDisplayText(actionPreview, title),
    resources: confirmationAffectedResources(confirmation),
    riskLevel: confirmationRiskLevel(confirmation),
    resumeLost: confirmation?.resumeAvailability === "lost_after_restart",
    resumeLostSummary: confirmation?.resumeAvailability === "lost_after_restart"
      ? "这次操作无法原地继续。发送新消息即可基于当前上下文继续。"
      : undefined,
  };
}

function confirmationAction(confirmation: DisplayableConfirmation | undefined): string {
  return cleanConfirmationSummary(confirmation?.actionSummary ?? confirmation?.question ?? "");
}

function confirmationDisplayTitle(
  confirmation: DisplayableConfirmation | undefined,
  action: string
): string {
  const rawTitle = confirmation?.title === undefined ? "" : cleanConfirmationSummary(confirmation.title);
  const title = isGenericConfirmationTitle(rawTitle) ? "" : rawTitle;
  if (title.length > 0) return title;
  if (action.length > 0) return action;
  return "";
}

function isGenericConfirmationTitle(value: string): boolean {
  return /^(?:.*确认.*|需要你判断|待处理|运行命令|执行 Shell)$/i.test(value.trim());
}

function confirmationActionPreview(action: string): string {
  return action
    .replace(/^(?:执行\s*Shell|Shell\s*命令|运行\s*命令|执行\s*命令|命令)[:：]?\s*/i, "")
    .replace(/^command[:：]?\s*/i, "")
    .trim() || action;
}

function confirmationRiskLevel(
  confirmation: DisplayableConfirmation | undefined
): ConfirmationDisplayProjection["riskLevel"] {
  return confirmation?.riskLevel === "low" ||
    confirmation?.riskLevel === "medium" ||
    confirmation?.riskLevel === "high"
    ? confirmation.riskLevel
    : "medium";
}

function confirmationAffectedResources(
  confirmation: DisplayableConfirmation | undefined
): readonly string[] {
  return confirmation?.affectedResources
    ?.filter((resource) => !isInternalReference(resource))
    .slice(0, 6) ?? [];
}

function isInternalReference(value: string): boolean {
  return /^(?:tool|tool_call|trace|model|model_call|event|confirmation|goal):/i.test(value.trim()) ||
    /\bcall[_:A-Za-z0-9-]{8,}\b/.test(value);
}

function sameDisplayText(left: string, right: string): boolean {
  return normalizeDisplayText(left) === normalizeDisplayText(right);
}

function normalizeDisplayText(value: string): string {
  return value
    .replace(/[。.!！?？；;:：、，,\s]/g, "")
    .trim();
}