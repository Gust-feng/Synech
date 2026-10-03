import {
  builtinModels,
  getBuiltinModelDataGeneratedAt,
} from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelTransportKind } from "../../domain/config/index.js";
import { piModelTransport } from "./pi-model-facts.js";

/** One Pi provider and its factual built-in model projection. */
export type PiProviderModelCatalog = {
  readonly providerId: string;
  readonly providerName: string;
  readonly baseUrl?: string;
  readonly authModes: readonly ("api_key" | "oauth" | "ambient")[];
  readonly models: readonly PiProviderModelCatalogItem[];
};

export type PiProviderModelCatalogItem = {
  readonly modelId: string;
  readonly displayName: string;
  readonly baseUrl: string;
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
        authModes: [
          ...(provider.auth.apiKey === undefined ? [] : ["api_key" as const]),
          ...(provider.auth.oauth === undefined ? [] : ["oauth" as const]),
          ...(["amazon-bedrock", "google-vertex"].includes(provider.id) ? ["ambient" as const] : []),
        ],
        models: projectedModels,
      };
    })
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
}

function projectPiModel(model: Model<Api>): PiProviderModelCatalogItem | undefined {
  const transport = piModelTransport(model.api);
  if (transport === undefined) return undefined;
  return {
    modelId: model.id,
    displayName: model.name,
    baseUrl: model.baseUrl,
    transport,
    contextWindowTokens: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsVisionInput: model.input.includes("image"),
    supportsReasoningOutput: model.reasoning === true,
  };
}
