export type ModelProviderIdentity = "openai" | "deepseek" | "kimi" | "glm" | "minimax" | "unknown";

export type ModelFamilyIdentity = ModelProviderIdentity | "claude";

const providerIdentityPatterns: readonly [Exclude<ModelProviderIdentity, "unknown">, RegExp][] = [
  ["openai", /api\.openai\.com|openai|chatgpt|gpt/iu],
  ["deepseek", /deepseek/iu],
  ["kimi", /moonshot|kimi|月之暗面/iu],
  ["glm", /bigmodel|zhipu|glm|智谱/iu],
  ["minimax", /minimaxi?|mini\s*max/iu],
];

export function resolveModelFamilyIdentity(input: {
  readonly model?: string;
  readonly displayName?: string;
}): ModelFamilyIdentity {
  const signal = normalizeModelIdentitySignal([input.displayName, input.model].filter(Boolean).join(" "));
  if (/anthropic|claude/iu.test(signal)) {
    return "claude";
  }
  return resolveModelProviderIdentityFromSignal(signal) ?? "unknown";
}

export function resolveModelProviderIdentityFromSignal(
  value: string | undefined,
): Exclude<ModelProviderIdentity, "unknown"> | undefined {
  const signal = normalizeModelIdentitySignal(value);
  for (const [identity, pattern] of providerIdentityPatterns) {
    if (pattern.test(signal)) {
      return identity;
    }
  }
  return undefined;
}

function normalizeModelIdentitySignal(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
