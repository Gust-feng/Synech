import type { ModelCapabilities } from "./contracts/config";

export function modelCapabilitySummary(capabilities: ModelCapabilities | undefined): string | undefined {
  const contextWindow = formatTokenWindow(capabilities?.contextWindowTokens);
  if (contextWindow === undefined) {
    return undefined;
  }
  const maxOutput = formatTokenWindow(capabilities?.maxOutputTokens);
  return maxOutput === undefined ? `上下文 ${contextWindow}` : `上下文 ${contextWindow} / 输出 ${maxOutput}`;
}

export function formatTokenWindow(tokens: number | undefined): string | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  if (tokens >= 1_000_000) {
    return `${formatCompactNumber(tokens / 1_000_000)}M`;
  }
  if (tokens >= 1_000) {
    return `${formatCompactNumber(tokens / 1_000)}K`;
  }
  return String(Math.round(tokens));
}

function formatCompactNumber(value: number): string {
  const rounded = value >= 10 ? Math.round(value).toString() : value.toFixed(value >= 1 ? 1 : 2);
  return rounded.replace(/\.0$/u, "");
}