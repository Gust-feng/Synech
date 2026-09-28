import type {
  ResolvedModelCapabilities,
  RunCapabilityPlan,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";
import {
  resolveProtocolToolCallCapabilities,
  supportsProtocolToolCalling,
} from "./protocol-capabilities.js";

export {
  resolveModelCapabilities,
} from "./model-capability-resolution.js";

export {
  resolveProtocolToolCallCapabilities,
  supportsProtocolToolCalling,
};

/**
 * 冻结一次 run 的能力计划。
 *
 * 工具调用能力只按协议层事实推导（模型层不再持有第二份工具调用事实，也不为
 * 未知模型编造「不支持工具」）。
 */
export function createRunCapabilityPlan(input: {
  readonly profile: SanitizedModelProviderConfig;
  readonly modelCapabilities: ResolvedModelCapabilities;
}): RunCapabilityPlan {
  const protocolToolCallCapabilities = resolveProtocolToolCallCapabilities(input.profile.protocolKind);
  const canExposeModelTools = supportsProtocolToolCalling(protocolToolCallCapabilities);
  return {
    protocolToolCallCapabilities,
    modelCapabilities: input.modelCapabilities,
    canExposeModelTools,
  };
}
