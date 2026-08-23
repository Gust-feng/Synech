import type { ModelFailure } from "../../domain/intelligence/index.js";
import { sanitizeAssistantVisibleText } from "../text-projection/visible-text-safety.js";
import { cleanOrdinaryToolText } from "./ordinary-tool-copy.js";

export function compactOrdinaryText(value: string, maxLength = 1_200): string {
  return compactSafeText(sanitizeAssistantVisibleText(value), maxLength) ?? "";
}

export function compactOrdinaryMarkdownFragment(value: string, maxLength = 1_200): string {
  const text = sanitizeAssistantVisibleText(value, { preserveOuterWhitespace: true })
    .replace(/\r\n?/g, "\n");
  if (text.trim().length === 0) return text;
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

export function projectModelFailure(failure: ModelFailure | undefined): string {
  return compactOrdinaryText(failure?.message ?? "模型服务没有返回可用结果。", 600);
}

export function safeReadFileToolPreview(input: {
  readonly summary?: string;
  readonly path?: string;
  readonly bytes?: number;
  readonly maxLength?: number;
}): string | undefined {
  const headline = cleanOrdinaryToolText(input.summary) ?? input.path;
  return compactSafeText(headline || "文件已读取。", input.maxLength ?? 900);
}

export function safeCommandToolPreview(input: {
  readonly summary?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly maxLength?: number;
}): string | undefined {
  const headline = cleanOrdinaryToolText(input.summary) ?? input.command;
  return compactSafeText(headline || "命令已执行。", input.maxLength ?? 900);
}

export function compactSafeText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = value.trim();
  if (text.length === 0) {
    return undefined;
  }
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}
