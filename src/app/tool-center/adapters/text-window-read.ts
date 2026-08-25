import { createReadStream } from "node:fs";
import { TextDecoder } from "node:util";

import type { ToolContinuation, ToolFactValue } from "../../../domain/tools/index.js";
import { toolResultMessage } from "../../../kernel/intelligence/tool-use-loop-messages.js";
import { optionalSafeIntegerAtLeast, positiveInteger, throwIfAborted } from "./local-workspace-common.js";
import { isUtf16CodeUnitBoundary, utf16SafePrefixLength } from "../text-window.js";
import {
  DEFAULT_MAX_INLINE_TOOL_CONTENT_JSON_CHARS,
  DEFAULT_MAX_INLINE_TOOL_RESULT_TOKENS,
  DEFAULT_TARGET_INLINE_TOOL_BODY_TOKENS,
  type ToolOutputTokenCounter,
} from "../tool-output-limits.js";

export const DEFAULT_READ_MAX_CHARS = 128_000;
export const MIN_CHARACTER_WINDOW_CHARS = 3;
export const MAX_READ_LINE_COUNT = 2_000;
export const DEFAULT_READ_LINE_COUNT = 200;

export type ReadContentWindow = {
  readonly content: string;
  readonly range?: { readonly startLine: number; readonly endLine: number };
  readonly totalLines?: number;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly startChar?: number;
  readonly charCount?: number;
  readonly nextStartChar?: number;
};

type ReadFileContinuationSeed = { readonly path: string; readonly maxLength: number };
type TextLine = { readonly text: string; readonly ending: string };

export function parseLineRange(
  record: Readonly<Record<string, unknown>>,
): { readonly startLine: number; readonly endLine: number } | undefined {
  const startLine = positiveInteger(record.startLine);
  const explicitEndLine = positiveInteger(record.endLine);
  if (startLine === undefined && explicitEndLine === undefined) return undefined;
  const start = startLine ?? 1;
  const end = explicitEndLine ?? start + DEFAULT_READ_LINE_COUNT - 1;
  if (end < start) throw new Error("read endLine must be greater than or equal to startLine.");
  if (end - start + 1 > MAX_READ_LINE_COUNT) {
    throw new Error(`read line range is too large; request at most ${MAX_READ_LINE_COUNT} lines at a time.`);
  }
  return { startLine: start, endLine: end };
}

export function readStartChar(value: unknown): number | undefined {
  return optionalSafeIntegerAtLeast(value, "read startChar", 0);
}

export function readMaxLength(value: unknown): number {
  return optionalSafeIntegerAtLeast(value, "read maxLength", MIN_CHARACTER_WINDOW_CHARS) ?? DEFAULT_READ_MAX_CHARS;
}

export function charWindowContent(raw: string, requestedStartChar: number): ReadContentWindow {
  if (requestedStartChar > raw.length) {
    throw new Error(`read startChar ${requestedStartChar} exceeds charCount ${raw.length}.`);
  }
  if (!isUtf16CodeUnitBoundary(raw, requestedStartChar)) {
    throw new Error("read startChar must not split a UTF-16 surrogate pair.");
  }
  return {
    content: raw.slice(requestedStartChar),
    totalLines: textLinesPreservingEndings(raw).length,
    hasMoreBefore: requestedStartChar > 0,
    hasMoreAfter: false,
    startChar: requestedStartChar,
    charCount: raw.length,
  };
}

export function sliceLines(
  raw: string,
  range: { readonly startLine: number; readonly endLine: number },
): ReadContentWindow {
  const lines = textLinesPreservingEndings(raw);
  const selected = lines.slice(range.startLine - 1, range.endLine);
  const actualEndLine = selected.length === 0 ? range.startLine : range.startLine + selected.length - 1;
  return {
    content: selected.map((line, index) =>
      index === selected.length - 1 ? line.text : `${line.text}${line.ending}`).join(""),
    range: { startLine: range.startLine, endLine: actualEndLine },
    totalLines: lines.length,
    hasMoreBefore: range.startLine > 1,
    hasMoreAfter: actualEndLine < lines.length,
  };
}

