import type {
  LocalSettings,
  ModelCapabilities,
  ModelCapabilityOverrideSettings,
  ModelProviderProfileSettings,
} from "../../domain/config/index.js";
import {
  ConfigSchemaValidationError,
  asRecord,
  normalizeRequiredConfigString,
  optionalString,
} from "./settings-utils.js";
import {
  normalizeModelProviderKind,
  normalizeOptionalString,
  normalizePositiveInteger,
  normalizeProfileId,
} from "./model-provider-common.js";

export function parseModelCapabilityOverrides(
  value: unknown,
  updatedAt: string
): LocalSettings["modelCapabilityOverrides"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const overrides: ModelCapabilityOverrideSettings[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const model = optionalString(record.model);
    if (model === undefined) {
      continue;
    }
    const providerKind = optionalModelProviderKind(record.providerKind);
    const profileId = optionalString(record.profileId);
    overrides.push({
      ...(profileId === undefined ? {} : { profileId }),
      ...(providerKind === undefined ? {} : { providerKind }),
      model,
      capabilities: parsePartialCapabilities(asRecord(record.capabilities)),
      updatedAt: optionalString(record.updatedAt) ?? updatedAt,
    });
  }
  return overrides;
}

export function normalizeModelCapabilityOverrides(
  overrides: readonly ModelCapabilityOverrideSettings[],
  now: string
): readonly ModelCapabilityOverrideSettings[] {
  return overrides.map((override) => ({
    ...(override.profileId === undefined ? {} : { profileId: normalizeProfileId(override.profileId) }),
    providerKind: normalizeModelProviderKind(override.providerKind),
    model: normalizeRequiredConfigString(override.model, "model"),
    capabilities: sanitizeCapabilityOverride(override.capabilities),
    updatedAt: normalizeOptionalString(override.updatedAt) ?? now,
  }));
}

export function sanitizeCapabilityOverride(capabilities: Partial<ModelCapabilities>): Partial<ModelCapabilities> {
  return {
    contextWindowTokens: normalizePositiveInteger(capabilities.contextWindowTokens),
    maxOutputTokens: normalizePositiveInteger(capabilities.maxOutputTokens),
    supportsToolCalling: booleanOrUndefined(capabilities.supportsToolCalling),
    supportsParallelToolCalls: booleanOrUndefined(capabilities.supportsParallelToolCalls),
    supportsStructuredOutputs: booleanOrUndefined(capabilities.supportsStructuredOutputs),
    supportsStreaming: booleanOrUndefined(capabilities.supportsStreaming),
    supportsVisionInput: booleanOrUndefined(capabilities.supportsVisionInput),
    supportsReasoningEffort: booleanOrUndefined(capabilities.supportsReasoningEffort),
    supportsReasoningOutput: booleanOrUndefined(capabilities.supportsReasoningOutput),
    preferredApiStyle: normalizePreferredApiStyle(capabilities.preferredApiStyle),
    stability: normalizeModelStability(capabilities.stability),
    lastVerifiedAt: normalizeCapabilityVerifiedAt(capabilities.lastVerifiedAt),
  };
}

function parsePartialCapabilities(record: Record<string, unknown>): NonNullable<LocalSettings["modelCapabilityOverrides"]>[number]["capabilities"] {
  return sanitizeCapabilityOverride({
    contextWindowTokens: positiveIntegerFromUnknown(record.contextWindowTokens),
    maxOutputTokens: positiveIntegerFromUnknown(record.maxOutputTokens),
    supportsToolCalling: booleanFromUnknown(record.supportsToolCalling),
    supportsParallelToolCalls: booleanFromUnknown(record.supportsParallelToolCalls),
    supportsStructuredOutputs: booleanFromUnknown(record.supportsStructuredOutputs),
    supportsStreaming: booleanFromUnknown(record.supportsStreaming),
    supportsVisionInput: booleanFromUnknown(record.supportsVisionInput),
    supportsReasoningEffort: booleanFromUnknown(record.supportsReasoningEffort),
    supportsReasoningOutput: booleanFromUnknown(record.supportsReasoningOutput),
    preferredApiStyle: parsePreferredApiStyle(record.preferredApiStyle),
    stability: parseModelStability(record.stability),
    lastVerifiedAt: optionalString(record.lastVerifiedAt),
  });
}

function normalizePreferredApiStyle(value: ModelCapabilities["preferredApiStyle"] | undefined): ModelCapabilities["preferredApiStyle"] | undefined {
  return value === "chat_completions" ||
    value === "responses" ||
    value === "openai_compatible"
    ? value
    : undefined;
}

function normalizeModelStability(value: ModelCapabilities["stability"] | undefined): ModelCapabilities["stability"] | undefined {
  return value === "stable" || value === "preview" || value === "deprecated" || value === "unknown"
    ? value
    : undefined;
}

function normalizeCapabilityVerifiedAt(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized !== undefined && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(normalized) ? normalized : undefined;
}

function booleanOrUndefined(value: boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function booleanFromUnknown(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalModelProviderKind(value: unknown): ModelProviderProfileSettings["providerKind"] | undefined {
  if (value === undefined) return undefined;
  if (value === "openai_compatible") return value;
  throw new ConfigSchemaValidationError(
    "Invalid settings document: capability override provider kind must be openai_compatible."
  );
}

function parsePreferredApiStyle(
  value: unknown
): NonNullable<LocalSettings["modelCapabilityOverrides"]>[number]["capabilities"]["preferredApiStyle"] {
  if (value === undefined) return undefined;
  if (value === "chat_completions" ||
    value === "responses" ||
    value === "openai_compatible"
  ) {
    return value;
  }
  throw new ConfigSchemaValidationError(
    "Invalid settings document: preferred API style must use an OpenAI protocol."
  );
}

function parseModelStability(
  value: unknown
): NonNullable<LocalSettings["modelCapabilityOverrides"]>[number]["capabilities"]["stability"] {
  return value === "stable" || value === "preview" || value === "deprecated" || value === "unknown"
    ? value
    : undefined;
}

function positiveIntegerFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : undefined;
}
