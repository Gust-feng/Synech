import { execFile } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { ToolContinuation, ToolExecutor, ToolFactValue } from "../../../domain/tools/index.js";
import {
  asRecord,
  authorizedPathFacts,
  decodeUtf8Text,
  DEFAULT_LOCAL_WORKSPACE_ROOT,
  isLikelyBinaryPath,
  MAX_LOCAL_WORKSPACE_FILE_BYTES,
  optionalSafeIntegerAtLeast,
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
import {
  isUtf16CodeUnitBoundary,
  utf16SafePrefixLength,
} from "../text-window.js";
import {
  DEFAULT_MAX_INLINE_TOOL_CONTENT_JSON_CHARS,
  DEFAULT_MAX_INLINE_TOOL_RESULT_TOKENS,
  DEFAULT_TARGET_INLINE_TOOL_BODY_TOKENS,
  type ToolOutputTokenCounter,
} from "../tool-output-limits.js";
import { toolResultMessage } from "../../../kernel/intelligence/tool-use-loop-messages.js";
import {
  assertSandboxAllowed,
  createLocalWorkspaceSandboxPolicy,
  sandboxRequest,
} from "./local-workspace-sandbox.js";

const DEFAULT_MAX_CHARS = 128_000;
const MIN_CHARACTER_WINDOW_CHARS = 3;
const READ_FILE_CONTENT_JSON_MAX_CHARS = DEFAULT_MAX_INLINE_TOOL_CONTENT_JSON_CHARS;
const MAX_GLOB_MATCHES = 200;
const MAX_GLOB_OFFSET = 10_000;
const COLLECTION_ITEMS_JSON_MAX_CHARS = 120_000;
const MAX_GREP_MATCHES = 80;
const MAX_GREP_OFFSET = 10_000;
const MAX_GREP_COLLECT_LIMIT = MAX_GREP_OFFSET + MAX_GREP_MATCHES + 1;
const MAX_SKIPPED_SAMPLES = 8;
const MAX_READ_LINE_COUNT = 2_000;
const DEFAULT_READ_LINE_COUNT = 200;
const RIPGREP_TIMEOUT_MS = 10_000;

type GrepMatch = { readonly path: string; readonly line: number; readonly preview: string };
type ReadContentWindow = {
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

type ReadFileContinuationSeed = {
  readonly path: string;
  readonly maxLength: number;
};

type GrepSkippedReason =
  | "binary"
  | "too_large"
  | "unreadable"
  | "skipped_directory"
  | "skipped_entry"
  | "not_file";

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

export type LocalWorkspaceReadToolOptions = LocalWorkspaceToolOptions & {
  readonly ripgrepSearch?: RipgrepSearchRunner | false;
  readonly outputTokenCounter?: ToolOutputTokenCounter;
};

export type RipgrepSearchRunner = (request: {
  readonly absolutePath: string;
  readonly rootDirectory: string;
  readonly query: string;
  readonly limit: number;
  readonly abortSignal?: AbortSignal;
}) => Promise<readonly GrepMatch[] | undefined>;

export function createLocalReadFileTool(rootDirectory = DEFAULT_LOCAL_WORKSPACE_ROOT, options: LocalWorkspaceReadToolOptions = {}): ToolExecutor {
  const sandboxPolicy = options.sandboxPolicy ?? createLocalWorkspaceSandboxPolicy();
  return {
    definition: {
      name: "Read",
      description: "Read an authorized local UTF-8 text file by absolute or run-root-relative path. Supports optional 1-based startLine/endLine windows for large or focused reads.",
      metadata: {
        category: "filesystem",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "Absolute or run-root-relative file path." },
          maxLength: { type: "integer", minimum: MIN_CHARACTER_WINDOW_CHARS, maximum: DEFAULT_MAX_CHARS, description: "Maximum characters to return; must be at least 3 so every truncated UTF-16 window can advance." },
          startLine: { type: "integer", minimum: 1, description: "Optional 1-based first line to return." },
          endLine: { type: "integer", minimum: 1, description: "Optional 1-based last line to return. When omitted with startLine, returns a bounded window." },
          startChar: { type: "integer", minimum: 0, description: "Optional zero-based character offset for continuing a truncated text window." },
        },
        required: ["path"],
        allOf: [
          { not: { required: ["startChar", "startLine"] } },
          { not: { required: ["startChar", "endLine"] } },
          { not: { required: ["maxLength", "startLine"] } },
          { not: { required: ["maxLength", "endLine"] } },
        ],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      throwIfAborted(context.abortSignal);
      const record = asRecord(input);
      const target = await resolveAuthorizedWorkspacePath(
        rootDirectory,
        stringOrFallback(record.path, ""),
        "read",
        context,
        options.pathAuthorization,
      );
      const pathFacts = authorizedPathFacts(target);
      assertSandboxAllowed(sandboxPolicy, sandboxRequest("read", target.rootDirectory, target.relativePath));
      const stat = await fs.stat(target.absolutePath);
      throwIfAborted(context.abortSignal);
      if (!stat.isFile()) {
        throw new Error(`Read expects a file path: ${target.relativePath}`);
      }
      const bytes = stat.size <= MAX_LOCAL_WORKSPACE_FILE_BYTES
        ? await fs.readFile(target.absolutePath, { signal: context.abortSignal })
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
      throwIfAborted(context.abortSignal);
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
      const startChar = optionalSafeIntegerAtLeast(record.startChar, "read startChar", 0);
      if (lineRange !== undefined && startChar !== undefined) {
        throw new Error("read cannot combine startChar with startLine/endLine.");
      }
      if (lineRange !== undefined && record.maxLength !== undefined) {
        throw new Error("read cannot combine maxLength with startLine/endLine; request a smaller line range instead.");
      }
      if (stat.size > MAX_LOCAL_WORKSPACE_FILE_BYTES && lineRange === undefined) {
        throw new Error(`File is too large to read safely without a line range: ${target.relativePath}`);
      }
      const maxLength = optionalSafeIntegerAtLeast(
        record.maxLength,
        "read maxLength",
        MIN_CHARACTER_WINDOW_CHARS,
      ) ?? DEFAULT_MAX_CHARS;
      let content: ReadContentWindow;
      if (stat.size > MAX_LOCAL_WORKSPACE_FILE_BYTES) {
        try {
          content = await readLineRange(target.absolutePath, lineRange!, context.abortSignal);
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
      throwIfAborted(context.abortSignal);
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
          // Continuation inputs get replayed by the model, and a multi-root Space rejects
          // relative paths, so echo back the absolute path the caller can actually reuse.
          path: target.absolutePath,
          maxLength,
          nextStartChar: nextStartChar ?? (returned.truncated ? returnedTextChars : undefined),
          nextStartLine,
        }),
      };
      return fitReadOutput(
        output,
        options.outputTokenCounter,
        context.toolCallId,
        lineRange === undefined
          ? { path: target.absolutePath, maxLength }
          : undefined,
      );
    },
  };
}