export function truncateReadFileContent(value: string, maxLength: number): {
  readonly text: string;
  readonly rawChars: number;
  readonly truncated: boolean;
} {
  if (value.length <= maxLength && JSON.stringify(value).length <= DEFAULT_MAX_INLINE_TOOL_CONTENT_JSON_CHARS) {
    return { text: value, rawChars: value.length, truncated: false };
  }
  const maxRawChars = Math.max(0, Math.min(value.length, maxLength - 1));
  let low = 0;
  let high = maxRawChars;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${value.slice(0, middle)}…`;
    if (JSON.stringify(candidate).length <= DEFAULT_MAX_INLINE_TOOL_CONTENT_JSON_CHARS) low = middle;
    else high = middle - 1;
  }
  const rawChars = utf16SafePrefixLength(value, low);
  return { text: `${value.slice(0, rawChars)}…`, rawChars, truncated: true };
}

export async function readLineRange(
  absolutePath: string,
  range: { readonly startLine: number; readonly endLine: number },
  abortSignal: AbortSignal | undefined,
): Promise<ReadContentWindow> {
  const stream = createReadStream(absolutePath);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const lines: TextLine[] = [];
  let lineNumber = 0;
  let hasMoreAfter = false;
  let pending = "";
  let endedWithLineEnding = false;
  const acceptLine = (line: TextLine): boolean => {
    lineNumber += 1;
    if (lineNumber >= range.startLine && lineNumber <= range.endLine) lines.push(line);
    if (lineNumber >= range.endLine && line.ending.length > 0) {
      hasMoreAfter = true;
      return true;
    }
    return lineNumber > range.endLine;
  };
  try {
    streamLoop: for await (const chunk of stream) {
      throwIfAborted(abortSignal);
      try {
        pending += decoder.decode(chunk as Buffer, { stream: true });
      } catch {
        throw new InvalidUtf8TextError();
      }
      while (true) {
        const boundary = nextLineEnding(pending, false);
        if (boundary === undefined) break;
        const line = {
          text: pending.slice(0, boundary.index),
          ending: pending.slice(boundary.index, boundary.index + boundary.length),
        };
        pending = pending.slice(boundary.index + boundary.length);
        endedWithLineEnding = pending.length === 0;
        if (acceptLine(line)) break streamLoop;
      }
    }
    if (!hasMoreAfter) {
      try {
        pending += decoder.decode();
      } catch {
        throw new InvalidUtf8TextError();
      }
      while (true) {
        const boundary = nextLineEnding(pending, true);
        if (boundary === undefined) break;
        const line = {
          text: pending.slice(0, boundary.index),
          ending: pending.slice(boundary.index, boundary.index + boundary.length),
        };
        pending = pending.slice(boundary.index + boundary.length);
        endedWithLineEnding = pending.length === 0;
        if (acceptLine(line)) break;
      }
      if (!hasMoreAfter && (pending.length > 0 || endedWithLineEnding)) {
        acceptLine({ text: pending, ending: "" });
      }
    }
  } finally {
    stream.destroy();
  }
  const actualEndLine = lines.length === 0 ? range.startLine : range.startLine + lines.length - 1;
  return {
    content: lines.map((line, index) =>
      index === lines.length - 1 ? line.text : `${line.text}${line.ending}`).join(""),
    range: { startLine: range.startLine, endLine: actualEndLine },
    totalLines: hasMoreAfter ? undefined : lineNumber,
    hasMoreBefore: range.startLine > 1,
    hasMoreAfter,
  };
}

export class InvalidUtf8TextError extends Error {
  constructor() {
    super("File is not valid UTF-8 text.");
    this.name = "InvalidUtf8TextError";
  }
}

export function invalidUtf8ReadResult(relativePath: string, bytes: number): ToolFactValue {
  return { refId: `workspace:file:${relativePath}`, path: relativePath, bytes, binary: true, reason: "invalid_utf8" };
}

export function fitReadOutput<T extends Readonly<Record<string, unknown>> & { readonly content: string }>(
  output: T,
  counter: ToolOutputTokenCounter | undefined,
  callId: string | undefined,
  continuationSeed: ReadFileContinuationSeed | undefined,
): T {
  if (counter === undefined || modelOutputFits("Read", output, counter, callId)) return output;
  if (continuationSeed === undefined) {
    throw new Error("read line-range output exceeds the fixed model result budget; request fewer lines.");
  }
  const rawContentLength = typeof output.textChars === "number" &&
    Number.isSafeInteger(output.textChars) && output.textChars >= 0
    ? Math.min(output.textChars, output.content.length)
    : output.content.length;
  const rawContent = output.content.slice(0, rawContentLength);
  let low = 0;
  let high = rawContent.length;
  let best: T | undefined;
  while (low <= high) {
    const requestedLength = Math.floor((low + high) / 2);
    const length = utf16SafePrefixLength(rawContent, requestedLength);
    const startChar = typeof output.startChar === "number" ? output.startChar : 0;
    const candidateHasMoreAfter = output.hasMoreAfter === true || length < rawContent.length;
    const candidate = {
      ...output,
      content: candidateHasMoreAfter ? `${rawContent.slice(0, length)}…` : rawContent,
      textChars: length,
      hasMoreAfter: candidateHasMoreAfter,
      truncated: candidateHasMoreAfter,
      nextStartChar: candidateHasMoreAfter ? startChar + length : undefined,
      nextStartLine: undefined,
      continuation: candidateHasMoreAfter
        ? readFileContinuation({ ...continuationSeed, nextStartChar: startChar + length })
        : undefined,
    } as T;
    if (length > 0 && modelOutputFits("Read", candidate, counter, callId)) {
      best = candidate;
      low = requestedLength + 1;
    } else high = requestedLength - 1;
  }
  if (best === undefined) throw new Error("read metadata exceeds the fixed model result budget.");
  return best;
}

export function readFileContinuation(input: {
  readonly path: string;
  readonly maxLength: number;
  readonly nextStartChar?: number;
  readonly nextStartLine?: number;
}): ToolContinuation | undefined {
  if (input.nextStartChar !== undefined) {
    return { nextInput: { path: input.path, maxLength: input.maxLength, startChar: input.nextStartChar } };
  }
  if (input.nextStartLine !== undefined) {
    return { nextInput: { path: input.path, startLine: input.nextStartLine } };
  }
  return undefined;
}

function modelOutputFits(
  toolName: string,
  output: Readonly<Record<string, unknown>>,
  counter: ToolOutputTokenCounter,
  callId: string | undefined,
): boolean {
  if (counter.countText(JSON.stringify(output)) > DEFAULT_TARGET_INLINE_TOOL_BODY_TOKENS) return false;
  const message = toolResultMessage({
    providerCallId: callId ?? toolName,
    invocationId: callId ?? throwMissingInvocationForInlineBudget(toolName),
    toolName,
    input: undefined,
    output: output as ToolFactValue,
    status: "completed",
    durationMs: 0,
  });
  return counter.countText(JSON.stringify(message)) <= DEFAULT_MAX_INLINE_TOOL_RESULT_TOKENS;
}

function textLinesPreservingEndings(raw: string): readonly TextLine[] {
  if (raw.length === 0) return [];
  const lines: TextLine[] = [];
  let remaining = raw;
  while (true) {
    const boundary = nextLineEnding(remaining, true);
    if (boundary === undefined) {
      lines.push({ text: remaining, ending: "" });
      break;
    }
    lines.push({
      text: remaining.slice(0, boundary.index),
      ending: remaining.slice(boundary.index, boundary.index + boundary.length),
    });
    remaining = remaining.slice(boundary.index + boundary.length);
    if (remaining.length === 0) {
      lines.push({ text: "", ending: "" });
      break;
    }
  }
  return lines;
}

function nextLineEnding(value: string, final: boolean): { readonly index: number; readonly length: number } | undefined {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") return { index, length: 1 };
    if (value[index] !== "\r") continue;
    if (index + 1 < value.length) return { index, length: value[index + 1] === "\n" ? 2 : 1 };
    return final ? { index, length: 1 } : undefined;
  }
  return undefined;
}

function throwMissingInvocationForInlineBudget(toolName: string): never {
  throw new Error(
    `Tool adapter for ${toolName} cannot measure an inline tool result without an upstream-bound invocationId.`,
  );
}
