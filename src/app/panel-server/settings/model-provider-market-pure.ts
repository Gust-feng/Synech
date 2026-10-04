import type { ModelProviderPreset, ModelProviderMarketWarning } from "../../panel-api/config.js";
import {
  listBuiltinModelProviderPresets,
} from "../../../domain/config/index.js";
import type { PiProviderModelCatalog } from "../../../adapters/intelligence/pi-model-catalog.js";

/**
 * Pure model-provider market derivation shared by the Panel server payload and
 * the browser demo: builtin presets composed with brand groups derived from the
 * real Pi provider catalog. No Node dependencies.
 */
export function panelModelProviderPresets(
  piProviders: readonly PiProviderModelCatalog[],
  warnings: ModelProviderMarketWarning[] = [],
): readonly ModelProviderPreset[] {
  const builtin = listBuiltinModelProviderPresets();
  const brands = groupPiProvidersByBrand(piProviders);
  const builtinProviderIds = new Set(
    builtin.map((preset) => preset.piProviderId).filter((id): id is string => id !== undefined),
  );
  const builtinBrands = new Set(
    [...builtinProviderIds].map((id) => brandForPiProvider(id)),
  );
  const presetIds = new Set(builtin.map((preset) => preset.presetId));

  const piOnly = [...brands]
    .sort(compareProviderTiers)
    .flatMap((brand) => brand.providers.flatMap((provider, index): ModelProviderPreset[] => {
      if (builtinProviderIds.has(provider.providerId)) return [];
      const primaryBrandSlot = !builtinBrands.has(brand.brand) && index === 0;
      const preferredId = primaryBrandSlot ? brand.brand : provider.providerId;
      // The MiniMax brand slot already points to CN; its international provider
      // needs a distinct, stable profile identity.
      const presetId = presetIds.has(preferredId) ? `pi-${provider.providerId}` : preferredId;
      presetIds.add(presetId);
      const label = PI_CONNECTION_LABELS[provider.providerId] ??
        (primaryBrandSlot ? PI_BRAND_LABELS[brand.brand] : undefined) ??
        provider.providerName;
      return [{
        presetId,
        label,
        vendor: provider.providerName,
        description: `${label} 连接模板；模型列表由当前连接实际返回。`,
        providerKind: "openai_compatible",
        protocolKind: "native",
        baseUrl: provider.baseUrl ?? "",
        modelsPath: "pi-catalog",
        supportedProtocolKinds: ["native"],
        piProviderId: provider.providerId,
        piProviderIds: [provider.providerId],
        ...servicePresentation(provider),
      }];
    }));

  return [...builtin.flatMap((preset): ModelProviderPreset[] => {
    const provider = piProviders.find((candidate) => candidate.providerId === preset.piProviderId);
    if (provider === undefined) {
      warnings.push({
        code: "model_service_unavailable",
        presetId: preset.presetId,
        message: `${preset.label} 的服务模板当前不可用；已有连接保留，仍可添加自定义服务。`,
      });
      return [];
    }
    return [{
      ...preset,
      protocolKind: "native",
      baseUrl: provider.baseUrl ?? "",
      modelsPath: "pi-catalog",
      supportedProtocolKinds: ["native"],
      piProviderIds: [provider.providerId],
      ...servicePresentation(provider),
    }];
  }), ...piOnly];
}

function servicePresentation(
  provider: PiProviderModelCatalog,
): Pick<ModelProviderPreset, "brandId" | "brandLabel" | "serviceLabel" | "connection" | "supportedAuthModes"> {
  const brandId = brandForPiProvider(provider.providerId);
  const authMode = provider.providerId === "amazon-bedrock"
    ? "ambient" as const
    : provider.providerId === "github-copilot" || provider.authModes.length === 1 && provider.authModes[0] === "oauth"
      ? "oauth" as const
      : "api_key" as const;
  return {
    brandId,
    brandLabel: PI_BRAND_LABELS[brandId] ?? provider.providerName,
    serviceLabel: PI_SERVICE_LABELS[provider.providerId] ?? "API 服务",
    connection: { authMode },
    supportedAuthModes: provider.authModes,
  };
}

/** Directory order groups model vendors before hosted/gateway platforms. */
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
  readonly providers: readonly PiProviderModelCatalog[];
};

/**
 * Display names for the brands where the Pi provider name is an endpoint label
 * ("Moonshot AI CN", "Z.AI Coding CN") rather than the product name.
 */
const PI_BRAND_LABELS: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  google: "Google",
  cloudflare: "Cloudflare",
  opencode: "OpenCode",
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

const PI_SERVICE_LABELS: Readonly<Record<string, string>> = {
  "openai": "官方 API",
  "openai-codex": "ChatGPT 订阅 / Codex",
  "google": "Gemini API",
  "google-vertex": "Vertex AI",
  "azure-openai-responses": "Azure OpenAI",
  "amazon-bedrock": "Bedrock",
  "github-copilot": "Copilot 订阅",
  "cloudflare-ai-gateway": "AI Gateway",
  "cloudflare-workers-ai": "Workers AI",
  "moonshotai-cn": "API（国内）",
  "moonshotai": "API（国际）",
  "kimi-coding": "Kimi Coding",
  "minimax-cn": "API（国内）",
  "minimax": "API（国际）",
  "zai-coding-cn": "Coding（国内）",
  "zai": "Coding（国际）",
  "qwen-token-plan": "Token Plan（国际）",
  "qwen-token-plan-cn": "Token Plan（国内）",
  "qwen-token-plan-individual": "Token Plan（个人）",
  "xiaomi-token-plan-ams": "Token Plan（AMS）",
  "xiaomi-token-plan-cn": "Token Plan（国内）",
  "xiaomi-token-plan-sgp": "Token Plan（SGP）",
  "opencode": "Zen",
  "opencode-go": "Go",
};

const PI_CONNECTION_LABELS: Readonly<Record<string, string>> = {
  "kimi-coding": "Kimi Coding",
  moonshotai: "月之暗面（国际）",
  minimax: "MiniMax（国际）",
  zai: "智谱 AI（国际）",
  "qwen-token-plan": "通义千问 Token Plan",
  "qwen-token-plan-cn": "通义千问 Token Plan（国内）",
  "qwen-token-plan-individual": "通义千问 Token Plan（个人）",
  "xiaomi-token-plan-ams": "小米 Token Plan（AMS）",
  "xiaomi-token-plan-cn": "小米 Token Plan（国内）",
  "xiaomi-token-plan-sgp": "小米 Token Plan（SGP）",
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
  piProviders: readonly PiProviderModelCatalog[],
): readonly PiBrandGroup[] {
  const grouped = new Map<string, PiProviderModelCatalog[]>();
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
