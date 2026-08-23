import type {
  ConfiguredModelProviderKind,
  ConfiguredModelProtocolKind,
  ConfiguredModelRuntimeMode,
} from "../../domain/config/index.js";
import { ConfigSchemaValidationError, optionalString } from "./settings-utils.js";

export const DEFAULT_MODEL_PROVIDER_BASE_URL = "https://api.openai.com/v1";
export const MODEL_PROVIDER_SECRET_REF = "secret://local-dev/model-provider/default/api-key";
export const DEFAULT_MODEL_PROFILE_ID = "default";

export function normalizeOptionalString(value: string | undefined): string | undefined {
  return optionalString(value);
}

export function normalizeBaseUrl(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    return undefined;
  }
  return normalized.replace(/\/+$/, "");
}

export function normalizeAiMode(value: ConfiguredModelRuntimeMode | undefined): ConfiguredModelRuntimeMode | undefined {
  return value === "none" || value === "openai-compatible" || value === "openai-responses" ? value : undefined;
}

export function normalizeModelProviderKind(value: ConfiguredModelProviderKind | undefined): ConfiguredModelProviderKind | undefined {
  return value === "openai_compatible" ? value : undefined;
}

export function normalizeModelProtocolKind(
  value: ConfiguredModelProtocolKind | undefined
): ConfiguredModelProtocolKind | undefined {
  if (
    value === "openai_responses" ||
    value === "openai_compatible_chat_completions"
  ) {
    return value;
  }
  return "openai_compatible_chat_completions";
}

export function normalizeProfileId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (normalized.length === 0) {
    throw new ConfigSchemaValidationError("Profile id must contain letters, numbers, underscore, or dash.");
  }
  return normalized;
}

export function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}
