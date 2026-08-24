import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { SandboxPolicy, ToolContinuation, ToolExecutionContext, ToolFactValue } from "../../../domain/tools/index.js";
import { toolResultMessage } from "../../../kernel/intelligence/tool-use-loop-messages.js";
import {
  asRecord,
  authorizedPathFacts,
  decodeUtf8Text,
  isLikelyBinaryPath,
  MAX_LOCAL_WORKSPACE_FILE_BYTES,
  positiveInteger,
  resolveAuthorizedWorkspacePath,
  safeRefToken,
  shouldSkipEntry,
  stringOrFallback,
  throwIfAborted,
  toWorkspaceRelative,
  truncateText,
  type LocalWorkspaceToolOptions,
} from "./local-workspace-common.js";
import { assertSandboxAllowed, sandboxRequest } from "./local-workspace-sandbox.js";
import { listGlobFiles } from "./directory-listing.js";
import {
  DEFAULT_MAX_INLINE_TOOL_RESULT_TOKENS,
  DEFAULT_TARGET_INLINE_TOOL_BODY_TOKENS,
  type ToolOutputTokenCounter,
} from "../tool-output-limits.js";

export const MAX_GLOB_MATCHES = 200;
export const MAX_GLOB_OFFSET = 10_000;
export const MAX_GREP_MATCHES = 80;
export const MAX_GREP_OFFSET = 10_000;

const COLLECTION_ITEMS_JSON_MAX_CHARS = 120_000;
const MAX_GREP_COLLECT_LIMIT = MAX_GREP_OFFSET + MAX_GREP_MATCHES + 1;
const MAX_SKIPPED_SAMPLES = 8;
const RIPGREP_TIMEOUT_MS = 10_000;

export type GrepMatch = { readonly path: string; readonly line: number; readonly preview: string };
export type RipgrepSearchRunner = (request: {
  readonly absolutePath: string;
  readonly rootDirectory: string;
  readonly query: string;
  readonly limit: number;
  readonly abortSignal?: AbortSignal;
}) => Promise<readonly GrepMatch[] | undefined>;

type GrepSkippedReason = "binary" | "too_large" | "unreadable" | "skipped_directory" | "skipped_entry" | "not_file";
type GrepSkippedSample = {
  readonly path: string;
  readonly reason: GrepSkippedReason;
  readonly bytes?: number;
  readonly errorCode?: string;
};
type GrepFacts = {
  searchedFiles: number;
  skippedFiles: number;
  skippedBinaryFiles: number;
  skippedTooLargeFiles: number;
  skippedUnreadableFiles: number;
  skippedDirectories: number;
  skippedOtherEntries: number;
  skippedSamples: GrepSkippedSample[];
  skippedFactsComplete: boolean;
};
type SearchInput = {
  readonly rootDirectory: string;
  readonly value: unknown;
  readonly context: ToolExecutionContext;
  readonly sandboxPolicy: SandboxPolicy;
  readonly pathAuthorization: LocalWorkspaceToolOptions["pathAuthorization"];
  readonly outputTokenCounter?: ToolOutputTokenCounter;
};

export async function globLocalFiles(input: SearchInput): Promise<unknown> {
  throwIfAborted(input.context.abortSignal);
  const record = asRecord(input.value);
  const pattern = stringOrFallback(record.pattern, "");
  if (pattern.length === 0) throw new Error("Glob requires a non-empty pattern.");
  const target = await resolveAuthorizedWorkspacePath(
    input.rootDirectory,
    stringOrFallback(record.path, "."),
    "search",
    input.context,
    input.pathAuthorization,
  );
  const pathFacts = authorizedPathFacts(target);
  assertSandboxAllowed(input.sandboxPolicy, sandboxRequest("search", target.rootDirectory, target.relativePath));
  const stat = await fs.stat(target.absolutePath);
  if (!stat.isDirectory()) throw new Error(`Glob expects a directory path: ${target.relativePath}`);
  const limit = Math.min(MAX_GLOB_MATCHES, positiveInteger(record.limit) ?? MAX_GLOB_MATCHES);
  const offset = boundedOffset(record.offset, MAX_GLOB_OFFSET);
  const collected = await listGlobFiles({
    directory: target.absolutePath,
    pattern,
    collectLimit: offset + limit + 1,
    abortSignal: input.context.abortSignal,
  });
  const page = collected.slice(offset, offset + limit);
  const hasMoreAfter = collected.length > offset + page.length;
  const nextOffset = hasMoreAfter ? offset + page.length : undefined;
  return fitCollectionOutput({
    refId: `workspace:glob:${safeRefToken(pattern)}`,
    path: target.relativePath,
    ...pathFacts,
    pattern,
    matches: page,
    matchesReturned: page.length,
    offset,
    limit,
    truncated: hasMoreAfter,
    nextOffset,
    continuation: globFilesContinuation({ pattern, path: target.absolutePath, offset: nextOffset, limit }),
  }, "Glob", input.outputTokenCounter, input.context.toolCallId);
}

