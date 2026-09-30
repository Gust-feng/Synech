import { decorativeSvg } from "../../../icon-svg";
import {
  UNKNOWN_MODEL_IDENTITY,
  resolveModelFamilyIdentity,
} from "./model-family";
import type { ModelFamilyIdentity, ModelProviderIdentity } from "./model-family";

/**
 * Model family marks are discovered from `assets/model-icons/<family>.svg`.
 *
 * The file name is the family slug, so shipping a new family is a data change:
 * drop the SVG in and it resolves. `<family>.mono.svg` files are the theme-safe
 * fallbacks and are addressed separately.
 */
const modelIconModules = import.meta.glob("../../../assets/model-icons/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Readonly<Record<string, string>>;

const modelIcons: Readonly<Record<string, string>> = buildModelIcons();

export function resolveModelIconSvg(identity: ModelFamilyIdentity): string | undefined {
  return modelIcons[identity];
}

/**
 * The mark to draw for one model.
 *
 * A model family mark wins over the provider mark so Claude, Gemini, Gemma and
 * Llama are not flattened into whichever company ships them.
 */
export function resolveModelIconIdentity(input: {
  readonly providerIdentity?: ModelProviderIdentity;
  readonly modelId?: string;
  readonly displayName?: string;
}): ModelFamilyIdentity {
  const family = resolveModelFamilyIdentity({
    displayName: input.displayName,
    model: input.modelId,
  });
  return family === UNKNOWN_MODEL_IDENTITY ? input.providerIdentity ?? UNKNOWN_MODEL_IDENTITY : family;
}

export function resolveModelIconSvgForModel(input: {
  readonly providerIdentity?: ModelProviderIdentity;
  readonly modelId?: string;
  readonly displayName?: string;
}): string | undefined {
  return resolveModelIconSvg(resolveModelIconIdentity(input));
}

function buildModelIcons(): Readonly<Record<string, string>> {
  const icons: Record<string, string> = {};
  const legacyKeys = new Set<string>();
  for (const [path, svg] of Object.entries(modelIconModules)) {
    if (isMonoAsset(path)) continue;
    const key = familyKeyFromPath(path);
    if (key.length === 0) continue;
    const legacy = isLegacyAssetName(path);
    // Canonical `<family>.svg` wins over a legacy `<family>_model_icon.svg`
    // regardless of glob order, so replacing an asset is a file drop.
    if (legacy && icons[key] !== undefined) continue;
    if (legacy) legacyKeys.add(key);
    icons[key] = decorativeSvg(svg);
  }
  return icons;
}

function familyKeyFromPath(path: string): string {
  return (path.split("/").pop() ?? "")
    .replace(/\.svg$/iu, "")
    .replace(/\.mono$/iu, "")
    .replace(/_model_icon$/iu, "")
    .replace(/^chatgpt_/iu, "")
    .toLowerCase();
}

function isLegacyAssetName(path: string): boolean {
  return /_model_icon\.svg$/iu.test(path);
}

function isMonoAsset(path: string): boolean {
  return /\.mono\.svg$/iu.test(path);
}
