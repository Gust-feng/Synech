/**
 * 模型事实二态投影——产品层唯一允许使用的「模型能力事实」契约。
 *
 * - `confirmed`：连接显式声明的 `piProviderId` 在 pi-ai 真实 provider catalog 中
 *   精确命中 modelId。每个字段都是真实 Pi Model 的运行事实投影，Synech 不在这里
 *   自维护任何能力值，也不做模糊匹配。
 * - `unconfirmed`：远程 `/models` 发现、但 Pi 在该 provider 下不识别的模型。
 *   不投影任何能力事实；它仍然使用当前连接的默认 transport 把模型 ID 原样发给
 *   上游，请求是否成功由真实上游决定。
 *
 * 约束：本文件不得出现 pi 类型（pi 事实由 `src/adapters/intelligence` 解析后投影
 * 到这里）；已知/未知二态不得合并为同一伪造事实类型。
 */

/** 产品可服务的 transport；已知模型的 transport 由真实 Pi Model.api 决定。 */
export type ModelTransportKind =
  | "openai_compatible_chat_completions"
  | "openai_responses"
  | "anthropic_messages";

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
};

export function isConfirmedModelFacts(facts: ModelFacts): facts is ConfirmedModelFacts {
  return facts.status === "confirmed";
}

/** @deprecated 覆写层过渡保留；最终口径只读 Pi 已确认事实或未确认。 */
export function resolvedContextWindowTokens(resolved: ResolvedModelCapabilities): number | undefined {
  return confirmedOrUndefined(resolved, (facts) => facts.contextWindowTokens);
}

export function resolvedMaxOutputTokens(resolved: ResolvedModelCapabilities): number | undefined {
  return confirmedOrUndefined(resolved, (facts) => facts.maxOutputTokens);
}

/** undefined = 视觉输入未确认；调用方按保守策略处理（不发送图片）。 */
export function resolvedSupportsVisionInput(resolved: ResolvedModelCapabilities): boolean | undefined {
  return confirmedOrUndefined(resolved, (facts) => facts.supportsVisionInput);
}

/**
 * 已确认模型是否接受 effort 档位控制。未确认模型不得据此拒绝请求——那会把
 * 「Synech 不知道」当成「模型不支持」，形成运行阻断。
 */
export function confirmedModelSupportsReasoningEffort(facts: ConfirmedModelFacts): boolean {
  return facts.thinkingLevels.some((level) => level !== "off");
}

export function resolvedSupportsReasoningEffort(resolved: ResolvedModelCapabilities): boolean {
  return resolved.facts.status === "confirmed" && confirmedModelSupportsReasoningEffort(resolved.facts);
}

export function resolvedThinkingLevels(
  resolved: ResolvedModelCapabilities
): readonly ModelThinkingLevelName[] | undefined {
  return resolved.facts.status === "confirmed" ? resolved.facts.thinkingLevels : undefined;
}

export function resolvedSupportsStrictToolSchemas(resolved: ResolvedModelCapabilities): boolean {
  return resolved.facts.status === "confirmed" && resolved.facts.supportsStrictToolSchemas;
}

export function resolvedSupportsParallelToolCalls(resolved: ResolvedModelCapabilities): boolean {
  return resolved.facts.status === "confirmed" && resolved.facts.supportsParallelToolCalls;
}

function confirmedOrUndefined<T>(
  resolved: ResolvedModelCapabilities,
  read: (facts: ConfirmedModelFacts) => T,
): T | undefined {
  return resolved.facts.status === "confirmed" ? read(resolved.facts) : undefined;
}
