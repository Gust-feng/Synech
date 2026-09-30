import {
  listBuiltinModelProviderPresets,
  listBuiltinProviderProtocolProfiles,
  type ConfiguredModelProtocolKind,
  type ModelProviderPreset,
  type ModelProviderModelCatalog,
  type ResolvedModelCapabilities,
  type SanitizedModelProviderConfig,
} from "../../../domain/config/index.js";
import { listPiProviderCatalog } from "../../../adapters/intelligence/index.js";
import type { ModelCapabilityProfile, ProductInfo } from "../../panel-api/config.js";
import type { ToolsResponse } from "../../panel-api/tools.js";
import { readProductPackageVersion } from "../../../platform/product-version.js";
import { PRODUCT_DISPLAY_NAME } from "../../../platform/product-identity.js";
import type { ProductPaths } from "../../../platform/storage/index.js";
import { CapabilityCenter } from "../../capability/capability-center.js";
import { resolveModelCapabilitiesForProfile } from "./model-facts.js";
import { ConfigCenter, ConfigCenterValidationError } from "../../config-center/index.js";
import type { ToolCatalogSnapshot } from "../../tool-center/index.js";
import { PanelHttpError } from "../http-utils.js";
import type { PanelModelCatalogFetch } from "../types.js";

export type PanelConfigRouteRuntime = {
  readonly configCenter: ConfigCenter;
  readonly capabilityCenter: CapabilityCenter;
  readonly managedMcpBinDirectory: string;
  readonly configDirectory: string;
  readonly productPaths: ProductPaths;
  readonly modelCatalogFetch?: PanelModelCatalogFetch;
};

export type PanelToolsConfig = NonNullable<ToolsResponse["tools"]>;

export function modelProviderMarketPayload(): {
  readonly presets: ReturnType<typeof listBuiltinModelProviderPresets>;
  readonly providerProtocolProfiles: ReturnType<typeof listBuiltinProviderProtocolProfiles>;
} {
  return {
    presets: panelModelProviderPresets(),
    providerProtocolProfiles: listBuiltinProviderProtocolProfiles(),
  };
}

function panelModelProviderPresets(): readonly ModelProviderPreset[] {
  const builtin = listBuiltinModelProviderPresets();
  const piProviders = listPiProviderCatalog();

  // One entry per brand. Pi splits several vendors into regional or plan-scoped
  // providers (Moonshot AI / Moonshot AI CN / Kimi For Coding, Xiaomi Token Plan
  // AMS/CN/SGP, Qwen Token Plan variants, MiniMax CN, Z.AI Coding CN, ...).
  // Those are transport endpoints, not products: listing each one turned the
  // provider list into three Moonshots, two identical MiniMax rows and four
  // Xiaomi rows. They stay selectable through the connection's Pi provider
  // field; the list shows the brand once.
  const brands = groupPiProvidersByBrand(piProviders);
  const builtinBrands = new Set(
    builtin.map((preset) => preset.piProviderId).filter((id): id is string => id !== undefined)
      .map((id) => brandForPiProvider(id)),
  );

  const piOnly = brands
    .filter((brand) => !builtinBrands.has(brand.brand))
    .sort(compareProviderTiers)
    .map((brand): ModelProviderPreset => {
      const models = brand.providers.flatMap((provider) => [...provider.models]);
      const protocolKind = defaultProtocolForTransports(models.map((model) => model.transport));
      const primary = brand.providers[0]!;
      return {
        presetId: brand.brand,
        label: PI_BRAND_LABELS[brand.brand] ?? primary.providerName,
        vendor: primary.providerName,
        description: `Pi ${brand.brand} 连接模板；模型列表由当前连接实际返回。`,
        providerKind: "openai_compatible",
        protocolKind,
        baseUrl: primary.baseUrl ?? "",
        modelsPath: "/models",
        supportedProtocolKinds: [...new Set<ConfiguredModelProtocolKind>([
          protocolKind,
          ...models.map((model) => protocolKindForTransport(model.transport)),
        ])],
        piProviderId: primary.providerId,
        piProviderIds: brand.providers.map((provider) => provider.providerId),
      };
    });

  return [
    ...builtin.map((preset) => {
      if (preset.piProviderId === undefined) return preset;
      const brand = brandForPiProvider(preset.piProviderId);
      const providers = brands.find((item) => item.brand === brand)?.providers ?? [];
      const providerIds = providers.length === 0 ? [preset.piProviderId] : providers.map((p) => p.providerId);
      const models = providers.flatMap((provider) => [...provider.models]);
      if (models.length === 0) return { ...preset, piProviderIds: providerIds };
      return {
        ...preset,
        piProviderIds: providerIds,
      };
    }),
    ...piOnly,
  ];
}

