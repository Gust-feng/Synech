import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { positiveInteger } from "./local-workspace-common.js";
import {
  isUtf16CodeUnitBoundary,
  utf16SafePrefixLength,
} from "../text-window.js";

const MAX_READ_LINE_COUNT = 2_000;
const DEFAULT_READ_LINE_COUNT = 200;

export type ReadContentWindow = {
  readonly content: string;
  readonly range?: { readonly startLine: number; readonly endLine: number };
  readonly totalLines?: number;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly startChar?: number;
  readonly textChars?: number;
  readonly charCount?: number;
  readonly nextStartChar?: number;
};

export async function readAttachmentTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8").catch(() => {
    throw new Error("Attachment text target could not be read.");
  });
}

export function parseLineRange(
  record: Readonly<Record<string, unknown>>
): { readonly startLine: number; readonly endLine: number } | undefined {
  const startLine = positiveInteger(record.startLine);
  const explicitEndLine = positiveInteger(record.endLine);
  if (startLine === undefined && explicitEndLine === undefined) {
    return undefined;
  }
  const start = startLine ?? 1;
  const end = explicitEndLine ?? start + DEFAULT_READ_LINE_COUNT - 1;
  if (end < start) {
    throw new Error("attachment_read_text endLine must be greater than or equal to startLine.");
  }
  if (end - start + 1 > MAX_READ_LINE_COUNT) {
    throw new Error(`attachment_read_text line range is too large; request at most ${MAX_READ_LINE_COUNT} lines at a time.`);
  }
  return { startLine: start, endLine: end };
}

export function charWindowContent(raw: string, requestedStartChar: number): ReadContentWindow {
  if (requestedStartChar > raw.length) {
    throw new Error(
      `attachment_read_text startChar ${requestedStartChar} exceeds charCount ${raw.length}.`,
    );
  }
  const startChar = requestedStartChar;
  if (!isUtf16CodeUnitBoundary(raw, startChar)) {
    throw new Error("attachment_read_text startChar must not split a UTF-16 surrogate pair.");
  }
  return {
    content: raw.slice(startChar),
    range: undefined,
    totalLines: countLines(raw),
    hasMoreBefore: startChar > 0,
    hasMoreAfter: false,
    startChar,
    charCount: raw.length,
  };
}

export function sliceLines(
  raw: string,
  range: { readonly startLine: number; readonly endLine: number }
): ReadContentWindow {
  const lines = raw.split(/\r?\n/);
  const selected = lines.slice(range.startLine - 1, range.endLine);
  const actualEndLine = selected.length === 0 ? range.startLine : range.startLine + selected.length - 1;
  return {
    content: selected.join("\n"),
    range: { startLine: range.startLine, endLine: actualEndLine },
    totalLines: lines.length,
    hasMoreBefore: range.startLine > 1,
    hasMoreAfter: actualEndLine < lines.length,
  };
}

export function returnedRawTextChars(value: string, maxLength: number): number {
  return value.length <= maxLength
    ? value.length
    : utf16SafePrefixLength(value, Math.max(0, maxLength - 1));
}

export async function readLineRange(
  absolutePath: string,
  range: { readonly startLine: number; readonly endLine: number }
): Promise<ReadContentWindow> {
  const stream = createReadStream(absolutePath, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let lineNumber = 0;
  let hasMoreAfter = false;
  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber < range.startLine) {
        continue;
      }
      if (lineNumber > range.endLine) {
        hasMoreAfter = true;
        break;
      }
      lines.push(line);
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  const actualEndLine = lines.length === 0 ? range.startLine : range.startLine + lines.length - 1;
  return {
    content: lines.join("\n"),
    range: { startLine: range.startLine, endLine: actualEndLine },
    totalLines: hasMoreAfter ? undefined : lineNumber,
    hasMoreBefore: range.startLine > 1,
    hasMoreAfter,
  };
}

function countLines(raw: string): number {
  return raw.length === 0 ? 0 : raw.split(/\r?\n/).length;
}
