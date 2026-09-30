import {
  UNKNOWN_MODEL_IDENTITY,
  resolveModelFamilyIdentity,
  resolveModelProviderIdentityFromSignal,
  type ModelFamilyIdentity,
  type ModelProviderIdentity,
} from "./model-family";
import { decorativeSvg } from "../../../icon-svg";

export { resolveModelFamilyIdentity };
export type { ModelFamilyIdentity, ModelProviderIdentity };

/**
 * Provider marks are discovered from `assets/providers/<brand>.svg`.
 *
 * Dropping a new SVG into that directory is the whole integration step: the
 * brand slug is the file name, so no registry edit is required. `<brand>.mono.svg`
 * files are the theme-safe fallbacks and are addressed separately.
 */
const providerLogoModules = import.meta.glob("../../../assets/providers/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Readonly<Record<string, string>>;

/** Mark used when a connection has no identifiable brand. */
const FALLBACK_PROVIDER_BRAND = "model-provider";

const providerLogos: Readonly<Record<string, string>> = buildProviderLogos();

export type ModelProviderLogoInput = {
  readonly title?: string;
  readonly vendor?: string;
  readonly profileId?: string;
  readonly presetId?: string;
  /** Pi provider id, when the connection declares one. */
  readonly piProviderId?: string;
  readonly logoDataUrl?: string;
  readonly baseUrl?: string;
  readonly model?: string;
};

export type ModelProviderLogo = {
  readonly svg?: string;
  readonly imageSrc?: string;
  readonly tone: string;
};

/**
 * Brand key for one connection.
 *
 * Identity comes from the connection's own declaration (`presetId`,
 * `piProviderId`, `vendor`) — never from its Base URL. A custom profile that
 * happens to point at a builtin provider's host must keep its own identity.
 */
export function resolveModelProviderIdentity(input: ModelProviderLogoInput): ModelProviderIdentity {
  const signalIdentity = resolveModelProviderIdentityFromSignal(
    [input.presetId, input.vendor].filter(Boolean).join(" "),
  );
  if (signalIdentity !== undefined) return signalIdentity;

  // Pi provider ids are already brand slugs. A `pi:` prefix only disambiguates
  // duplicate preset ids and is not part of the brand.
  const presetKey = normalizeProviderSignal(input.piProviderId ?? input.presetId).replace(/^pi:/u, "");
  return isBrandSlug(presetKey) ? presetKey : UNKNOWN_MODEL_IDENTITY;
}

/**
 * Sort priority for the providers the product treats as first-class today.
 * Anything else keeps a stable neutral rank and falls back to declaration order.
 */
export function modelProviderSortRank(input: ModelProviderLogoInput): number {
  const identity = resolveModelProviderIdentity(input);
  const rank = FIRST_CLASS_PROVIDER_ORDER.get(identity);
  return rank ?? NEUTRAL_PROVIDER_RANK;
}

export function resolveModelProviderLogo(input: ModelProviderLogoInput): ModelProviderLogo {
  const customLogo = input.logoDataUrl?.trim();
  if (customLogo !== undefined && customLogo.length > 0) {
    return { imageSrc: customLogo, tone: "custom" };
  }
  const identity = resolveModelProviderIdentity(input);
  const asset = providerLogos[identity];
  return asset === undefined
    ? { svg: providerLogos[FALLBACK_PROVIDER_BRAND] ?? "", tone: "default" }
    : { svg: asset, tone: identity };
}

/**
 * Resolves a stored profile id back to its builtin preset slot.
 *
 * Only the stable profile identity participates: a custom profile never
 * inherits a builtin provider's brand from its Base URL.
 */
export function builtinProviderPresetId(input: {
  readonly profileId?: string;
  readonly presetId?: string;
}): string | undefined {
  const explicitPreset = normalizeProviderSignal(input.presetId);
  if (explicitPreset.length > 0) return explicitPreset;
  const normalizedProfileId = normalizeProviderSignal(input.profileId);
  return BUILTIN_PROFILE_PRESET_IDS.has(normalizedProfileId) ? normalizedProfileId : undefined;
}

const FIRST_CLASS_PROVIDER_ORDER: ReadonlyMap<string, number> = new Map([
  ["openai", 0],
  ["anthropic", 1],
  ["deepseek", 2],
  ["moonshot", 3],
  ["zai", 4],
  ["minimax", 5],
  ["qwen", 6],
]);

const NEUTRAL_PROVIDER_RANK = 99;

/**
 * Stable profile ids whose slot identity is fixed at creation.
 *
 * `default` is the shipped OpenAI slot; the rest are the four builtin vendor
 * slots. Custom profiles use generated `custom_*` ids and are absent here.
 */
const BUILTIN_PROFILE_PRESET_IDS: ReadonlySet<string> = new Set([
  "default",
  "openai",
  "deepseek",
  "moonshot",
  "glm",
  "minimax",
]);

function buildProviderLogos(): Readonly<Record<string, string>> {
  const logos: Record<string, string> = {};
  for (const [path, svg] of Object.entries(providerLogoModules)) {
    if (isMonoAsset(path)) continue;
    const key = assetKeyFromPath(path);
    if (key.length === 0) continue;
    logos[key] = decorativeSvg(svg);
  }
  return logos;
}

function assetKeyFromPath(path: string): string {
  return (path.split("/").pop() ?? "")
    .replace(/\.svg$/iu, "")
    .replace(/\.mono$/iu, "")
    .toLowerCase();
}

function isMonoAsset(path: string): boolean {
  return /\.mono\.svg$/iu.test(path);
}

function normalizeProviderSignal(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isBrandSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}
