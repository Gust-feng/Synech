import type { IntelligenceChannel } from "../../domain/intelligence/index.js";
import type { ModelConfiguration, ModelProviderConnectionSettings, SanitizedModelProviderConfig } from "../../domain/config/index.js";
import { modelConfigurationForId } from "../../domain/config/index.js";
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
    | typeof OPENAI_RESPONSES_PROTOCOL
    | "native";
  readonly providerId:
    | typeof ANTHROPIC_MESSAGES_PROVIDER_ID
    | typeof OPENAI_COMPATIBLE_PROVIDER_ID
    | typeof OPENAI_RESPONSES_PROVIDER_ID
    | "native";
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly piProviderId?: string;
  readonly connection?: ModelProviderConnectionSettings;
  readonly secretUpdatedAt?: string;
  readonly requestSettings?: SanitizedModelProviderConfig["openAI"];
  readonly modelConfiguration?: ModelConfiguration;
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
    "profileId" | "piProviderId" | "baseUrl" | "model" | "openAI" | "connection" | "modelSettings"
  > & Partial<Pick<SanitizedModelProviderConfig, "secretUpdatedAt">>;
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
  const baseUrl = configuredBaseUrl ?? (input.mode === "native" ? "" :
    input.modelProvider === undefined && input.mode !== "anthropic-messages"
      ? OPENAI_COMPATIBLE_DEFAULT_BASE_URL
      : undefined);
  const summaryInput: ModelRuntimeSummaryInput = {
    enabled: true,
    mode: input.mode,
    providerId: transport.providerId,
    providerKind: "openai_compatible",
    protocolKind: transport.protocol,
    model,
  };

  if (input.mode === "native" && firstNonBlank(input.modelProvider?.piProviderId) === undefined) {
    throw new ModelRuntimeConfigurationError({
      code: "unsupported_provider_protocol",
      message: "Native model connections require a declared service provider; no network request was attempted.",
      summaryInput,
    });
  }

  if (apiKey === undefined && input.mode !== "native") {
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
    apiKey: apiKey ?? "",
    model,
    piProviderId: input.modelProvider?.piProviderId,
    ...(input.modelProvider?.connection === undefined ? {} : { connection: input.modelProvider.connection }),
    ...(input.modelProvider?.secretUpdatedAt === undefined ? {} : { secretUpdatedAt: input.modelProvider.secretUpdatedAt }),
    requestSettings: input.modelProvider?.openAI,
    modelConfiguration: modelConfigurationForId(input.modelProvider?.modelSettings, model),
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
    case "native":
      return { providerId: "native", protocol: "native" };
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
