import type {
  ModelCapabilities,
  RunCapabilityPlan,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";
import {
  resolveProtocolToolCallCapabilities,
  supportsProtocolToolCalling,
} from "./protocol-capabilities.js";

export {
  BUILTIN_MODEL_DEFINITIONS,
  CONTEXT_WINDOW_FALLBACK_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  PROTOCOL_BASELINE_MODEL_CAPABILITIES,
  type ModelDefinition,
} from "./model-capability-definitions.js";

export {
  hasModelCapabilityOverride,
  resolveModelCapabilities,
} from "./model-capability-resolution.js";

export {
  resolveProtocolToolCallCapabilities,
  supportsProtocolToolCalling,
};

export function createRunCapabilityPlan(input: {
  readonly profile: SanitizedModelProviderConfig;
  readonly modelCapabilities: ModelCapabilities;
}): RunCapabilityPlan {
  const protocolToolCallCapabilities = resolveProtocolToolCallCapabilities(input.profile.protocolKind);
  const canExposeModelTools = input.modelCapabilities.supportsToolCalling &&
    supportsProtocolToolCalling(protocolToolCallCapabilities);
  return {
    protocolToolCallCapabilities,
    modelCapabilities: input.modelCapabilities,
    canExposeModelTools,
  };
}
