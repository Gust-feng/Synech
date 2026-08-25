import { cleanConfirmationSummary } from "../../../text-projection/confirmation-copy.js";

export type DisplayableConfirmation = {
  readonly title?: string;
  readonly question?: string;
  readonly actionSummary?: string;
  readonly consequence?: string;
  readonly affectedResources?: readonly string[];
  readonly riskLevel?: string;
  readonly resumeAvailability?: "live" | "lost_after_restart";
};

export type ConfirmationDisplayProjection = {
  readonly title: string;
  readonly description?: string;
  readonly resources: readonly string[];
  readonly riskLevel: "low" | "medium" | "high";
  readonly resumeLost: boolean;
  readonly resumeLostSummary?: string;
};

/**
 * Projects already-structured confirmation facts. Presentation copy is never
 * parsed to recover action kind, identity, or resource visibility.
 */
export function projectConfirmationDisplay(
  confirmation: DisplayableConfirmation | undefined,
): ConfirmationDisplayProjection {
  const title = firstNonEmptyConfirmationText(
    confirmation?.title,
    confirmation?.actionSummary,
    confirmation?.question,
  );
  const description = optionalConfirmationText(confirmation?.consequence);
  const resources = confirmation?.affectedResources
    ?.map((resource) => resource.trim())
    .filter((resource) => resource.length > 0)
    .slice(0, 6) ?? [];
  const resumeLost = confirmation?.resumeAvailability === "lost_after_restart";
  return {
    title,
    ...(description === undefined ? {} : { description }),
    resources,
    riskLevel: confirmationRiskLevel(confirmation?.riskLevel),
    resumeLost,
    ...(resumeLost
      ? { resumeLostSummary: "这次操作无法原地继续。发送新消息即可基于当前上下文继续。" }
      : {}),
  };
}

function firstNonEmptyConfirmationText(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const normalized = optionalConfirmationText(value);
    if (normalized !== undefined) return normalized;
  }
  return "";
}

function optionalConfirmationText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = cleanConfirmationSummary(value);
  return normalized.length === 0 ? undefined : normalized;
}

function confirmationRiskLevel(value: string | undefined): ConfirmationDisplayProjection["riskLevel"] {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}