export function createLocalGlobTool(rootDirectory = DEFAULT_LOCAL_WORKSPACE_ROOT, options: LocalWorkspaceReadToolOptions = {}): ToolExecutor {
  const sandboxPolicy = options.sandboxPolicy ?? createLocalWorkspaceSandboxPolicy();
  return {
    definition: {
      name: "Glob",
      description: "Find authorized local files recursively by glob pattern. Use patterns such as * or **/* to inspect directory contents, and Grep for file content.",
      metadata: {
        category: "filesystem",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", minLength: 1, description: "File glob such as **/*.ts or src/*.{js,ts}." },
          path: { type: "string", description: "Absolute or run-root-relative directory to search. Defaults to the run root." },
          limit: { type: "integer", minimum: 1, maximum: MAX_GLOB_MATCHES, description: "Maximum matching paths to return." },
          offset: { type: "integer", minimum: 0, maximum: MAX_GLOB_OFFSET, description: "Zero-based match offset for continuation." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      throwIfAborted(context.abortSignal);
      const record = asRecord(input);
      const pattern = stringOrFallback(record.pattern, "");
      if (pattern.length === 0) throw new Error("Glob requires a non-empty pattern.");
      const target = await resolveAuthorizedWorkspacePath(
        rootDirectory,
        stringOrFallback(record.path, "."),
        "search",
        context,
        options.pathAuthorization,
      );
      const pathFacts = authorizedPathFacts(target);
      assertSandboxAllowed(sandboxPolicy, sandboxRequest("search", target.rootDirectory, target.relativePath));
      const stat = await fs.stat(target.absolutePath);
      if (!stat.isDirectory()) throw new Error(`Glob expects a directory path: ${target.relativePath}`);
      const limit = Math.min(MAX_GLOB_MATCHES, positiveInteger(record.limit) ?? MAX_GLOB_MATCHES);
      const offset = boundedOffset(record.offset, MAX_GLOB_OFFSET);
      const collected = await globFiles(target.absolutePath, globPatternRegExp(pattern), offset + limit + 1, context.abortSignal);
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
        continuation: nextOffset === undefined ? undefined : {
          nextInput: { pattern, path: target.absolutePath, offset: nextOffset, limit },
        },
      }, "matches", "Glob", options.outputTokenCounter, context.toolCallId);
    },
  };
}

export function createLocalGrepFilesTool(rootDirectory = DEFAULT_LOCAL_WORKSPACE_ROOT, options: LocalWorkspaceReadToolOptions = {}): ToolExecutor {
  const sandboxPolicy = options.sandboxPolicy ?? createLocalWorkspaceSandboxPolicy();
  const ripgrepSearch = options.ripgrepSearch === false ? undefined : options.ripgrepSearch ?? searchWithRipgrep;
  return {
    definition: {
      name: "Grep",
      description: "Search authorized local text files for a plain-text query. Uses ripgrep when available, with a JS recursive fallback.",
      metadata: {
        category: "filesystem",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "Plain-text query to search for, case-insensitive." },
          path: { type: "string", description: "Absolute or run-root-relative directory or file path. Defaults to the run root." },
          limit: { type: "integer", minimum: 1, maximum: MAX_GREP_MATCHES, description: "Maximum matches to return." },
          offset: { type: "integer", minimum: 0, maximum: MAX_GREP_OFFSET, description: "Zero-based match offset used to continue a truncated search." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      throwIfAborted(context.abortSignal);
      const record = asRecord(input);
      const query = stringOrFallback(record.query, "");
      if (query.length === 0) {
        throw new Error("grep requires a non-empty query.");
      }
      const target = await resolveAuthorizedWorkspacePath(
        rootDirectory,
        stringOrFallback(record.path, "."),
        "search",
        context,
        options.pathAuthorization,
      );
      const pathFacts = authorizedPathFacts(target);
      assertSandboxAllowed(sandboxPolicy, sandboxRequest("search", target.rootDirectory, target.relativePath));
      const limit = Math.min(MAX_GREP_MATCHES, positiveInteger(record.limit) ?? MAX_GREP_MATCHES);
      const offset = boundedOffset(record.offset, MAX_GREP_OFFSET);
      const collectLimit = Math.min(MAX_GREP_COLLECT_LIMIT, offset + limit + 1);
      const ripgrepMatches = await ripgrepSearch?.({
        absolutePath: target.absolutePath,
        rootDirectory: target.rootDirectory,
        query,
        limit: collectLimit,
        abortSignal: context.abortSignal,
      }).catch(() => {
        throwIfAborted(context.abortSignal);
        return undefined;
      });
      throwIfAborted(context.abortSignal);
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
          context.abortSignal,
        );
        throwIfAborted(context.abortSignal);
        grepFacts.skippedFactsComplete = matches.length < collectLimit;
      } else {
        matches.push(...ripgrepMatches.slice(0, collectLimit));
      }
      const returnedMatches = jsonBoundedItems(
        matches.slice(offset, offset + limit),
        COLLECTION_ITEMS_JSON_MAX_CHARS
      );
      const hasMoreAfter = matches.length > offset + returnedMatches.length;
      const rawNextOffset = hasMoreAfter ? offset + returnedMatches.length : undefined;
      const nextOffset = rawNextOffset !== undefined && rawNextOffset <= MAX_GREP_OFFSET
        ? rawNextOffset
        : undefined;
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
            callId: context.toolCallId ?? "Grep",
            toolName: "Grep",
            input: input as ToolFactValue,
            output: {
              ...observation,
              matchesPreview: returnedMatches,
              searchComplete: false,
            },
            status: "failed",
            error: "grep found more matches than can be observed within the supported offset range.",
            errorDomain: "runtime_error",
            errorFacts: {
              code: "grep_offset_limit_reached",
              retryable: false,
            },
          },
        };
      }
      const output = {
        ...observation,
        matches: returnedMatches,
        searchComplete: !hasMoreAfter,
        truncated: hasMoreAfter,
        nextOffset,
        continuation: grepFilesContinuation({
          query,
          path: target.absolutePath,
          limit,
          nextOffset,
        }),
      };
      return fitCollectionOutput(output, "matches", "Grep", options.outputTokenCounter, context.toolCallId);
    },
  };
}

function readFileContinuation(input: {
  readonly path: string;
  readonly maxLength: number;
  readonly nextStartChar?: number;
  readonly nextStartLine?: number;
}): ToolContinuation | undefined {
  if (input.nextStartChar !== undefined) {
    return {
      nextInput: {
        path: input.path,
        maxLength: input.maxLength,
        startChar: input.nextStartChar,
      },
    };
  }
  if (input.nextStartLine !== undefined) {
    return {
      nextInput: {
        path: input.path,
        startLine: input.nextStartLine,
      },
    };
  }
  return undefined;
}

function globFilesContinuation(input: {
  readonly pattern: string;
  readonly path: string;
  readonly limit: number;
  readonly nextOffset?: number;
}): ToolContinuation | undefined {
  return input.nextOffset === undefined
    ? undefined
    : {
        nextInput: {
          pattern: input.pattern,
          path: input.path,
          limit: input.limit,
          offset: input.nextOffset,
        },
      };
}

function grepFilesContinuation(input: {
  readonly query: string;
  readonly path: string;
  readonly limit: number;
  readonly nextOffset?: number;
}): ToolContinuation | undefined {
  return input.nextOffset === undefined
    ? undefined
    : {
        nextInput: {
          query: input.query,
          path: input.path,
          limit: input.limit,
          offset: input.nextOffset,
        },
      };
}

function fitReadOutput<T extends Readonly<Record<string, unknown>> & { readonly content: string }>(
  output: T,
  counter: ToolOutputTokenCounter | undefined,
  callId: string | undefined,
  continuationSeed: ReadFileContinuationSeed | undefined,
): T {
  if (counter === undefined || modelOutputFits("Read", output, counter, callId)) return output;
  if (continuationSeed === undefined) {
    throw new Error("read line-range output exceeds the fixed model result budget; request fewer lines.");
  }
  // `truncateReadFileContent` may already have appended a display ellipsis.
  // `textChars` is the authoritative raw UTF-16 prefix length; never count
  // that marker as source content when calculating the replay cursor.
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
        ? readFileContinuation({
            ...continuationSeed,
            nextStartChar: startChar + length,
          })
        : undefined,
    } as T;
    if (length > 0 && modelOutputFits("Read", candidate, counter, callId)) {
      best = candidate;
      low = requestedLength + 1;
    } else {
      high = requestedLength - 1;
    }
  }
  if (best === undefined) throw new Error("read metadata exceeds the fixed model result budget.");
  return best;
}

async function globFiles(
  directory: string,
  pattern: RegExp,
  collectLimit: number,
  abortSignal: AbortSignal | undefined,
  prefix = "",
  output: string[] = [],
): Promise<readonly string[]> {
  if (output.length >= collectLimit) return output;
  throwIfAborted(abortSignal);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (output.length >= collectLimit) break;
    throwIfAborted(abortSignal);
    if (shouldSkipEntry(entry.name)) continue;
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await globFiles(path.join(directory, entry.name), pattern, collectLimit, abortSignal, relative, output);
    } else if (entry.isFile() && pattern.test(relative)) {
      output.push(relative);
    }
  }
  return output;
}

function globPatternRegExp(pattern: string): RegExp {
  const alternatives = expandGlobBraces(pattern.replaceAll("\\", "/"));
  const sources = alternatives.map((value) => {
    let source = "";
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]!;
      if (character === "*" && value[index + 1] === "*") {
        if (value[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else if (character === "*") {
        source += "[^/]*";
      } else if (character === "?") {
        source += "[^/]";
      } else {
        source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
      }
    }
    return source;
  });
  return new RegExp(`^(?:${sources.join("|")})$`);
}

function expandGlobBraces(pattern: string): readonly string[] {
  const match = /\{([^{}]+)\}/.exec(pattern);
  if (match === null || match.index === undefined) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return match[1]!.split(",").flatMap((choice) => expandGlobBraces(`${before}${choice}${after}`));
}

function fitCollectionOutput<T extends Readonly<Record<string, unknown>>>(
  output: T,
  collectionKey: "matches",
  toolName: "Glob" | "Grep",
  counter: ToolOutputTokenCounter | undefined,
  callId: string | undefined,
): T {
  if (counter === undefined || modelOutputFits(toolName, output, counter, callId)) {
    return output;
  }
  const items = Array.isArray(output[collectionKey]) ? output[collectionKey] : [];
  let low = 1;
  let high = items.length;
  let best: T | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const offset = typeof output.offset === "number" ? output.offset : 0;
    const nextOffset = offset + count;
    const maxOffset = toolName === "Glob" ? MAX_GLOB_OFFSET : MAX_GREP_OFFSET;
    if (nextOffset > maxOffset) {
      // A producer page at the grep offset ceiling may still need to be split
      // for the model envelope. Do not manufacture a replay input that the
      // executor will clamp back to the same ceiling and repeat a page.
      high = count - 1;
      continue;
    }
    const candidate = {
      ...output,
      [collectionKey]: items.slice(0, count),
      matchesReturned: count,
      hasMoreAfter: true,
      truncated: true,
      nextOffset,
      continuation: toolName === "Glob"
        ? globFilesContinuation({
            pattern: stringFact(output.pattern, ""),
            path: stringFact(output.path, "."),
            limit: numberFact(output.limit, MAX_GLOB_MATCHES),
            nextOffset,
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
    } else {
      high = count - 1;
    }
  }
  if (best === undefined) throw new Error(`${toolName} metadata exceeds the fixed model result budget.`);
  return best;
}

function stringFact(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberFact(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

function jsonBoundedItems<T>(items: readonly T[], maxChars: number): readonly T[] {
  const selected: T[] = [];
  for (const item of items) {
    const candidate = [...selected, item];
    if (JSON.stringify(candidate).length > maxChars && selected.length > 0) {
      break;
    }
    selected.push(item);
  }
  return selected;
}

async function grepPath(
  absolutePath: string,
  rootDirectory: string,
  normalizedQuery: string,
  limit: number,
  matches: GrepMatch[],
  facts: GrepFacts,
  abortSignal: AbortSignal | undefined,
  isRoot = true
): Promise<void> {
  throwIfAborted(abortSignal);
  if (matches.length >= limit) {
    return;
  }
  const stat = await fs.stat(absolutePath).catch((error: unknown) => {
    if (isRoot) {
      throw error;
    }
    recordSkippedFile(facts, rootDirectory, absolutePath, "unreadable", undefined, error);
    return undefined;
  });
  throwIfAborted(abortSignal);
  if (stat === undefined) {
    return;
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true }).catch((error: unknown) => {
      if (isRoot) {
        throw error;
      }
      recordSkippedDirectory(facts, rootDirectory, absolutePath, "unreadable", error);
      return undefined;
    });
    throwIfAborted(abortSignal);
    if (entries === undefined) {
      return;
    }
    for (const entry of entries) {
      throwIfAborted(abortSignal);
      if (matches.length >= limit) {
        return;
      }
      const childPath = path.join(absolutePath, entry.name);
      if (shouldSkipEntry(entry.name)) {
        if (entry.isDirectory()) {
          recordSkippedDirectory(facts, rootDirectory, childPath, "skipped_directory");
        } else if (entry.isFile()) {
          recordSkippedFile(facts, rootDirectory, childPath, "skipped_entry");
        } else {
          recordSkippedOtherEntry(facts, rootDirectory, childPath, "skipped_entry");
        }
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
  if (rawBytes === undefined) {
    return;
  }
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
  error?: unknown
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
  error?: unknown
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
  error?: unknown
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
  error?: unknown
): void {
  if (facts.skippedSamples.length >= MAX_SKIPPED_SAMPLES) {
    return;
  }
  facts.skippedSamples.push({
    path: toWorkspaceRelative(rootDirectory, absolutePath),
    reason,
    bytes,
    errorCode: nodeErrorCode(error),
  });
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function parseLineRange(record: Readonly<Record<string, unknown>>): { readonly startLine: number; readonly endLine: number } | undefined {
  const startLine = positiveInteger(record.startLine);
  const explicitEndLine = positiveInteger(record.endLine);
  if (startLine === undefined && explicitEndLine === undefined) {
    return undefined;
  }
  const start = startLine ?? 1;
  const end = explicitEndLine ?? start + DEFAULT_READ_LINE_COUNT - 1;
  if (end < start) {
    throw new Error("read endLine must be greater than or equal to startLine.");
  }
  if (end - start + 1 > MAX_READ_LINE_COUNT) {
    throw new Error(`read line range is too large; request at most ${MAX_READ_LINE_COUNT} lines at a time.`);
  }
  return { startLine: start, endLine: end };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function boundedOffset(value: unknown, maxOffset: number): number {
  return Math.min(maxOffset, nonNegativeInteger(value) ?? 0);
}

function charWindowContent(raw: string, requestedStartChar: number): ReadContentWindow {
  if (requestedStartChar > raw.length) {
    throw new Error(`read startChar ${requestedStartChar} exceeds charCount ${raw.length}.`);
  }
  const startChar = requestedStartChar;
  if (!isUtf16CodeUnitBoundary(raw, startChar)) {
    throw new Error("read startChar must not split a UTF-16 surrogate pair.");
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

function sliceLines(
  raw: string,
  range: { readonly startLine: number; readonly endLine: number }
): ReadContentWindow {
  const lines = textLinesPreservingEndings(raw);
  const selected = lines.slice(range.startLine - 1, range.endLine);
  const actualEndLine = selected.length === 0 ? range.startLine : range.startLine + selected.length - 1;
  return {
    content: selected.map((line, index) =>
      index === selected.length - 1 ? line.text : `${line.text}${line.ending}`
    ).join(""),
    range: { startLine: range.startLine, endLine: actualEndLine },
    totalLines: lines.length,
    hasMoreBefore: range.startLine > 1,
    hasMoreAfter: actualEndLine < lines.length,
  };
}

function truncateReadFileContent(value: string, maxLength: number): {
  readonly text: string;
  readonly rawChars: number;
  readonly truncated: boolean;
} {
  if (value.length <= maxLength && JSON.stringify(value).length <= READ_FILE_CONTENT_JSON_MAX_CHARS) {
    return { text: value, rawChars: value.length, truncated: false };
  }

  const maxRawChars = Math.max(0, Math.min(value.length, maxLength - 1));
  let low = 0;
  let high = maxRawChars;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${value.slice(0, middle)}…`;
    if (JSON.stringify(candidate).length <= READ_FILE_CONTENT_JSON_MAX_CHARS) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const rawChars = utf16SafePrefixLength(value, low);
  return {
    text: `${value.slice(0, rawChars)}…`,
    rawChars,
    truncated: true,
  };
}

function countLines(raw: string): number {
  return textLinesPreservingEndings(raw).length;
}

async function readLineRange(
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
    if (lineNumber >= range.startLine && lineNumber <= range.endLine) {
      lines.push(line);
    }
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
        if (boundary === undefined) {
          break;
        }
        const line = {
          text: pending.slice(0, boundary.index),
          ending: pending.slice(boundary.index, boundary.index + boundary.length),
        };
        pending = pending.slice(boundary.index + boundary.length);
        endedWithLineEnding = pending.length === 0;
        if (acceptLine(line)) {
          break streamLoop;
        }
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
        if (boundary === undefined) {
          break;
        }
        const line = {
          text: pending.slice(0, boundary.index),
          ending: pending.slice(boundary.index, boundary.index + boundary.length),
        };
        pending = pending.slice(boundary.index + boundary.length);
        endedWithLineEnding = pending.length === 0;
        if (acceptLine(line)) {
          break;
        }
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
      index === lines.length - 1 ? line.text : `${line.text}${line.ending}`
    ).join(""),
    range: { startLine: range.startLine, endLine: actualEndLine },
    totalLines: hasMoreAfter ? undefined : lineNumber,
    hasMoreBefore: range.startLine > 1,
    hasMoreAfter,
  };
}

type TextLine = {
  readonly text: string;
  readonly ending: string;
};

class InvalidUtf8TextError extends Error {
  constructor() {
    super("File is not valid UTF-8 text.");
    this.name = "InvalidUtf8TextError";
  }
}

function invalidUtf8ReadResult(relativePath: string, bytes: number): ToolFactValue {
  return {
    refId: `workspace:file:${relativePath}`,
    path: relativePath,
    bytes,
    binary: true,
    reason: "invalid_utf8",
  };
}

function textLinesPreservingEndings(raw: string): readonly TextLine[] {
  if (raw.length === 0) {
    return [];
  }
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
    if (value[index] === "\n") {
      return { index, length: 1 };
    }
    if (value[index] !== "\r") {
      continue;
    }
    if (index + 1 < value.length) {
      return { index, length: value[index + 1] === "\n" ? 2 : 1 };
    }
    return final ? { index, length: 1 } : undefined;
  }
  return undefined;
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
  if (output === undefined) {
    return undefined;
  }
  return parseRipgrepJson(output, request.rootDirectory, request.limit);
}

async function runRipgrep(request: {
  readonly absolutePath: string;
  readonly rootDirectory: string;
  readonly query: string;
  readonly abortSignal?: AbortSignal;
}): Promise<string> {
  const args = [
    "--json",
    "--fixed-strings",
    "--ignore-case",
    "--line-number",
    "--color=never",
    "--hidden",
    "--max-filesize",
    String(MAX_LOCAL_WORKSPACE_FILE_BYTES),
    "--glob",
    "!node_modules/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!coverage/**",
    "--glob",
    "!.git/**",
    "--",
    request.query,
    request.absolutePath,
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
        if (String(code) === "1") {
          resolve(String(stdout ?? ""));
          return;
        }
        reject(error);
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

function parseRipgrepJson(value: string, rootDirectory: string, limit: number): readonly GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of value.split(/\r?\n/)) {
    if (matches.length >= limit || line.trim().length === 0) {
      continue;
    }
    const event = asRecord(parseJsonOrUndefined(line));
    if (event.type !== "match") {
      continue;
    }
    const data = asRecord(event.data);
    const pathText = stringOrFallback(asRecord(data.path).text, "");
    const lineNumber = positiveInteger(data.line_number);
    const lineText = stringOrFallback(asRecord(data.lines).text, "");
    if (pathText.length === 0 || lineNumber === undefined) {
      continue;
    }
    matches.push({
      path: toWorkspaceRelative(rootDirectory, path.isAbsolute(pathText) ? pathText : path.resolve(rootDirectory, pathText)),
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