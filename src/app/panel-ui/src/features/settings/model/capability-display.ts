import type { ModelCapabilities, ModelRunReasoningEffort } from "@panel-api/config";
import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, MODEL_RUN_REASONING_EFFORT_LABELS } from "@panel-api/config";

/** Pi 事实二态：已知（confirmed）与远程发现但 Pi 未识别（unconfirmed）。 */
type ModelFacts = NonNullable<ModelCapabilities["facts"]>;
type ConfirmedModelFacts = Extract<ModelFacts, { readonly status: "confirmed" }>;

/** 档位名取自 Pi 事实投影，产品侧不自行维护档位集合。 */
export type ModelThinkingLevelName = ConfirmedModelFacts["thinkingLevels"][number];

/** 产品五档沿用 Pi 编码，仅显示模型支持的子集。 */
export type RunReasoningEffortLevel = ModelRunReasoningEffort;

const RUN_REASONING_LEVEL_LABELS = MODEL_RUN_REASONING_EFFORT_LABELS;

export const MODEL_REASONING_LEVEL_OPTIONS = (
  Object.keys(RUN_REASONING_LEVEL_LABELS) as RunReasoningEffortLevel[]
).map((value) => ({ value, label: RUN_REASONING_LEVEL_LABELS[value] }));

export function isConfirmedModelFacts(facts: ModelFacts | undefined): facts is ConfirmedModelFacts {
  return facts?.status === "confirmed";
}

/**
 * 上下文口径：用户覆写 > Pi 已确认事实 > 产品默认预算。
 * 覆写是用户配置，不改变 facts 的 confirmed/unconfirmed 身份。
 */
export function modelContextWindowTokens(capabilities: ModelCapabilities | undefined): number | undefined {
  return capabilities?.configuration?.overrides?.contextWindowTokens
    ?? confirmedValue(capabilities, (facts) => facts.contextWindowTokens)
    ?? (capabilities?.facts === undefined ? undefined : DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS);
}

export function modelMaxOutputTokens(capabilities: ModelCapabilities | undefined): number | undefined {
  return capabilities?.configuration?.overrides?.maxOutputTokens
    ?? confirmedValue(capabilities, (facts) => facts.maxOutputTokens);
}

export function modelSupportsVisionInput(capabilities: ModelCapabilities | undefined): boolean | undefined {
  return capabilities?.configuration?.overrides?.supportsVisionInput
    ?? confirmedValue(capabilities, (facts) => facts.supportsVisionInput);
}

export function modelSupportsReasoningOutput(capabilities: ModelCapabilities | undefined): boolean | undefined {
  return capabilities?.configuration?.overrides?.supportsReasoningOutput
    ?? ((capabilities?.configuration?.overrides?.thinkingLevels?.length ?? 0) > 0 ? true : undefined)
    ?? confirmedValue(capabilities, (facts) => facts.supportsReasoningOutput);
}

/** 可用档位来自显式配置或 Pi 事实；未确认且未配置时不推测。 */
export function modelThinkingLevels(capabilities: ModelCapabilities | undefined): readonly ModelThinkingLevelName[] | undefined {
  if (modelSupportsReasoningOutput(capabilities) === false) return [];
  return capabilities?.configuration?.overrides?.thinkingLevels
    ?? confirmedValue(capabilities, (facts) => facts.thinkingLevels);
}

export function modelSupportsReasoningEffort(capabilities: ModelCapabilities | undefined): boolean | undefined {
  const levels = modelThinkingLevels(capabilities);
  return levels === undefined ? undefined : runReasoningEffortOptions(capabilities).length > 0;
}

/** 运行级选项只呈现该模型生效的 Pi 档位名，"off" 用 absence 表达。 */
export function runReasoningEffortOptions(
  capabilities: ModelCapabilities | undefined
): readonly { readonly value: RunReasoningEffortLevel; readonly label: string }[] {
  const levels = modelThinkingLevels(capabilities);
  if (levels === undefined) return [];
  return MODEL_REASONING_LEVEL_OPTIONS.filter((option) => levels.includes(option.value));
}

export function modelCapabilitySummary(capabilities: ModelCapabilities | undefined): string | undefined {
  const contextWindow = formatTokenWindow(modelContextWindowTokens(capabilities));
  const maxOutput = formatTokenWindow(modelMaxOutputTokens(capabilities));
  if (contextWindow === undefined) {
    return maxOutput === undefined ? undefined : `输出 ${maxOutput}`;
  }
  return maxOutput === undefined ? `上下文 ${contextWindow}` : `上下文 ${contextWindow} / 输出 ${maxOutput}`;
}

export function formatTokenWindow(tokens: number | undefined): string | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  if (tokens >= 1_000_000) {
    return `${formatCompactNumber(tokens / 1_000_000)}M`;
  }
  if (tokens >= 1_000) {
    return `${formatCompactNumber(tokens / 1_000)}K`;
  }
  return String(Math.round(tokens));
}

function confirmedValue<T>(
  capabilities: ModelCapabilities | undefined,
  read: (facts: ConfirmedModelFacts) => T
): T | undefined {
  return capabilities?.facts?.status === "confirmed" ? read(capabilities.facts) : undefined;
}

function formatCompactNumber(value: number): string {
  const rounded = value >= 10 ? Math.round(value).toString() : value.toFixed(value >= 1 ? 1 : 2);
  return rounded.replace(/\.0$/u, "");
}