export async function grepLocalFiles(input: SearchInput & {
  readonly ripgrepSearch?: RipgrepSearchRunner | false;
}): Promise<unknown> {
  throwIfAborted(input.context.abortSignal);
  const record = asRecord(input.value);
  const query = stringOrFallback(record.query, "");
  if (query.length === 0) throw new Error("grep requires a non-empty query.");
  const target = await resolveAuthorizedWorkspacePath(
    input.rootDirectory,
    stringOrFallback(record.path, "."),
    "search",
    input.context,
    input.pathAuthorization,
  );
  const pathFacts = authorizedPathFacts(target);
  assertSandboxAllowed(input.sandboxPolicy, sandboxRequest("search", target.rootDirectory, target.relativePath));
  const limit = Math.min(MAX_GREP_MATCHES, positiveInteger(record.limit) ?? MAX_GREP_MATCHES);
  const offset = boundedOffset(record.offset, MAX_GREP_OFFSET);
  const collectLimit = Math.min(MAX_GREP_COLLECT_LIMIT, offset + limit + 1);
  const runner = input.ripgrepSearch === false ? undefined : input.ripgrepSearch ?? searchWithRipgrep;
  const ripgrepMatches = await runner?.({
    absolutePath: target.absolutePath,
    rootDirectory: target.rootDirectory,
    query,
    limit: collectLimit,
    abortSignal: input.context.abortSignal,
  }).catch(() => {
    throwIfAborted(input.context.abortSignal);
    return undefined;
  });
  throwIfAborted(input.context.abortSignal);
  const matches: GrepMatch[] = [];
  let grepFacts: GrepFacts | undefined;
  const engine = ripgrepMatches === undefined ? "js" : "rg";
  if (ripgrepMatches === undefined) {
    grepFacts = createGrepFacts();
    await grepPath(
      target.absolutePath,
      target.rootDirectory,
      query.toLowerCase(),
      collectLimit,
      matches,
      grepFacts,
      input.context.abortSignal,
    );
    throwIfAborted(input.context.abortSignal);
    grepFacts.skippedFactsComplete = matches.length < collectLimit;
  } else matches.push(...ripgrepMatches.slice(0, collectLimit));
  const returnedMatches = jsonBoundedItems(
    matches.slice(offset, offset + limit),
    COLLECTION_ITEMS_JSON_MAX_CHARS,
  );
  const hasMoreAfter = matches.length > offset + returnedMatches.length;
  const rawNextOffset = hasMoreAfter ? offset + returnedMatches.length : undefined;
  const nextOffset = rawNextOffset !== undefined && rawNextOffset <= MAX_GREP_OFFSET ? rawNextOffset : undefined;
  const reachedOffsetCeiling = hasMoreAfter && nextOffset === undefined;
  const observation = {
    refId: `workspace:grep:${target.relativePath}:${safeRefToken(query)}`,
    query,
    path: target.relativePath,
    ...pathFacts,
    engine,
    offset,
    limit,
    maxOffset: MAX_GREP_OFFSET,
    offsetCeiling: MAX_GREP_OFFSET,
    matchesReturned: returnedMatches.length,
    hasMoreAfter,
    reachedOffsetCeiling,
    searchedFiles: grepFacts?.searchedFiles,
    skippedFactsAvailable: grepFacts !== undefined,
    skippedFactsComplete: grepFacts?.skippedFactsComplete,
    skippedFiles: grepFacts?.skippedFiles,
    skippedBinaryFiles: grepFacts?.skippedBinaryFiles,
    skippedTooLargeFiles: grepFacts?.skippedTooLargeFiles,
    skippedUnreadableFiles: grepFacts?.skippedUnreadableFiles,
    skippedDirectories: grepFacts?.skippedDirectories,
    skippedOtherEntries: grepFacts?.skippedOtherEntries,
    skippedSamples: grepFacts?.skippedSamples,
  };
  if (reachedOffsetCeiling) {
    return {
      kind: "tool_call_result",
      result: {
        callId: input.context.toolCallId ?? "Grep",
        toolName: "Grep",
        input: input.value as ToolFactValue,
        output: { ...observation, matchesPreview: returnedMatches, searchComplete: false },
        status: "failed",
        error: "grep found more matches than can be observed within the supported offset range.",
        errorDomain: "runtime_error",
        errorFacts: { code: "grep_offset_limit_reached", retryable: false },
      },
    };
  }
  return fitCollectionOutput({
    ...observation,
    matches: returnedMatches,
    searchComplete: !hasMoreAfter,
    truncated: hasMoreAfter,
    nextOffset,
    continuation: grepFilesContinuation({ query, path: target.absolutePath, limit, nextOffset }),
  }, "Grep", input.outputTokenCounter, input.context.toolCallId);
}

