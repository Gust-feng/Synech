import type { ModelThinkingLevelName } from "./model-facts.js";

/** Operating budget for an unmatched model; never a confirmed Pi fact. */
export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 256_000;

export type ModelCapabilityValues = {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly supportsVisionInput?: boolean;
  readonly supportsReasoningOutput?: boolean;
  readonly thinkingLevels?: readonly Exclude<ModelThinkingLevelName, "off" | "minimal">[];
};

/** User configuration for one upstream ID; automatic catalog values are not copied. */
export type ModelConfiguration = {
  readonly overrides?: ModelCapabilityValues;
};

export type UpdateModelConfigurationInput = {
  readonly profileId: string;
  readonly modelId: string;
  /** Absence resets this model to automatic defaults. */
  readonly settings?: ModelConfiguration;
};

export function modelConfigurationForId(
  settings: Readonly<Record<string, ModelConfiguration>> | undefined,
  modelId: string | undefined,
): ModelConfiguration | undefined {
  return settings !== undefined && modelId !== undefined && Object.hasOwn(settings, modelId)
    ? settings[modelId] : undefined;
}
