import type { ConfigResponse, ModelProviderModelCatalog, ToolConfirmationPolicy } from "@panel-api/config";
import type { ModelRunReasoningEffort } from "@panel-api/config";
import type { ToolsResponse } from "@panel-api/tools";
import type { ToolForm } from "./components/types";

export type ComposerReasoningEffort = "" | ModelRunReasoningEffort;
export type ComposerToolConfirmationPolicy = ToolConfirmationPolicy;
export type VisibleAiMode = "none" | "anthropic-messages" | "openai-compatible" | "openai-responses" | "native";

export function webSearchFormFromConfig(config: NonNullable<NonNullable<ToolsResponse["tools"]>["webSearch"]>): ToolForm {
  return {
    provider: config.provider === "none" ? "model_builtin" : (config.provider ?? "tavily"),
    apiKey: "",
    maxResults: String(config.maxResults ?? 5),
    engineId: config.engineId ?? "",
  };
}

export function reconcileWebSearchForm(current: ToolForm, expected: ToolForm | undefined, incoming: ToolForm): ToolForm {
  // A settings response may acknowledge an older save while the user is already editing again.
  if (expected !== undefined && (Object.keys(expected) as (keyof ToolForm)[])
    .some((key) => current[key] !== expected[key])) return current;
  return incoming;
}

export function mergeConfigResponse(previous: ConfigResponse | undefined, incoming: ConfigResponse): ConfigResponse {
  return {
    ...previous,
    ...incoming,
    product: incoming.product ?? previous?.product,
    appearance: incoming.appearance ?? previous?.appearance,
    config: incoming.config ?? incoming.profile ?? previous?.config,
    profiles: incoming.profiles ?? previous?.profiles,
    modelProviderOrder: incoming.modelProviderOrder ?? previous?.modelProviderOrder,
    modelProviderMarket: incoming.modelProviderMarket ?? previous?.modelProviderMarket,
    modelCatalogs: incoming.modelCatalogs ?? previous?.modelCatalogs,
    modelCapabilityProfiles: incoming.modelCapabilityProfiles ?? previous?.modelCapabilityProfiles,
    commandShell: incoming.commandShell ?? previous?.commandShell,
    toolConfirmation: incoming.toolConfirmation ?? previous?.toolConfirmation,
    ordinaryAgent: incoming.ordinaryAgent ?? previous?.ordinaryAgent,
    skillTrigger: incoming.skillTrigger ?? previous?.skillTrigger,
    capabilities: incoming.capabilities ?? previous?.capabilities,
  };
}
export function normalizeVisibleAiMode(mode: VisibleAiMode | undefined): VisibleAiMode {
  return mode === "none" ||
    mode === "anthropic-messages" ||
    mode === "openai-compatible" ||
    mode === "openai-responses" ||
    mode === "native"
    ? mode
    : "openai-compatible";
}

export function normalizeComposerToolConfirmationPolicy(
  policy: ComposerToolConfirmationPolicy | undefined
): ComposerToolConfirmationPolicy {
  return policy === "full_access" ? "full_access" : "prompt";
}

export function visibleConfigLabel(config: NonNullable<ConfigResponse["config"]>): string {
  return config.label ?? "";
}

export function visibleConfigBaseUrl(config: NonNullable<ConfigResponse["config"]>): string {
  const baseUrl = config.baseUrl ?? "";
  if (config.profileId === "default" && (baseUrl.length === 0 || baseUrl === "https://api.openai.com")) {
    return "https://api.openai.com/v1";
  }
  return baseUrl;
}

export function runReasoningSettings(
  reasoningEffort: ComposerReasoningEffort,
  supportsReasoningEffort: boolean
): { readonly reasoningEffort?: Exclude<ComposerReasoningEffort, ""> } {
  if (!supportsReasoningEffort || reasoningEffort.length === 0) {
    return {};
  }
  return { reasoningEffort: reasoningEffort as Exclude<ComposerReasoningEffort, ""> };
}

export function catalogRecordFromList(catalogs: readonly ModelProviderModelCatalog[]): Record<string, ModelProviderModelCatalog> {
  const record: Record<string, ModelProviderModelCatalog> = {};
  for (const catalog of catalogs) {
    if (catalog.profileId.trim().length > 0) {
      record[catalog.profileId] = catalog;
    }
  }
  return record;
}