async function grepPath(
  absolutePath: string,
  rootDirectory: string,
  normalizedQuery: string,
  limit: number,
  matches: GrepMatch[],
  facts: GrepFacts,
  abortSignal: AbortSignal | undefined,
  isRoot = true,
): Promise<void> {
  throwIfAborted(abortSignal);
  if (matches.length >= limit) return;
  const stat = await fs.stat(absolutePath).catch((error: unknown) => {
    if (isRoot) throw error;
    recordSkippedFile(facts, rootDirectory, absolutePath, "unreadable", undefined, error);
    return undefined;
  });
  throwIfAborted(abortSignal);
  if (stat === undefined) return;
  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true }).catch((error: unknown) => {
      if (isRoot) throw error;
      recordSkippedDirectory(facts, rootDirectory, absolutePath, "unreadable", error);
      return undefined;
    });
    throwIfAborted(abortSignal);
    if (entries === undefined) return;
    for (const entry of entries) {
      throwIfAborted(abortSignal);
      if (matches.length >= limit) return;
      const childPath = path.join(absolutePath, entry.name);
      if (shouldSkipEntry(entry.name)) {
        if (entry.isDirectory()) recordSkippedDirectory(facts, rootDirectory, childPath, "skipped_directory");
        else if (entry.isFile()) recordSkippedFile(facts, rootDirectory, childPath, "skipped_entry");
        else recordSkippedOtherEntry(facts, rootDirectory, childPath, "skipped_entry");
        continue;
      }
      await grepPath(childPath, rootDirectory, normalizedQuery, limit, matches, facts, abortSignal, false);
    }
    return;
  }
  if (!stat.isFile()) {
    recordSkippedOtherEntry(facts, rootDirectory, absolutePath, "not_file", stat.size);
    return;
  }
  if (stat.size > MAX_LOCAL_WORKSPACE_FILE_BYTES) {
    recordSkippedFile(facts, rootDirectory, absolutePath, "too_large", stat.size);
    return;
  }
  if (isLikelyBinaryPath(absolutePath)) {
    recordSkippedFile(facts, rootDirectory, absolutePath, "binary", stat.size);
    return;
  }
  const rawBytes = await fs.readFile(absolutePath).catch((error: unknown) => {
    recordSkippedFile(facts, rootDirectory, absolutePath, "unreadable", stat.size, error);
    return undefined;
  });
  throwIfAborted(abortSignal);
  if (rawBytes === undefined) return;
  const raw = rawBytes.includes(0) ? undefined : decodeUtf8Text(rawBytes);
  if (raw === undefined) {
    recordSkippedFile(facts, rootDirectory, absolutePath, "binary", stat.size);
    return;
  }
  facts.searchedFiles += 1;
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
    const line = lines[index] ?? "";
    if (line.toLowerCase().includes(normalizedQuery)) {
      matches.push({
        path: toWorkspaceRelative(rootDirectory, absolutePath),
        line: index + 1,
        preview: truncateText(line.trim(), 500),
      });
    }
  }
}

