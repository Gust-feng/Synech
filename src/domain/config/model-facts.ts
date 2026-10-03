import type { ModelCapabilityValues, ModelConfiguration } from "./model-configuration.js";
import { DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS } from "./model-configuration.js";

/** Pi catalog facts and explicit user configuration remain separate sources. */

/** 产品可服务的 transport；已知模型的 transport 由真实 Pi Model.api 决定。 */
export type ModelTransportKind =
  | "openai_compatible_chat_completions"
  | "openai_responses"
  | "anthropic_messages"
  | "native";

/** Pi 思考档位名；可用档位动态来自真实 Pi Model.thinkingLevelMap。 */
export type ModelThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Pi 已知模型：全部字段都是真实 Pi Model 的运行事实投影。 */
export type ConfirmedModelFacts = {
  readonly status: "confirmed";
  /** 连接上显式声明的 Pi provider id（匹配发生的 provider 作用域）。 */
  readonly piProviderId: string;
  readonly modelId: string;
  /**
   * 真实 Pi Model.api 投影的 transport；已知模型的 transport 由它决定。Pi 声明了
   * 本产品无法服务的 api（如 anthropic-messages）时为 undefined，binding 在构造期
   * 对此显式失败。
   */
  readonly transport: ModelTransportKind | undefined;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsVisionInput: boolean;
  readonly supportsReasoningOutput: boolean;
  /** 真实 Pi Model.thinkingLevelMap 中受支持的档位（不支持条目已剔除）。 */
  readonly thinkingLevels: readonly ModelThinkingLevelName[];
  /** 真实 Pi Model.compat：可发送 strict 工具 schema。 */
  readonly supportsStrictToolSchemas: boolean;
  /** OpenAI 协议特性：仅当连接显式指向 pi 的 openai provider 时成立。 */
  readonly supportsParallelToolCalls: boolean;
};

/** 远程发现但 Pi 不识别的模型：不投影任何能力事实。 */
export type UnconfirmedModelFacts = {
  readonly status: "unconfirmed";
  readonly modelId: string;
};

export type ModelFacts = ConfirmedModelFacts | UnconfirmedModelFacts;

export type ResolvedModelCapabilities = {
  readonly facts: ModelFacts;
  readonly configuration?: ModelConfiguration;
  /** Effective connection transport, independent of the catalog reference. */
  readonly transport?: ModelTransportKind;
};

export function isConfirmedModelFacts(facts: ModelFacts): facts is ConfirmedModelFacts {
  return facts.status === "confirmed";
}

export function resolvedContextWindowTokens(resolved: ResolvedModelCapabilities): number {
  return capabilityValue(resolved, "contextWindowTokens") ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;
}

export function resolvedMaxOutputTokens(resolved: ResolvedModelCapabilities): number | undefined {
  return capabilityValue(resolved, "maxOutputTokens");
}

/** undefined = 视觉输入未确认；调用方按保守策略处理（不发送图片）。 */
export function resolvedSupportsVisionInput(resolved: ResolvedModelCapabilities): boolean | undefined {
  return capabilityValue(resolved, "supportsVisionInput");
}

/**
 * 已确认模型是否接受 effort 档位控制。未确认模型不得据此拒绝请求——那会把
 * 「Synech 不知道」当成「模型不支持」，形成运行阻断。
 */
export function confirmedModelSupportsReasoningEffort(facts: ConfirmedModelFacts): boolean {
  return facts.thinkingLevels.some((level) => level !== "off" && level !== "minimal");
}

export function resolvedSupportsReasoningEffort(resolved: ResolvedModelCapabilities): boolean {
  return (resolvedThinkingLevels(resolved)?.filter((level) => level !== "off" && level !== "minimal").length ?? 0) > 0;
}

export function resolvedThinkingLevels(
  resolved: ResolvedModelCapabilities
): readonly ModelThinkingLevelName[] | undefined {
  const overrides = resolved.configuration?.overrides;
  if (overrides?.supportsReasoningOutput === false) return [];
  if (overrides?.thinkingLevels !== undefined) return overrides.thinkingLevels;
  if (capabilityValue(resolved, "supportsReasoningOutput") === false) return [];
  return resolved.facts.status === "confirmed" ? resolved.facts.thinkingLevels : undefined;
}

export function resolvedSupportsStrictToolSchemas(resolved: ResolvedModelCapabilities): boolean {
  return resolved.facts.status === "confirmed" &&
    (resolved.transport === undefined || resolved.transport === resolved.facts.transport) &&
    resolved.facts.supportsStrictToolSchemas;
}

export function resolvedSupportsParallelToolCalls(resolved: ResolvedModelCapabilities): boolean {
  const transport = resolved.transport ?? (resolved.facts.status === "confirmed" ? resolved.facts.transport : undefined);
  return transport === "openai_responses" || transport === "openai_compatible_chat_completions";
}

function capabilityValue(
  resolved: ResolvedModelCapabilities,
  key: "contextWindowTokens" | "maxOutputTokens",
): number | undefined;
function capabilityValue(
  resolved: ResolvedModelCapabilities,
  key: "supportsVisionInput" | "supportsReasoningOutput",
): boolean | undefined;
function capabilityValue(
  resolved: ResolvedModelCapabilities,
  key: Exclude<keyof ModelCapabilityValues, "thinkingLevels">,
): number | boolean | undefined {
  return resolved.configuration?.overrides?.[key] ??
    (resolved.facts.status === "confirmed" ? resolved.facts[key] : undefined);
}
