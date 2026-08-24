import type {
  ModelCapabilities,
  ModelCapabilityOverrideSettings,
  ProviderProtocolProfileId,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";
import {
  BUILTIN_MODEL_DEFINITIONS,
  MODEL_CAPABILITIES_VERIFIED_AT,
  PROTOCOL_BASELINE_MODEL_CAPABILITIES,
  type ModelDefinition,
} from "./model-capability-definitions.js";
import {
  constrainCapabilitiesToProtocolToolCalling,
  preferredApiStyleForProtocol,
  resolveProtocolToolCallCapabilities,
  supportsProtocolToolCalling,
} from "./protocol-capabilities.js";

export function resolveModelCapabilities(input: {
  readonly profile: SanitizedModelProviderConfig;
  readonly overrides?: readonly ModelCapabilityOverrideSettings[];
}): ModelCapabilities {
  const definition = bestDefinitionFor(input.profile);
  const protocolCapabilities = resolveProtocolToolCallCapabilities(input.profile.protocolKind);
  const base = constrainCapabilitiesToProtocolToolCalling(
    definition === undefined
      ? fallbackCapabilitiesForProfile(input.profile)
      : capabilitiesForDefinition(definition),
    protocolCapabilities,
  );
  const override = bestOverrideFor(input.profile, input.overrides);
  const resolved = override === undefined ? { ...base } : mergeCapabilities(base, override.capabilities);
  return constrainCapabilitiesToProtocolToolCalling(resolved, protocolCapabilities);
}

export function hasModelCapabilityOverride(input: {
  readonly profile: SanitizedModelProviderConfig;
  readonly overrides?: readonly ModelCapabilityOverrideSettings[];
}): boolean {
  return bestOverrideFor(input.profile, input.overrides) !== undefined;
}

function bestDefinitionFor(profile: SanitizedModelProviderConfig): ModelDefinition | undefined {
  const model = (profile.model ?? "").toLowerCase();
  if (model.length === 0) return undefined;
  const providerProfileId = providerProtocolProfileIdFor(profile);
  return BUILTIN_MODEL_DEFINITIONS.find((definition) =>
    definition.providerKind === profile.providerKind &&
    (definition.protocolKind === undefined || definition.protocolKind === profile.protocolKind) &&
    (definition.providerProfileId ?? "openai") === providerProfileId &&
    model.includes(definition.modelPattern.toLowerCase()));
}

function capabilitiesForDefinition(definition: ModelDefinition): ModelCapabilities {
  const protocolProfileId = definition.providerProfileId ?? "openai";
  return {
    ...definition.capabilities,
    imageInput: definition.capabilities.imageInput ?? {
      status: definition.capabilities.supportsVisionInput ? "supported" : "unsupported",
      source: "registry",
      ...(definition.capabilities.lastVerifiedAt === undefined
        ? {}
        : { verifiedAt: definition.capabilities.lastVerifiedAt }),
    },
    protocolProfileId,
    reasoningControl: definition.reasoningControl ?? definition.capabilities.reasoningControl ?? "none",
  };
}

function fallbackCapabilitiesForProfile(profile: SanitizedModelProviderConfig): ModelCapabilities {
  const protocolCapabilities = resolveProtocolToolCallCapabilities(profile.protocolKind);
  return {
    ...PROTOCOL_BASELINE_MODEL_CAPABILITIES,
    protocolProfileId: providerProtocolProfileIdFor(profile),
    preferredApiStyle: preferredApiStyleForProtocol(profile.protocolKind),
    supportsToolCalling: supportsProtocolToolCalling(protocolCapabilities),
    imageInput: {
      status: "unknown",
      source: "protocol_default",
      verifiedAt: MODEL_CAPABILITIES_VERIFIED_AT,
    },
  };
}

function bestOverrideFor(
  profile: SanitizedModelProviderConfig,
  overrides: readonly ModelCapabilityOverrideSettings[] | undefined,
): ModelCapabilityOverrideSettings | undefined {
  if (overrides === undefined || profile.model === undefined) return undefined;
  const model = profile.model.toLowerCase();
  const matchingModel = overrides.filter((item) => item.model.toLowerCase() === model);
  const profileSpecific = matchingModel.find((item) =>
    item.profileId === profile.profileId &&
    (item.providerKind === undefined || item.providerKind === profile.providerKind));
  const providerScoped = matchingModel.find((item) =>
    item.profileId === undefined &&
    (item.providerKind === undefined || item.providerKind === profile.providerKind));
  if (profileSpecific === undefined || providerScoped === undefined) {
    return profileSpecific ?? providerScoped;
  }
  return {
    ...providerScoped,
    ...profileSpecific,
    capabilities: mergePartialCapabilities(providerScoped.capabilities, profileSpecific.capabilities),
  };
}

function providerProtocolProfileIdFor(profile: SanitizedModelProviderConfig): ProviderProtocolProfileId {
  const profileId = (profile.profileId ?? "").toLowerCase();
  const label = (profile.label ?? "").toLowerCase();
  const baseUrl = (profile.baseUrl ?? "").replace(/\/+$/, "").toLowerCase();
  if (baseUrl === "https://api.openai.com" || baseUrl === "https://api.openai.com/v1") return "openai";
  const signals = `${profileId} ${label} ${baseUrl}`;
  if (signals.includes("deepseek")) return "deepseek";
  if (signals.includes("moonshot") || signals.includes("kimi")) return "moonshot";
  if (signals.includes("bigmodel") || signals.includes("z.ai") || signals.includes("zhipu") || signals.includes("glm")) return "glm";
  if (signals.includes("minimax") || signals.includes("minimaxi")) return "minimax";
  if (baseUrl.length === 0 && (profileId === "default" || profileId === "openai")) return "openai";
  return "openai_compatible";
}

function mergeCapabilities(
  base: ModelCapabilities,
  override: Partial<ModelCapabilities>,
): ModelCapabilities {
  const imageInput = override.imageInput ?? (
    override.supportsVisionInput === undefined
      ? base.imageInput
      : { status: override.supportsVisionInput ? "supported" : "unsupported", source: "override" as const }
  );
  return {
    contextWindowTokens: override.contextWindowTokens ?? base.contextWindowTokens,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    supportsToolCalling: override.supportsToolCalling ?? base.supportsToolCalling,
    supportsParallelToolCalls: override.supportsParallelToolCalls ?? base.supportsParallelToolCalls,
    supportsStructuredOutputs: override.supportsStructuredOutputs ?? base.supportsStructuredOutputs,
    supportsStreaming: override.supportsStreaming ?? base.supportsStreaming,
    supportsVisionInput: override.supportsVisionInput ?? base.supportsVisionInput,
    ...(imageInput === undefined ? {} : { imageInput }),
    supportsReasoningEffort: override.supportsReasoningEffort ?? base.supportsReasoningEffort,
    supportsReasoningOutput: override.supportsReasoningOutput ?? base.supportsReasoningOutput,
    preferredApiStyle: override.preferredApiStyle ?? base.preferredApiStyle,
    stability: override.stability ?? base.stability,
    protocolProfileId: override.protocolProfileId ?? base.protocolProfileId,
    reasoningControl: override.reasoningControl ?? base.reasoningControl,
    lastVerifiedAt: override.lastVerifiedAt ?? base.lastVerifiedAt,
  };
}

function mergePartialCapabilities(
  ...capabilities: readonly Partial<ModelCapabilities>[]
): Partial<ModelCapabilities> {
  return Object.assign(
    {},
    ...capabilities.map((item) =>
      Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined))),
  ) as Partial<ModelCapabilities>;
}
