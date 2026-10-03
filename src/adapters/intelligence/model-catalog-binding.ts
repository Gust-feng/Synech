import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ConfiguredModelProtocolKind, ModelConfiguration } from "../../domain/config/index.js";
import {
  resolveDiscoveredModel,
  type DiscoveredModelLookup,
  type DiscoveredModelResolution,
  type KnownPiModel,
} from "./pi-model-facts.js";

export type ConfiguredModelLookup = DiscoveredModelLookup & {
  readonly protocolKind?: ConfiguredModelProtocolKind;
};

/** Resolve automatic defaults without changing the gateway's actual request ID. */
export function resolveConfiguredModel(input: ConfiguredModelLookup): DiscoveredModelResolution {
  if (input.protocolKind === "native") return resolveDiscoveredModel(input);
  if (input.piProviderId?.trim()) return resolveDiscoveredModel(input);
  const modelId = input.modelId?.trim() ?? "";
  if (modelId.length === 0) return { status: "unknown", modelId };
  const exact = resolveCandidates(modelId);
  if (exact.length > 0) return selectCandidate(exact, modelId);
  // Preserve namespaces inside catalog IDs: remove gateway prefixes from the
  // left, checking the longest remaining exact ID first. Never strip variants.
  for (let separator = modelId.indexOf("/"); separator >= 0; separator = modelId.indexOf("/", separator + 1)) {
    const candidates = resolveCandidates(modelId.slice(separator + 1));
    if (candidates.length > 0) return selectCandidate(candidates, modelId);
  }
  return { status: "unknown", modelId };
}

let catalog: ReturnType<typeof builtinModels> | undefined;
function resolveCandidates(modelId: string): KnownPiModel[] {
  catalog ??= builtinModels();
  return catalog.getProviders().flatMap((provider) => {
    const model = catalog!.getModel(provider.id, modelId);
    return model === undefined ? [] : [{ status: "known" as const, piProviderId: provider.id, modelId, model }];
  });
}

function selectCandidate(candidates: readonly KnownPiModel[], upstreamId: string): DiscoveredModelResolution {
  if (candidates.length === 0) return { status: "unknown", modelId: upstreamId };
  const id = candidates[0]!.modelId;
  const originalProvider = originalVendorProvider(id);
  const original = candidates.find((candidate) => candidate.piProviderId === originalProvider);
  if (original !== undefined) return original;
  const vendorCandidates = candidates.filter((candidate) => id.startsWith(`${candidate.piProviderId}-`));
  const preferred = vendorCandidates.length > 0 ? vendorCandidates : candidates;
  const signatures = new Set(preferred.map(({ model }) => JSON.stringify({
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    inputLimits: model.inputLimits,
    api: model.api,
    compat: model.compat,
  })));
  if (signatures.size !== 1) return { status: "unknown", modelId: upstreamId };
  return [...preferred].sort((left, right) => left.piProviderId.localeCompare(right.piProviderId))[0]!;
}

/** Vendor identity rules only; no model definitions or capability values live here. */
function originalVendorProvider(id: string): string | undefined {
  if (id.startsWith("gpt-") || /^o[1-9](?:-|$)/u.test(id) || id.startsWith("chatgpt-")) return "openai";
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("deepseek-")) return "deepseek";
  if (id.startsWith("kimi-")) return "moonshotai-cn";
  if (id.startsWith("gemini-")) return "google";
  if (id.startsWith("grok-")) return "xai";
  if (id.startsWith("MiniMax-")) return "minimax-cn";
  if (id.startsWith("glm-")) return "zai-coding-cn";
  if (/^qwen[0-9-]/u.test(id)) return "qwen-token-plan-cn";
  return undefined;
}

/** Apply explicit settings to a run-local Model; never mutate Pi's catalog. */
export function configurePiModel(
  model: Model<Api>,
  configuration: ModelConfiguration | undefined,
): Model<Api> {
  const overrides = configuration?.overrides;
  if (overrides === undefined) return model;
  const levels = overrides.thinkingLevels;
  const reasoning = overrides.supportsReasoningOutput ?? ((levels?.length ?? 0) > 0 ? true : model.reasoning);
  const thinkingLevelMap: ThinkingLevelMap | undefined = levels === undefined
    ? model.thinkingLevelMap
    : {
        off: model.thinkingLevelMap?.off,
        ...Object.fromEntries(
          ["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
            level, levels.some((supported) => supported === level)
              ? model.thinkingLevelMap?.[level as typeof levels[number]] ?? level : null,
          ]),
        ),
      };
  return {
    ...model,
    ...(overrides.contextWindowTokens === undefined ? {} : { contextWindow: overrides.contextWindowTokens }),
    ...(overrides.maxOutputTokens === undefined ? {} : { maxTokens: overrides.maxOutputTokens }),
    ...(overrides.supportsVisionInput === undefined ? {} : {
      input: overrides.supportsVisionInput ? ["text", "image"] : ["text"],
    }),
    reasoning,
    thinkingLevelMap: reasoning ? thinkingLevelMap : undefined,
    ...(levels === undefined || model.api !== "openai-completions" ? {} : {
      compat: { ...model.compat, supportsReasoningEffort: levels.length > 0 },
    }),
  };
}