/**
 * Model vendors before aggregation/托管 platforms.
 *
 * The list is one flat list on purpose — the user asked to keep adding a
 * provider a single obvious action — but the order decides what a user reads
 * first, and "a frontier model vendor" and "a gateway that resells other
 * people's models" are different things to be looking for.
 */
const FRONTIER_MODEL_VENDORS: ReadonlySet<string> = new Set([
  "anthropic",
  "qwen",
  "xai",
  "meta",
  "xiaomi",
  "nvidia",
  "ant-ling",
  "google",
  "mistral",
]);

function compareProviderTiers(left: PiBrandGroup, right: PiBrandGroup): number {
  const leftRank = FRONTIER_MODEL_VENDORS.has(left.brand) ? 0 : 1;
  const rightRank = FRONTIER_MODEL_VENDORS.has(right.brand) ? 0 : 1;
  return leftRank === rightRank ? left.brand.localeCompare(right.brand) : leftRank - rightRank;
}

type PiBrandGroup = {
  readonly brand: string;
  readonly providers: readonly import("../../../adapters/intelligence/pi-model-catalog.js").PiProviderModelCatalog[];
};

/**
 * Display names for the brands where the Pi provider name is an endpoint label
 * ("Moonshot AI CN", "Z.AI Coding CN") rather than the product name.
 */
const PI_BRAND_LABELS: Readonly<Record<string, string>> = {
  qwen: "通义千问",
  xiaomi: "小米",
  moonshot: "月之暗面",
  zai: "智谱 AI",
  "github-copilot": "GitHub Copilot",
  huggingface: "Hugging Face",
  "amazon-bedrock": "Amazon Bedrock",
  "azure-openai": "Azure OpenAI",
  "ant-ling": "蚂蚁百灵",
  vercel: "Vercel AI Gateway",
};

/** Maps a Pi provider id onto the brand it belongs to. */
function brandForPiProvider(piProviderId: string): string {
  return PI_PROVIDER_BRAND_ALIASES[piProviderId] ?? piProviderId;
}

const PI_PROVIDER_BRAND_ALIASES: Readonly<Record<string, string>> = {
  "openai-codex": "openai",
  "google-vertex": "google",
  "azure-openai-responses": "azure-openai",
  "moonshotai": "moonshot",
  "moonshotai-cn": "moonshot",
  "kimi-coding": "moonshot",
  "zai": "zai",
  "zai-coding-cn": "zai",
  "minimax": "minimax",
  "minimax-cn": "minimax",
  "qwen-token-plan": "qwen",
  "qwen-token-plan-cn": "qwen",
  "qwen-token-plan-individual": "qwen",
  "xiaomi-token-plan-ams": "xiaomi",
  "xiaomi-token-plan-cn": "xiaomi",
  "xiaomi-token-plan-sgp": "xiaomi",
  "cloudflare-ai-gateway": "cloudflare",
  "cloudflare-workers-ai": "cloudflare",
  "vercel-ai-gateway": "vercel",
  "opencode-go": "opencode",
};

function groupPiProvidersByBrand(
  piProviders: readonly import("../../../adapters/intelligence/pi-model-catalog.js").PiProviderModelCatalog[],
): readonly PiBrandGroup[] {
  const grouped = new Map<string, import("../../../adapters/intelligence/pi-model-catalog.js").PiProviderModelCatalog[]>();
  for (const provider of piProviders) {
    const brand = brandForPiProvider(provider.providerId);
    const list = grouped.get(brand);
    if (list === undefined) grouped.set(brand, [provider]);
    else list.push(provider);
  }
  return [...grouped.entries()]
    .map(([brand, providers]) => ({ brand, providers }))
    .sort((left, right) => left.brand.localeCompare(right.brand));
}

function protocolKindForTransport(
  transport: import("../../../adapters/intelligence/pi-model-catalog.js").PiProviderModelCatalogItem["transport"],
): ConfiguredModelProtocolKind {
  switch (transport) {
    case "anthropic_messages":
      return "anthropic_messages";
    case "openai_responses":
      return "openai_responses";
    case "openai_compatible_chat_completions":
      return "openai_compatible_chat_completions";
  }
}

