import { modelIconVariants } from "./icon-variants";
import {
  UNKNOWN_MODEL_IDENTITY,
  resolveModelFamilyIdentity,
} from "./model-family";
import type { ModelFamilyIdentity, ModelProviderIdentity } from "./model-family";

/**
 * Model family marks are discovered from `assets/model-icons/<family>.svg`.
 *
 * The file name is the family slug, so shipping a new family is a data change:
 * drop the SVG in and it resolves. Canonical assets preserve native colours;
 * `.mono.svg` variants follow the appearance preference.
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
  const originals: Record<string, string> = {};
  const monochrome: Record<string, string> = {};
  for (const [path, svg] of Object.entries(modelIconModules)) {
    const key = familyKeyFromPath(path);
    if (key.length === 0) continue;
    if (isMonoAsset(path)) { monochrome[key] = svg; continue; }
    if (isLegacyAssetName(path) && originals[key] !== undefined) continue;
    originals[key] = svg;
  }
  return Object.fromEntries(Object.entries(originals).map(([key, svg]) => [key, modelIconVariants(svg, monochrome[key], "model-" + key)]));
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
