import {
  createModelCollectionChannel,
  createModelProviderBinding,
  fetchOpenAICompatibleModelCatalog,
  type ModelCatalogFetchLike,
} from "../../adapters/intelligence/index.js";
import type {
  IntelligenceChannel,
  ModelProviderKind,
  OrdinaryModelPurpose,
} from "../../domain/intelligence/index.js";
import type {
  ModelProviderModelCatalog,
  ProviderProtocolProfileId,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";
import type { ModelRuntimeMode, OrdinaryModelRuntimeMode } from "./contracts.js";

export type ModelRuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type ModelRuntimeModelCatalogFetch = ModelCatalogFetchLike;
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

export type OpenAIModelRuntimeMode = Exclude<OrdinaryModelRuntimeMode, "none">;

export type ResolvedOpenAIModelRuntimeConfig = {
  readonly mode: OpenAIModelRuntimeMode;
  readonly protocol: typeof OPENAI_COMPATIBLE_PROTOCOL | typeof OPENAI_RESPONSES_PROTOCOL;
  readonly providerId: typeof OPENAI_COMPATIBLE_PROVIDER_ID | typeof OPENAI_RESPONSES_PROVIDER_ID;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly requestSettings?: SanitizedModelProviderConfig["openAI"];
  readonly providerProfileId?: ProviderProtocolProfileId;
  readonly enableWebSearch: boolean;
  readonly summaryInput: ModelRuntimeSummaryInput;
};

export type OpenAIAuxiliaryModelChannelInput = {
  readonly resolved: ResolvedOpenAIModelRuntimeConfig;
  readonly profileId: SanitizedModelProviderConfig["profileId"];
  readonly providerKind: ModelProviderKind;
  readonly resolveApiKey: () => Promise<string | undefined>;
  readonly supportsVisionInput: boolean;
  readonly supportsReasoningOutput: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  /** Purposes allowed for this auxiliary Ordinary model channel. */
  readonly supportedPurposes: readonly OrdinaryModelPurpose[];
};

/** Builds a no-tool Pi-backed channel behind the neutral model capability boundary. */
export function createOpenAIAuxiliaryModelChannel(
  input: OpenAIAuxiliaryModelChannelInput,
): IntelligenceChannel {
  const binding = createModelProviderBinding({
    protocol: input.resolved.protocol,
    baseUrl: input.resolved.baseUrl,
    model: input.resolved.model,
    profileId: input.profileId,
    apiKey: input.resolved.apiKey,
    resolveApiKey: input.resolveApiKey,
    providerProfileId: input.resolved.providerProfileId,
    requestSettings: input.resolved.requestSettings,
    enableWebSearch: input.resolved.enableWebSearch,
    supportsVisionInput: input.supportsVisionInput,
    supportsReasoningOutput: input.supportsReasoningOutput,
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
  });
  return createModelCollectionChannel({
    modelRegistry: binding.modelRegistry,
    selectedModel: binding.selectedModel,
    transformProviderPayload: binding.transformProviderPayload,
    providerKind: input.providerKind,
    thinkingLevel: "off",
    supportedPurposes: input.supportedPurposes,
  });
}

/** Shared OpenAI connection resolution for both IntelligenceChannel and AgentLoop factories. */
export function resolveOpenAIModelRuntimeConfig(input: {
  readonly mode: OpenAIModelRuntimeMode;
  readonly env: ModelRuntimeEnvironment;
  readonly modelProvider?: Pick<SanitizedModelProviderConfig, "profileId" | "baseUrl" | "model" | "openAI">;
}): ResolvedOpenAIModelRuntimeConfig {
  const apiKey = firstNonBlank(input.env.SYNECH_MODEL_API_KEY, input.env.OPENAI_API_KEY);
  const model = firstNonBlank(input.modelProvider?.model, input.env.SYNECH_MODEL_NAME);
  const baseUrl =
    firstNonBlank(input.modelProvider?.baseUrl, input.env.SYNECH_MODEL_BASE_URL) ??
    OPENAI_COMPATIBLE_DEFAULT_BASE_URL;
  const responses = input.mode === "openai-responses";
  const providerId = responses ? OPENAI_RESPONSES_PROVIDER_ID : OPENAI_COMPATIBLE_PROVIDER_ID;
  const protocol = responses ? OPENAI_RESPONSES_PROTOCOL : OPENAI_COMPATIBLE_PROTOCOL;
  const summaryInput: ModelRuntimeSummaryInput = {
    enabled: true,
    mode: input.mode,
    providerId,
    providerKind: "openai_compatible",
    protocolKind: protocol,
    model,
  };

  if (apiKey === undefined) {
    throw new ModelRuntimeConfigurationError({
      code: "missing_api_key",
      message:
        `--ai ${input.mode} requires SYNECH_MODEL_API_KEY or OPENAI_API_KEY; no network request was attempted.`,
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
    protocol,
    providerId,
    baseUrl,
    apiKey,
    model,
    requestSettings: input.modelProvider?.openAI,
    providerProfileId: providerProfileIdFromConfig(input.modelProvider?.profileId),
    enableWebSearch: enabledFlag(input.env.SYNECH_MODEL_BUILTIN_WEB_SEARCH),
    summaryInput,
  };
}

export async function fetchModelRuntimeModelCatalog(input: {
  readonly profile: Pick<SanitizedModelProviderConfig, "profileId" | "label" | "baseUrl" | "providerKind" | "protocolKind">;
  readonly apiKey: string;
  readonly fetch?: ModelRuntimeModelCatalogFetch;
  readonly abortSignal?: AbortSignal;
}): Promise<ModelProviderModelCatalog> {
  return fetchOpenAICompatibleModelCatalog(input);
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

function providerProfileIdFromConfig(value: string | undefined): ProviderProtocolProfileId | undefined {
  if (
    value === "openai" ||
    value === "deepseek" ||
    value === "moonshot" ||
    value === "glm" ||
    value === "minimax" ||
    value === "openai_compatible"
  ) {
    return value;
  }
  return undefined;
}
