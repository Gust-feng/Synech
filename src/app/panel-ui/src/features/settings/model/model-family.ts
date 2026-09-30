/**
 * Brand and model-family identity.
 *
 * These are asset keys, not a closed enum: every Pi provider and every model
 * family that ships an SVG under `assets/providers` / `assets/model-icons` is
 * addressable by its slug. Adding a brand is therefore a data change, not a
 * code change.
 *
 * `unknown` means "no brand could be established from the available signals".
 * It is never a guess: a custom profile pointing at the same host as a builtin
 * provider keeps its own identity instead of inheriting that provider's mark.
 */
export type ModelProviderIdentity = string;
export type ModelFamilyIdentity = string;

export const UNKNOWN_MODEL_IDENTITY = "unknown";

/**
 * Signal → brand slug. Order matters: first match wins, so more specific
 * brands must appear before broader ones.
 */
const providerBrandPatterns: readonly (readonly [RegExp, string])[] = [
  [/openrouter/u, "openrouter"],
  [/opencode/u, "opencode"],
  [/github|copilot/u, "github-copilot"],
  [/huggingface|hugging face/u, "huggingface"],
  [/cloudflare/u, "cloudflare"],
  [/fireworks/u, "fireworks"],
  [/cerebras/u, "cerebras"],
  [/together/u, "together"],
  [/baseten/u, "baseten"],
  [/vercel/u, "vercel"],
  [/openai|chatgpt|codex/u, "openai"],
  [/anthropic|claude/u, "anthropic"],
  [/azure/u, "azure-openai"],
  [/amazon|bedrock/u, "amazon-bedrock"],
  [/google|gemini|gemma|vertex/u, "google"],
  [/moonshot|kimi/u, "moonshot"],
  [/zhipu|bigmodel|z-ai|zai|glm/u, "zai"],
  [/minimax/u, "minimax"],
  [/deepseek/u, "deepseek"],
  [/mistral|mixtral|pixtral|magistral|devstral|codestral|ministral|voxtral/u, "mistral"],
  [/qwen|alibaba|dashscope/u, "qwen"],
  [/xai|x-ai|grok/u, "xai"],
  [/nvidia|nemotron/u, "nvidia"],
  [/groq/u, "groq"],
  [/xiaomi/u, "xiaomi"],
  [/ant-ling|antling|inclusionai/u, "ant-ling"],
  [/radius/u, "radius"],
  [/meta|llama/u, "meta"],
];

/**
 * Model id / display name → model family slug.
 *
 * Families are deliberately finer-grained than providers: Meta ships both
 * Llama and Muse, Google ships both Gemini and Gemma, and each needs its own
 * mark. Modifier suffixes (`:batch`, `:free`, `-latest`, `-preview`, `-fast`)
 * describe the same family and never create new entries.
 */
const modelFamilyPatterns: readonly (readonly [RegExp, string])[] = [
  [/gpt|chatgpt|codex|gpt-oss/u, "gpt"],
  [/(^|[/\-.])o[134](-|$)/u, "gpt"],
  [/claude/u, "claude"],
  [/gemma/u, "gemma"],
  [/gemini/u, "gemini"],
  [/llama/u, "llama"],
  [/muse-/u, "muse"],
  [/mistral|mixtral|pixtral|magistral|devstral|codestral|ministral|voxtral/u, "mistral"],
  [/grok/u, "grok"],
  [/qwen/u, "qwen"],
  [/deepseek/u, "deepseek"],
  [/kimi|moonshot/u, "kimi"],
  [/glm|zai|z-ai/u, "glm"],
  [/minimax/u, "minimax"],
  [/(^|[/\-.])nova(-|$)|titan/u, "nova"],
  [/command|cohere/u, "command"],
  [/nemotron/u, "nemotron"],
  [/inclusionai|(^|[/\-.])ling-/u, "ling"],
  [/(^|[/\-.])step[-.]/u, "step"],
  [/mimo/u, "mimo"],
  [/granite/u, "granite"],
  [/bytedance|seed-/u, "seed"],
  [/hunyuan|(^|[/\-.])hy[0-9]/u, "hy"],
  [/longcat/u, "longcat"],
  [/aion-/u, "aion"],
  [/arcee|trinity/u, "arcee"],
  [/dots-/u, "dots"],
  [/nex-agi|nex-n/u, "nex"],
  [/sakana|namazu|fugu/u, "sakana"],
  [/poolside|laguna/u, "laguna"],
  [/liquid|lfm/u, "liquid"],
  [/kwaipilot|kat-coder/u, "kat"],
  [/palmyra|writer\./u, "palmyra"],
  [/interfaze/u, "interfaze"],
  [/prism|ternary-bonsai/u, "prism"],
  [/quiverai/u, "quiverai"],
  [/relace/u, "relace"],
  [/mixedbread|toast-/u, "mixedbread"],
  [/big-pickle/u, "big-pickle"],
];

export function resolveModelFamilyIdentity(input: {
  readonly model?: string;
  readonly displayName?: string;
}): ModelFamilyIdentity {
  const signal = normalizeModelIdentitySignal([input.displayName, input.model].filter(Boolean).join(" "));
  for (const [pattern, family] of modelFamilyPatterns) {
    if (pattern.test(signal)) return family;
  }
  return UNKNOWN_MODEL_IDENTITY;
}

export function resolveModelProviderIdentityFromSignal(
  value: string | undefined,
): ModelProviderIdentity | undefined {
  const signal = normalizeModelIdentitySignal(value);
  if (signal.length === 0) return undefined;
  for (const [pattern, brand] of providerBrandPatterns) {
    if (pattern.test(signal)) return brand;
  }
  return undefined;
}

function normalizeModelIdentitySignal(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
