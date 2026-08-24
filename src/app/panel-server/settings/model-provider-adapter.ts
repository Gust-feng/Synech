import {
  createModelCollectionChannel,
  createModelProviderBinding,
  fetchOpenAICompatibleModelCatalog,
} from "../../../adapters/intelligence/index.js";
import type {
  IntelligenceChannel,
  ModelProviderKind,
  OrdinaryModelPurpose,
} from "../../../domain/intelligence/index.js";
import type {
  ModelProviderModelCatalog,
  SanitizedModelProviderConfig,
} from "../../../domain/config/index.js";
import type { ResolvedOpenAIModelRuntimeConfig } from "../../model-runtime/openai-runtime-config.js";
import type { PanelModelCatalogFetch } from "../types.js";

export type OpenAIAuxiliaryModelChannelInput = {
  readonly resolved: ResolvedOpenAIModelRuntimeConfig;
  readonly profileId: SanitizedModelProviderConfig["profileId"];
  readonly providerKind: ModelProviderKind;
  readonly resolveApiKey: () => Promise<string | undefined>;
  readonly supportsVisionInput: boolean;
  readonly supportsReasoningOutput: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportedPurposes: readonly OrdinaryModelPurpose[];
};

/** Host-owned construction of the concrete Pi/provider channel. */
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

export async function fetchPanelModelCatalog(input: {
  readonly profile: Pick<SanitizedModelProviderConfig, "profileId" | "label" | "baseUrl">;
  readonly apiKey: string;
  readonly fetch?: PanelModelCatalogFetch;
  readonly abortSignal?: AbortSignal;
}): Promise<ModelProviderModelCatalog> {
  return fetchOpenAICompatibleModelCatalog(input);
}
