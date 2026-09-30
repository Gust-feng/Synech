import {
  builtinModels,
  getBuiltinModelDataGeneratedAt,
} from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelTransportKind } from "../../domain/config/index.js";

/** One Pi provider and its factual built-in model projection. */
export type PiProviderModelCatalog = {
  readonly providerId: string;
  readonly providerName: string;
  readonly baseUrl?: string;
  readonly models: readonly PiProviderModelCatalogItem[];
};

export type PiProviderModelCatalogItem = {
  readonly modelId: string;
  readonly displayName: string;
  readonly transport: ModelTransportKind;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsVisionInput: boolean;
  readonly supportsReasoningOutput: boolean;
};

export function getPiModelCatalogGeneratedAt(): string | undefined {
  const generatedAt = getBuiltinModelDataGeneratedAt();
  return generatedAt === undefined ? undefined : new Date(generatedAt).toISOString();
}

/**
 * Projects Pi's real catalog into product-safe provider/model facts.
 *
 * Pi Model objects and provider request details never cross this boundary.
 */
export function listPiProviderCatalog(): readonly PiProviderModelCatalog[] {
  const models = builtinModels();
  return models.getProviders()
    .map((provider) => {
      const projectedModels = models.getModels(provider.id)
        .map(projectPiModel)
        .filter((model): model is PiProviderModelCatalogItem => model !== undefined)
        .sort((left, right) => left.modelId.localeCompare(right.modelId));
      return {
        providerId: provider.id,
        providerName: provider.name,
        ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
        models: projectedModels,
      };
    })
    .filter((provider) => provider.models.length > 0)
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
}

function projectPiModel(model: Model<Api>): PiProviderModelCatalogItem | undefined {
  const transport = modelTransport(model.api);
  if (transport === undefined) return undefined;
  return {
    modelId: model.id,
    displayName: model.name,
    transport,
    contextWindowTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsVisionInput: model.input.includes("image"),
    supportsReasoningOutput: model.reasoning === true,
  };
}

function modelTransport(api: Api): ModelTransportKind | undefined {
  switch (api) {
    case "openai-completions":
      return "openai_compatible_chat_completions";
    case "openai-responses":
      return "openai_responses";
    case "anthropic-messages":
      return "anthropic_messages";
    default:
      return undefined;
  }
}
