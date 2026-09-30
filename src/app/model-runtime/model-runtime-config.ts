import type { IntelligenceChannel } from "../../domain/intelligence/index.js";
import type { SanitizedModelProviderConfig } from "../../domain/config/index.js";
import type { ProviderProtocolProfileId } from "../../domain/config/index.js";
import type { ModelRuntimeMode, OrdinaryModelRuntimeMode } from "./contracts.js";

export type ModelRuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type ModelRuntimeChannelFactory = () => IntelligenceChannel;
export type ModelRuntimeSummaryInput = {
  readonly enabled: boolean;
  readonly mode: ModelRuntimeMode;
  readonly providerId?: string;
  readonly providerKind?: string;
  readonly protocolKind?: string;
  readonly model?: string;
  readonly configurationError?: {
    readonly code: string;
    readonly message: string;
  };
};

export type ModelRuntimeConfigurationIssueCode =
  | "ai_disabled"
  | "missing_api_key"
  | "missing_base_url"
  | "missing_model_name"
  | "unsupported_provider_protocol";

export class ModelRuntimeConfigurationError extends Error {
  constructor(
    readonly issue: {
      readonly code: ModelRuntimeConfigurationIssueCode;
      readonly message: string;
      readonly summaryInput: ModelRuntimeSummaryInput;
    }
  ) {
    super(issue.message);
    this.name = "ModelRuntimeConfigurationError";
  }
}

const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible-chat-completions";
const OPENAI_COMPATIBLE_PROTOCOL = "openai_compatible_chat_completions";
const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_RESPONSES_PROVIDER_ID = "openai-responses";
const OPENAI_RESPONSES_PROTOCOL = "openai_responses";
const ANTHROPIC_MESSAGES_PROVIDER_ID = "anthropic-messages";
const ANTHROPIC_MESSAGES_PROTOCOL = "anthropic_messages";

export type ResolvedModelRuntimeMode = Exclude<OrdinaryModelRuntimeMode, "none">;

export type ResolvedModelRuntimeConfig = {
  readonly mode: ResolvedModelRuntimeMode;
  readonly protocol:
    | typeof ANTHROPIC_MESSAGES_PROTOCOL
    | typeof OPENAI_COMPATIBLE_PROTOCOL
    | typeof OPENAI_RESPONSES_PROTOCOL;
  readonly providerId:
    | typeof ANTHROPIC_MESSAGES_PROVIDER_ID
    | typeof OPENAI_COMPATIBLE_PROVIDER_ID
    | typeof OPENAI_RESPONSES_PROVIDER_ID;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly piProviderId?: string;
  readonly requestSettings?: SanitizedModelProviderConfig["openAI"];
  readonly providerProfileId?: ProviderProtocolProfileId;
  readonly enableWebSearch: boolean;
  readonly summaryInput: ModelRuntimeSummaryInput;
};

/** Shared model connection facts used by Host-owned provider adapters. */
export function resolveModelRuntimeConfig(input: {
  readonly mode: ResolvedModelRuntimeMode;
  readonly env: ModelRuntimeEnvironment;
  readonly modelProvider?: Pick<
    SanitizedModelProviderConfig,
    "profileId" | "piProviderId" | "baseUrl" | "model" | "openAI"
  >;
}): ResolvedModelRuntimeConfig {
  const apiKey = firstNonBlank(
    input.env.SYNECH_MODEL_API_KEY,
    input.env.OPENAI_API_KEY,
    input.env.ANTHROPIC_API_KEY,
  );
  const model = firstNonBlank(input.modelProvider?.model, input.env.SYNECH_MODEL_NAME);
  const configuredBaseUrl = firstNonBlank(
    input.modelProvider?.baseUrl,
    input.env.SYNECH_MODEL_BASE_URL,
  );
  const transport = transportFactsForMode(input.mode);
  const baseUrl = configuredBaseUrl ??
    (input.mode === "anthropic-messages"
      ? undefined
      : OPENAI_COMPATIBLE_DEFAULT_BASE_URL);
  const summaryInput: ModelRuntimeSummaryInput = {
    enabled: true,
    mode: input.mode,
    providerId: transport.providerId,
    providerKind: "openai_compatible",
    protocolKind: transport.protocol,
    model,
  };

  if (apiKey === undefined) {
    throw new ModelRuntimeConfigurationError({
      code: "missing_api_key",
      message:
        `--ai ${input.mode} requires SYNECH_MODEL_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY; no network request was attempted.`,
      summaryInput,
    });
  }

  if (baseUrl === undefined) {
    throw new ModelRuntimeConfigurationError({
      code: "missing_base_url",
      message: `--ai ${input.mode} requires a Base URL; no network request was attempted.`,
      summaryInput,
    });
  }

  if (model === undefined) {
    throw new ModelRuntimeConfigurationError({
      code: "missing_model_name",
      message: `--ai ${input.mode} requires SYNECH_MODEL_NAME; no network request was attempted.`,
      summaryInput,
    });
  }

  return {
    mode: input.mode,
    protocol: transport.protocol,
    providerId: transport.providerId,
    baseUrl,
    apiKey,
    model,
    piProviderId: input.modelProvider?.piProviderId,
    requestSettings: input.modelProvider?.openAI,
    providerProfileId: providerProfileIdFromConfig(input.modelProvider?.profileId),
    enableWebSearch: enabledFlag(input.env.SYNECH_MODEL_BUILTIN_WEB_SEARCH),
    summaryInput,
  };
}

function providerProfileIdFromConfig(value: string | undefined): ProviderProtocolProfileId | undefined {
  if (
    value === "openai" ||
    value === "deepseek" ||
    value === "moonshot" ||
    value === "glm" ||
    value === "minimax" ||
    value === "openai_compatible"
  ) return value;
  return undefined;
}

function transportFactsForMode(mode: ResolvedModelRuntimeMode): {
  readonly providerId: ResolvedModelRuntimeConfig["providerId"];
  readonly protocol: ResolvedModelRuntimeConfig["protocol"];
} {
  switch (mode) {
    case "anthropic-messages":
      return {
        providerId: ANTHROPIC_MESSAGES_PROVIDER_ID,
        protocol: ANTHROPIC_MESSAGES_PROTOCOL,
      };
    case "openai-compatible":
      return {
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        protocol: OPENAI_COMPATIBLE_PROTOCOL,
      };
    case "openai-responses":
      return {
        providerId: OPENAI_RESPONSES_PROVIDER_ID,
        protocol: OPENAI_RESPONSES_PROTOCOL,
      };
  }
}

function firstNonBlank(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function enabledFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
