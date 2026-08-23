import deepseekLogo from "./assets/providers/deepseek.svg?raw";
import kimiLogo from "./assets/providers/kimi.svg?raw";
import minimaxLogo from "./assets/providers/minimax.svg?raw";
import modelProviderLogo from "./assets/providers/model-provider.svg?raw";
import openaiLogo from "./assets/providers/openai.svg?raw";
import zaiLogo from "./assets/providers/zai.svg?raw";
import {
  resolveModelFamilyIdentity,
  resolveModelProviderIdentityFromSignal,
  type ModelFamilyIdentity,
  type ModelProviderIdentity,
} from "../../model-visuals/model-family";
import { decorativeSvg } from "./icon-svg";

export { resolveModelFamilyIdentity };
export type { ModelFamilyIdentity, ModelProviderIdentity };

const providerLogos = {
  deepseek: decorativeSvg(deepseekLogo),
  kimi: decorativeSvg(kimiLogo),
  minimax: decorativeSvg(minimaxLogo),
  modelProvider: decorativeSvg(modelProviderLogo),
  openai: decorativeSvg(openaiLogo),
  zai: decorativeSvg(zaiLogo),
} as const;

export type ModelProviderLogoInput = {
  readonly title?: string;
  readonly vendor?: string;
  readonly profileId?: string;
  readonly presetId?: string;
  readonly logoDataUrl?: string;
  readonly baseUrl?: string;
  readonly model?: string;
};

export type ModelProviderLogo = {
  readonly svg?: string;
  readonly imageSrc?: string;
  readonly tone: string;
};

const builtinProviderPresetAliases = new Map<string, Exclude<ModelProviderIdentity, "unknown">>([
  ["default", "openai"],
  ["openai", "openai"],
  ["deepseek", "deepseek"],
  ["moonshot", "kimi"],
  ["kimi", "kimi"],
  ["glm", "glm"],
  ["zhipu", "glm"],
  ["zai", "glm"],
  ["minimax", "minimax"],
]);

export function modelProviderDisplayName(identity: Exclude<ModelProviderIdentity, "unknown">): string {
  if (identity === "openai") return "OpenAI";
  if (identity === "deepseek") return "DeepSeek";
  if (identity === "kimi") return "月之暗面";
  if (identity === "glm") return "智谱 AI";
  return "MiniMax";
}

export function resolveModelProviderIdentity(input: ModelProviderLogoInput): ModelProviderIdentity {
  const builtinIdentity = builtinProviderIdentity(input);
  if (builtinIdentity !== undefined) {
    return builtinIdentity;
  }
  const explicitProvider = normalizeProviderSignal([input.presetId, input.vendor].filter(Boolean).join(" "));
  const explicitIdentity = resolveStrongProviderSignal(explicitProvider);
  if (explicitIdentity !== undefined) return explicitIdentity;

  return "unknown";
}

function normalizeProviderSignal(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolveStrongProviderSignal(value: string): Exclude<ModelProviderIdentity, "unknown"> | undefined {
  return resolveModelProviderIdentityFromSignal(value);
}

export function modelProviderSortRank(input: ModelProviderLogoInput): number {
  const identity = resolveModelProviderIdentity(input);
  if (identity === "openai") return 0;
  if (identity === "deepseek") return 1;
  if (identity === "kimi") return 2;
  if (identity === "glm") return 3;
  if (identity === "minimax") return 4;
  return 99;
}

export function resolveModelProviderLogo(input: ModelProviderLogoInput): ModelProviderLogo {
  if (input.logoDataUrl !== undefined && input.logoDataUrl.trim().length > 0) {
    return { imageSrc: input.logoDataUrl, tone: "custom" };
  }
  const identity = resolveModelProviderIdentity(input);
  if (identity === "openai") return { svg: providerLogos.openai, tone: "openai" };
  if (identity === "deepseek") return { svg: providerLogos.deepseek, tone: "deepseek" };
  if (identity === "kimi") return { svg: providerLogos.kimi, tone: "kimi" };
  if (identity === "glm") return { svg: providerLogos.zai, tone: "glm" };
  if (identity === "minimax") return { svg: providerLogos.minimax, tone: "minimax" };
  return { svg: providerLogos.modelProvider, tone: "default" };
}

export function builtinProviderPresetId(input: {
  readonly profileId?: string;
  readonly presetId?: string;
}): string | undefined {
  const explicitPreset = normalizeProviderSignal(input.presetId);
  if (explicitPreset.length > 0) {
    return explicitPreset;
  }
  const normalizedProfileId = normalizeProviderSignal(input.profileId);
  const aliasedProfile = builtinProviderPresetAliases.get(normalizedProfileId);
  if (aliasedProfile !== undefined) {
    return presetIdFromIdentity(aliasedProfile);
  }
  return undefined;
}

function builtinProviderIdentity(input: ModelProviderLogoInput): Exclude<ModelProviderIdentity, "unknown"> | undefined {
  // Base URLs are transport configuration, not provider identity. A custom
  // profile can intentionally point at the same endpoint as a built-in
  // provider and must not inherit that provider's visual identity.
  const presetId = builtinProviderPresetId({
    profileId: input.profileId,
    presetId: input.presetId,
  });
  if (presetId === undefined) {
    return undefined;
  }
  if (presetId === "openai") return "openai";
  if (presetId === "deepseek") return "deepseek";
  if (presetId === "moonshot") return "kimi";
  if (presetId === "glm") return "glm";
  if (presetId === "minimax") return "minimax";
  return undefined;
}

function presetIdFromIdentity(identity: Exclude<ModelProviderIdentity, "unknown">): string {
  if (identity === "kimi") return "moonshot";
  return identity;
}
