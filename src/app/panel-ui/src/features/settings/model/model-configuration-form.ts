import type { ModelCapabilities, ModelConfiguration } from "@panel-api/config";
import { modelContextWindowTokens, modelMaxOutputTokens } from "./capability-display";

export type ModelConfigurationDraft = {
  readonly contextWindowTokens: string;
  readonly maxOutputTokens: string;
  readonly supportsVisionInput?: boolean;
  readonly supportsReasoningOutput?: boolean;
  readonly thinkingLevels?: NonNullable<ModelConfiguration["overrides"]>["thinkingLevels"];
};

export function modelConfigurationDraft(
  settings: ModelConfiguration | undefined,
  inherited?: ModelCapabilities,
): ModelConfigurationDraft {
  return {
    contextWindowTokens: (settings?.overrides?.contextWindowTokens ?? modelContextWindowTokens(inherited))?.toString() ?? "",
    maxOutputTokens: (settings?.overrides?.maxOutputTokens ?? modelMaxOutputTokens(inherited))?.toString() ?? "",
    supportsVisionInput: settings?.overrides?.supportsVisionInput,
    supportsReasoningOutput: settings?.overrides?.supportsReasoningOutput,
    thinkingLevels: settings?.overrides?.thinkingLevels,
  };
}

export function modelConfigurationFromDraft(
  draft: ModelConfigurationDraft,
  inherited?: ModelCapabilities,
): ModelConfiguration | null {
  const overrides: NonNullable<ModelConfiguration["overrides"]> = {
    contextWindowTokens: tokenOverride(draft.contextWindowTokens, "上下文窗口", modelContextWindowTokens(inherited)),
    maxOutputTokens: tokenOverride(draft.maxOutputTokens, "最大输出", modelMaxOutputTokens(inherited)),
    supportsVisionInput: draft.supportsVisionInput,
    supportsReasoningOutput: draft.supportsReasoningOutput,
    thinkingLevels: draft.thinkingLevels,
  };
  const hasOverrides = Object.values(overrides).some((value) => value !== undefined);
  return hasOverrides ? { overrides } : null;
}

function tokenOverride(value: string, label: string, inherited: number | undefined): number | undefined {
  const tokens = optionalTokenLimit(value, label);
  return tokens === inherited ? undefined : tokens;
}

function optionalTokenLimit(value: string, label: string): number | undefined {
  if (value.trim().length === 0) return undefined;
  const tokens = Number(value);
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new Error(`${label}必须是正整数。`);
  }
  return tokens;
}
