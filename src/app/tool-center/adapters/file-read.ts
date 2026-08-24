import { promises as fs } from "node:fs";

import type { SandboxPolicy, ToolExecutionContext } from "../../../domain/tools/index.js";
import {
  asRecord,
  authorizedPathFacts,
  decodeUtf8Text,
  MAX_LOCAL_WORKSPACE_FILE_BYTES,
  resolveAuthorizedWorkspacePath,
  stringOrFallback,
  throwIfAborted,
  type LocalWorkspaceToolOptions,
} from "./local-workspace-common.js";
import { assertSandboxAllowed, sandboxRequest } from "./local-workspace-sandbox.js";
import type { ToolOutputTokenCounter } from "../tool-output-limits.js";
import {
  charWindowContent,
  fitReadOutput,
  invalidUtf8ReadResult,
  InvalidUtf8TextError,
  parseLineRange,
  readFileContinuation,
  readLineRange,
  readMaxLength,
  readStartChar,
  sliceLines,
  truncateReadFileContent,
  type ReadContentWindow,
} from "./text-window-read.js";

export async function readLocalFile(input: {
  readonly rootDirectory: string;
  readonly value: unknown;
  readonly context: ToolExecutionContext;
  readonly sandboxPolicy: SandboxPolicy;
  readonly pathAuthorization: LocalWorkspaceToolOptions["pathAuthorization"];
  readonly outputTokenCounter?: ToolOutputTokenCounter;
}): Promise<unknown> {
  throwIfAborted(input.context.abortSignal);
  const record = asRecord(input.value);
  const target = await resolveAuthorizedWorkspacePath(
    input.rootDirectory,
    stringOrFallback(record.path, ""),
    "read",
    input.context,
    input.pathAuthorization,
  );
  const pathFacts = authorizedPathFacts(target);
  assertSandboxAllowed(
    input.sandboxPolicy,
    sandboxRequest("read", target.rootDirectory, target.relativePath),
  );
  const stat = await fs.stat(target.absolutePath);
  throwIfAborted(input.context.abortSignal);
  if (!stat.isFile()) throw new Error(`Read expects a file path: ${target.relativePath}`);
  const bytes = stat.size <= MAX_LOCAL_WORKSPACE_FILE_BYTES
    ? await fs.readFile(target.absolutePath, { signal: input.context.abortSignal })
    : undefined;
  const observedSize = bytes?.length ?? stat.size;
  const probe = bytes?.subarray(0, Math.min(bytes.length, 8192)) ?? Buffer.alloc(Math.min(stat.size, 8192));
  if (bytes === undefined) {
    const handle = await fs.open(target.absolutePath, "r");
    try {
      await handle.read(probe, 0, probe.length, 0);
    } finally {
      await handle.close();
    }
  }
  throwIfAborted(input.context.abortSignal);
  if (probe.includes(0)) {
    return {
      refId: `workspace:file:${target.relativePath}`,
      path: target.relativePath,
      ...pathFacts,
      bytes: observedSize,
      binary: true,
    };
  }
  const lineRange = parseLineRange(record);
  const startChar = readStartChar(record.startChar);
  if (lineRange !== undefined && startChar !== undefined) {
    throw new Error("read cannot combine startChar with startLine/endLine.");
  }
  if (lineRange !== undefined && record.maxLength !== undefined) {
    throw new Error("read cannot combine maxLength with startLine/endLine; request a smaller line range instead.");
  }
  if (stat.size > MAX_LOCAL_WORKSPACE_FILE_BYTES && lineRange === undefined) {
    throw new Error(`File is too large to read safely without a line range: ${target.relativePath}`);
  }
  const maxLength = readMaxLength(record.maxLength);
  let content: ReadContentWindow;
  if (stat.size > MAX_LOCAL_WORKSPACE_FILE_BYTES) {
    try {
      content = await readLineRange(target.absolutePath, lineRange!, input.context.abortSignal);
    } catch (error) {
      if (error instanceof InvalidUtf8TextError) {
        return { ...asRecord(invalidUtf8ReadResult(target.relativePath, stat.size)), ...pathFacts };
      }
      throw error;
    }
  } else {
    const raw = decodeUtf8Text(bytes!);
    if (raw === undefined) {
      return { ...asRecord(invalidUtf8ReadResult(target.relativePath, observedSize)), ...pathFacts };
    }
    content = lineRange === undefined
      ? charWindowContent(raw, startChar ?? 0)
      : sliceLines(raw, lineRange);
  }
  throwIfAborted(input.context.abortSignal);
  const returned = truncateReadFileContent(content.content, maxLength);
  if (lineRange !== undefined && returned.truncated) {
    throw new Error("read line range exceeds the text return budget; request fewer lines so the next read does not skip unread text.");
  }
  const returnedTextChars = returned.rawChars;
  const nextStartChar = content.startChar === undefined
    ? undefined
    : content.content.length > returnedTextChars
      ? content.startChar + returnedTextChars
      : content.nextStartChar;
  const hasMoreAfter = content.hasMoreAfter || returned.truncated;
  const nextStartLine = nextStartChar === undefined && hasMoreAfter && content.range !== undefined
    ? content.range.endLine + 1
    : undefined;
  const output = {
    refId: `workspace:file:${target.relativePath}`,
    path: target.relativePath,
    ...pathFacts,
    bytes: observedSize,
    content: returned.text,
    startLine: content.range?.startLine,
    endLine: content.range?.endLine,
    totalLines: content.totalLines,
    hasMoreBefore: content.hasMoreBefore,
    hasMoreAfter,
    startChar: content.startChar,
    textChars: content.startChar === undefined ? undefined : returnedTextChars,
    charCount: content.charCount,
    truncated: hasMoreAfter,
    nextStartChar: nextStartChar ?? (returned.truncated ? returnedTextChars : undefined),
    nextStartLine,
    continuation: readFileContinuation({
      path: target.absolutePath,
      maxLength,
      nextStartChar: nextStartChar ?? (returned.truncated ? returnedTextChars : undefined),
      nextStartLine,
    }),
  };
  return fitReadOutput(
    output,
    input.outputTokenCounter,
    input.context.toolCallId,
    lineRange === undefined ? { path: target.absolutePath, maxLength } : undefined,
  );
}