function createGrepFacts(): GrepFacts {
  return {
    searchedFiles: 0,
    skippedFiles: 0,
    skippedBinaryFiles: 0,
    skippedTooLargeFiles: 0,
    skippedUnreadableFiles: 0,
    skippedDirectories: 0,
    skippedOtherEntries: 0,
    skippedSamples: [],
    skippedFactsComplete: true,
  };
}

function recordSkippedFile(
  facts: GrepFacts,
  rootDirectory: string,
  absolutePath: string,
  reason: GrepSkippedReason,
  bytes?: number,
  error?: unknown,
): void {
  facts.skippedFiles += 1;
  if (reason === "binary") facts.skippedBinaryFiles += 1;
  if (reason === "too_large") facts.skippedTooLargeFiles += 1;
  if (reason === "unreadable") facts.skippedUnreadableFiles += 1;
  pushSkippedSample(facts, rootDirectory, absolutePath, reason, bytes, error);
}

function recordSkippedDirectory(
  facts: GrepFacts,
  rootDirectory: string,
  absolutePath: string,
  reason: GrepSkippedReason,
  error?: unknown,
): void {
  facts.skippedDirectories += 1;
  pushSkippedSample(facts, rootDirectory, absolutePath, reason, undefined, error);
}

function recordSkippedOtherEntry(
  facts: GrepFacts,
  rootDirectory: string,
  absolutePath: string,
  reason: GrepSkippedReason,
  bytes?: number,
  error?: unknown,
): void {
  facts.skippedOtherEntries += 1;
  pushSkippedSample(facts, rootDirectory, absolutePath, reason, bytes, error);
}

function pushSkippedSample(
  facts: GrepFacts,
  rootDirectory: string,
  absolutePath: string,
  reason: GrepSkippedReason,
  bytes?: number,
  error?: unknown,
): void {
  if (facts.skippedSamples.length >= MAX_SKIPPED_SAMPLES) return;
  facts.skippedSamples.push({
    path: toWorkspaceRelative(rootDirectory, absolutePath),
    reason,
    bytes,
    errorCode: error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined,
  });
}

function fitCollectionOutput<T extends Readonly<Record<string, unknown>>>(
  output: T,
  toolName: "Glob" | "Grep",
  counter: ToolOutputTokenCounter | undefined,
  callId: string | undefined,
): T {
  if (counter === undefined || modelOutputFits(toolName, output, counter, callId)) return output;
  const items = Array.isArray(output.matches) ? output.matches : [];
  let low = 1;
  let high = items.length;
  let best: T | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const offset = typeof output.offset === "number" ? output.offset : 0;
    const nextOffset = offset + count;
    const maxOffset = toolName === "Glob" ? MAX_GLOB_OFFSET : MAX_GREP_OFFSET;
    if (nextOffset > maxOffset) {
      high = count - 1;
      continue;
    }
    const candidate = {
      ...output,
      matches: items.slice(0, count),
      matchesReturned: count,
      hasMoreAfter: true,
      truncated: true,
      nextOffset,
      continuation: toolName === "Glob"
        ? globFilesContinuation({
            pattern: stringFact(output.pattern, ""),
            path: stringFact(output.path, "."),
            limit: numberFact(output.limit, MAX_GLOB_MATCHES),
            offset: nextOffset,
          })
        : grepFilesContinuation({
            query: stringFact(output.query, ""),
            path: stringFact(output.path, "."),
            limit: numberFact(output.limit, MAX_GREP_MATCHES),
            nextOffset,
          }),
      ...(toolName === "Grep" ? { searchComplete: false } : {}),
    } as T;
    if (modelOutputFits(toolName, candidate, counter, callId)) {
      best = candidate;
      low = count + 1;
    } else high = count - 1;
  }
  if (best === undefined) throw new Error(`${toolName} metadata exceeds the fixed model result budget.`);
  return best;
}