/**
 * Default protocol for one brand's connection.
 *
 * A single-transport brand keeps its real transport. A multi-transport brand
 * (gateways that re-serve many vendors' models) defaults to OpenAI-compatible
 * chat completions: it is the broadest common denominator, and every confirmed
 * model still overrides it with its own Pi `Model.api` at binding time.
 *
 * Counting the dominant transport was wrong: it classified Fireworks and Vercel
 * AI Gateway as Anthropic Messages because most of their catalogued models
 * happen to speak that protocol, which would then be used for any model the
 * gateway lists but Pi does not know.
 */
function defaultProtocolForTransports(
  transports: readonly import("../../../adapters/intelligence/pi-model-catalog.js").PiProviderModelCatalogItem["transport"][],
): ConfiguredModelProtocolKind {
  const distinct = new Set(transports);
  return distinct.size === 1
    ? protocolKindForTransport([...distinct][0]!)
    : "openai_compatible_chat_completions";
}

export function productInfoPayload(runtime: PanelConfigRouteRuntime): ProductInfo {
  return {
    name: PRODUCT_DISPLAY_NAME,
    version: readProductPackageVersion(),
    defaultEntry: "Workbench",
    configDirectory: runtime.configDirectory,
    productHome: runtime.productPaths.productHome,
  };
}

export async function modelCapabilitiesPayload(runtime: PanelConfigRouteRuntime): Promise<{
  readonly activeModel: SanitizedModelProviderConfig;
  readonly modelCapabilities: ResolvedModelCapabilities;
  readonly warnings: readonly string[];
}> {
  const activeModel = await runtime.configCenter.getModelProviderConfig();
  return {
    activeModel,
    modelCapabilities: resolveModelCapabilitiesForProfile({ profile: activeModel }),
    warnings: modelCapabilityWarnings(activeModel),
  };
}

export async function modelCapabilityProfilesPayload(
  runtime: PanelConfigRouteRuntime,
  options: { readonly extraCatalog?: ModelProviderModelCatalog } = {},
): Promise<readonly ModelCapabilityProfile[]> {
  const [profiles, savedCatalogs] = await Promise.all([
    runtime.configCenter.listModelProviderProfiles(),
    runtime.configCenter.listModelProviderModelCatalogs(),
  ]);
  const catalogsByProfileId = new Map<string, ModelProviderModelCatalog>();
  for (const catalog of savedCatalogs) {
    if (catalog.modelsPath === "pi-catalog") continue;
    catalogsByProfileId.set(catalog.profileId, catalog);
  }
  if (options.extraCatalog !== undefined) {
    catalogsByProfileId.set(options.extraCatalog.profileId, options.extraCatalog);
  }
  const projections: ModelCapabilityProfile[] = [];
  for (const profile of profiles) {
    for (const model of modelNamesForCapabilityProjection(profile, catalogsByProfileId.get(profile.profileId))) {
      projections.push({
        profileId: profile.profileId,
        providerKind: profile.providerKind,
        protocolKind: profile.protocolKind,
        model,
        capabilities: resolveModelCapabilitiesForProfile({ profile: { ...profile, model } }),
      });
    }
  }
  return projections;
}

export async function readPanelToolCatalog(runtime: PanelConfigRouteRuntime): Promise<ToolCatalogSnapshot> {
  return runtime.capabilityCenter.toolCatalog();
}

export function invalidateCapabilityCache(runtime: PanelConfigRouteRuntime): void {
  runtime.capabilityCenter.invalidate();
}

export function configCenterHttpError(error: unknown): PanelHttpError {
  if (error instanceof PanelHttpError) return error;
  if (error instanceof ConfigCenterValidationError) {
    return new PanelHttpError(400, "invalid_config", error.message);
  }
  throw error;
}

function modelNamesForCapabilityProjection(
  profile: SanitizedModelProviderConfig,
  catalog: ModelProviderModelCatalog | undefined,
): readonly string[] {
  const models = new Set<string>();
  const configuredModel = profile.model?.trim();
  if (configuredModel !== undefined && configuredModel.length > 0) models.add(configuredModel);
  for (const model of catalog?.models ?? []) {
    const id = model.id.trim();
    if (id.length > 0) models.add(id);
  }
  return [...models];
}

function modelCapabilityWarnings(activeModel: SanitizedModelProviderConfig): readonly string[] {
  const warnings: string[] = [];
  if (!activeModel.secretConfigured) warnings.push("当前模型 profile 未配置 API Key。");
  if (activeModel.model === undefined) warnings.push("当前模型 profile 未填写模型名。");
  return warnings;
}
