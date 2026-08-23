import claudeModelIcon from "../../model-visuals/model-icons/claude_model_icon.svg?raw";
import deepseekModelIcon from "../../model-visuals/model-icons/deepseek_model_icon.svg?raw";
import glmModelIcon from "../../model-visuals/model-icons/glm.svg?raw";
import kimiModelIcon from "../../model-visuals/model-icons/kimi_model_icon.svg?raw";
import minimaxModelIcon from "../../model-visuals/model-icons/minimax_model_icon.svg?raw";
import openaiModelIcon from "../../model-visuals/model-icons/chatgpt_gpt_model_icon.svg?raw";
import { decorativeSvg } from "./icon-svg";
import {
  resolveModelFamilyIdentity,
  type ModelFamilyIdentity,
  type ModelProviderIdentity,
} from "./model-provider-logos";

const openaiModelSvg = decorativeSvg(openaiModelIcon);
const claudeModelSvg = decorativeSvg(claudeModelIcon);
const deepseekModelSvg = decorativeSvg(deepseekModelIcon);
const kimiModelSvg = decorativeSvg(kimiModelIcon);
const glmModelSvg = decorativeSvg(glmModelIcon);
const minimaxModelSvg = decorativeSvg(minimaxModelIcon);

export function resolveModelIconSvg(identity: ModelFamilyIdentity): string | undefined {
  if (identity === "openai") return openaiModelSvg;
  if (identity === "claude") return claudeModelSvg;
  if (identity === "deepseek") return deepseekModelSvg;
  if (identity === "kimi") return kimiModelSvg;
  if (identity === "glm") return glmModelSvg;
  if (identity === "minimax") return minimaxModelSvg;
  return undefined;
}

export function resolveModelIconIdentity(input: {
  readonly providerIdentity?: ModelProviderIdentity;
  readonly modelId?: string;
  readonly displayName?: string;
}): ModelFamilyIdentity {
  const modelIdentity = resolveModelFamilyIdentity({
    displayName: input.displayName,
    model: input.modelId,
  });
  return modelIdentity === "unknown" ? input.providerIdentity ?? "unknown" : modelIdentity;
}

export function resolveModelIconSvgForModel(input: {
  readonly providerIdentity?: ModelProviderIdentity;
  readonly modelId?: string;
  readonly displayName?: string;
}): string | undefined {
  return resolveModelIconSvg(resolveModelIconIdentity(input));
}