function modelOutputFits(
  toolName: string,
  output: Readonly<Record<string, unknown>>,
  counter: ToolOutputTokenCounter,
  callId: string | undefined,
): boolean {
  if (counter.countText(JSON.stringify(output)) > DEFAULT_TARGET_INLINE_TOOL_BODY_TOKENS) return false;
  const message = toolResultMessage({
    callId: callId ?? toolName,
    toolName,
    input: undefined,
    output: output as ToolFactValue,
    status: "completed",
    durationMs: 0,
  });
  return counter.countText(JSON.stringify(message)) <= DEFAULT_MAX_INLINE_TOOL_RESULT_TOKENS;
}

function boundedOffset(value: unknown, maxOffset: number): number {
  const offset = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  return Math.min(maxOffset, offset);
}

function jsonBoundedItems<T>(items: readonly T[], maxChars: number): readonly T[] {
  const selected: T[] = [];
  for (const item of items) {
    const candidate = [...selected, item];
    if (JSON.stringify(candidate).length > maxChars && selected.length > 0) break;
    selected.push(item);
  }
  return selected;
}

function globFilesContinuation(input: {
  readonly pattern: string;
  readonly path: string;
  readonly limit: number;
  readonly offset?: number;
}): ToolContinuation | undefined {
  return input.offset === undefined
    ? undefined
    : { nextInput: { pattern: input.pattern, path: input.path, limit: input.limit, offset: input.offset } };
}

function grepFilesContinuation(input: {
  readonly query: string;
  readonly path: string;
  readonly limit: number;
  readonly nextOffset?: number;
}): ToolContinuation | undefined {
  return input.nextOffset === undefined
    ? undefined
    : { nextInput: { query: input.query, path: input.path, limit: input.limit, offset: input.nextOffset } };
}

function stringFact(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberFact(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function searchWithRipgrep(request: {
  readonly absolutePath: string;
  readonly rootDirectory: string;
  readonly query: string;
  readonly limit: number;
  readonly abortSignal?: AbortSignal;
}): Promise<readonly GrepMatch[] | undefined> {
  const output = await runRipgrep(request).catch(() => undefined);
  throwIfAborted(request.abortSignal);
  return output === undefined ? undefined : parseRipgrepJson(output, request.rootDirectory, request.limit);
}

function runRipgrep(request: {
  readonly absolutePath: string;
  readonly rootDirectory: string;
  readonly query: string;
  readonly abortSignal?: AbortSignal;
}): Promise<string> {
  const args = [
    "--json", "--fixed-strings", "--ignore-case", "--line-number", "--color=never", "--hidden",
    "--max-filesize", String(MAX_LOCAL_WORKSPACE_FILE_BYTES),
    "--glob", "!node_modules/**", "--glob", "!dist/**", "--glob", "!coverage/**", "--glob", "!.git/**",
    "--", request.query, request.absolutePath,
  ];
  return new Promise((resolve, reject) => {
    execFile("rg", args, {
      cwd: request.rootDirectory,
      timeout: RIPGREP_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 16,
      signal: request.abortSignal,
    }, (error, stdout) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException & { readonly code?: string | number }).code;
        if (String(code) === "1") resolve(String(stdout ?? ""));
        else reject(error);
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

function parseRipgrepJson(value: string, rootDirectory: string, limit: number): readonly GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of value.split(/\r?\n/)) {
    if (matches.length >= limit || line.trim().length === 0) continue;
    const event = asRecord(parseJsonOrUndefined(line));
    if (event.type !== "match") continue;
    const data = asRecord(event.data);
    const pathText = stringOrFallback(asRecord(data.path).text, "");
    const lineNumber = positiveInteger(data.line_number);
    const lineText = stringOrFallback(asRecord(data.lines).text, "");
    if (pathText.length === 0 || lineNumber === undefined) continue;
    matches.push({
      path: toWorkspaceRelative(
        rootDirectory,
        path.isAbsolute(pathText) ? pathText : path.resolve(rootDirectory, pathText),
      ),
      line: lineNumber,
      preview: truncateText(lineText.trim(), 500),
    });
  }
  return matches;
}

function parseJsonOrUndefined(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
