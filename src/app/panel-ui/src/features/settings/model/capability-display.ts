import type { ModelCapabilities } from "@panel-api/config";

/** Pi 事实二态：已知（confirmed）与远程发现但 Pi 未识别（unconfirmed）。 */
type ModelFacts = NonNullable<ModelCapabilities["facts"]>;
type ConfirmedModelFacts = Extract<ModelFacts, { readonly status: "confirmed" }>;

/** 档位名取自 Pi 事实投影，产品侧不自行维护档位集合。 */
export type ModelThinkingLevelName = ConfirmedModelFacts["thinkingLevels"][number];

/** 运行级请求只接受 low / medium / high；选项随所选模型的 Pi 可用档位收敛。 */
export type RunReasoningEffortLevel = "low" | "medium" | "high";

/** 用户对单个 model id 的显式声明白名单；保存只发这些键，不带 Pi 事实。 */
export type ModelCapabilityOverride = NonNullable<ModelCapabilities["override"]>;

const RUN_REASONING_LEVEL_LABELS: Readonly<Record<RunReasoningEffortLevel, string>> = {
  low: "轻量",
  medium: "标准",
  high: "深入",
};

export function isConfirmedModelFacts(facts: ModelFacts | undefined): facts is ConfirmedModelFacts {
  return facts?.status === "confirmed";
}

/**
 * 生效口径：用户覆写 > Pi 已确认事实 > 未确认（undefined，不得猜测）。
 * 未确认模型在这里一律得到 undefined，调用方据此不展示任何能力信息。
 */
export function modelContextWindowTokens(capabilities: ModelCapabilities | undefined): number | undefined {
  return capabilities?.override?.contextWindowTokens ?? confirmedValue(capabilities, (facts) => facts.contextWindowTokens);
}

export function modelMaxOutputTokens(capabilities: ModelCapabilities | undefined): number | undefined {
  return capabilities?.override?.maxOutputTokens ?? confirmedValue(capabilities, (facts) => facts.maxOutputTokens);
}

export function modelSupportsVisionInput(capabilities: ModelCapabilities | undefined): boolean | undefined {
  return capabilities?.override?.supportsVisionInput ?? confirmedValue(capabilities, (facts) => facts.supportsVisionInput);
}

/** Pi 可用档位；未确认模型没有已确认档位，返回 undefined。 */
export function modelThinkingLevels(capabilities: ModelCapabilities | undefined): readonly ModelThinkingLevelName[] | undefined {
  return confirmedValue(capabilities, (facts) => facts.thinkingLevels);
}

export function modelSupportsReasoningEffort(capabilities: ModelCapabilities | undefined): boolean | undefined {
  const override = capabilities?.override?.supportsReasoningEffort;
  if (override !== undefined) return override;
  const levels = modelThinkingLevels(capabilities);
  return levels === undefined ? undefined : levels.some((level) => level !== "off");
}

/** 运行级可选档位：只保留请求词汇表内的档位，且必须出现在该模型的 Pi 可用档位中。 */
export function runReasoningEffortOptions(
  capabilities: ModelCapabilities | undefined
): readonly { readonly value: RunReasoningEffortLevel; readonly label: string }[] {
  const levels = modelThinkingLevels(capabilities);
  if (levels === undefined) return [];
  return (["low", "medium", "high"] as readonly RunReasoningEffortLevel[])
    .filter((level) => levels.includes(level))
    .map((level) => ({ value: level, label: RUN_REASONING_LEVEL_LABELS[level] }));
}

export function modelCapabilitySummary(capabilities: ModelCapabilities | undefined): string | undefined {
  const contextWindow = formatTokenWindow(modelContextWindowTokens(capabilities));
  if (contextWindow === undefined) {
    return undefined;
  }
  const maxOutput = formatTokenWindow(modelMaxOutputTokens(capabilities));
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
