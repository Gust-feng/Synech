import type { ToolDisplayProjection } from "../../tool-display.js";
import type { ToolFactValue, ToolFileDisplayOperation } from "../../../../domain/tools/index.js";
import { toolDisplayName } from "../../../../domain/tools/index.js";
import {
  asRecord,
  booleanOrUndefined,
  numberOrUndefined,
  stringOrUndefined,
} from "./tool-result-facts.js";

export type ToolDisplayNormalizationInput = {
  readonly toolName: string;
  readonly input?: ToolFactValue;
  readonly output?: ToolFactValue;
};

export function normalizeToolDisplayForOperation(input: ToolDisplayNormalizationInput): ToolDisplayProjection {
  const display = knownToolDisplay(input) ?? rawToolDisplay(input);
  return {
    ...display,
    ...projectToolDisplayResultFacts(input.output),
  };
}

function knownToolDisplay(input: ToolDisplayNormalizationInput): ToolDisplayProjection | undefined {
  if (input.toolName === "AttachmentListFiles") return directoryListingDisplay(input);
  if (input.toolName === "Glob" || input.toolName === "Grep" || input.toolName === "AttachmentSearchFiles") {
    return fileSearchDisplay(input);
  }
  if (input.toolName === "Write" || input.toolName === "Edit") return fileChangeDisplay(input);
  return undefined;
}

function directoryListingDisplay(
  input: ToolDisplayNormalizationInput,
): Extract<ToolDisplayProjection, { readonly kind: "directory_listing" }> {
  const request = asRecord(input.input);
  const output = asRecord(input.output);
  const entries = (Array.isArray(output.entries) ? output.entries : [])
    .map(directoryEntry)
    .filter((entry): entry is NonNullable<ReturnType<typeof directoryEntry>> => entry !== undefined);
  const unreadableSamples = (Array.isArray(output.unreadableSamples) ? output.unreadableSamples : [])
    .map(unreadableDirectory)
    .filter((entry): entry is NonNullable<ReturnType<typeof unreadableDirectory>> => entry !== undefined);
  return {
    kind: "directory_listing",
    path: stringOrUndefined(output.path) ?? stringOrUndefined(request.path),
    unreadableDirectories: numberOrUndefined(output.unreadableDirectories),
    unreadableSamples: unreadableSamples.length === 0 ? undefined : unreadableSamples,
    entries,
  };
}

function directoryEntry(value: unknown): { readonly path: string; readonly kind?: string } | undefined {
  if (typeof value === "string") return { path: value };
  const record = asRecord(value);
  const path = stringOrUndefined(record.path) ?? stringOrUndefined(record.relativePath) ?? stringOrUndefined(record.name);
  return path === undefined ? undefined : { path, kind: stringOrUndefined(record.kind) ?? stringOrUndefined(record.type) };
}

function unreadableDirectory(value: unknown): { readonly path?: string; readonly errorCode?: string } | undefined {
  const record = asRecord(value);
  const path = stringOrUndefined(record.path);
  const errorCode = stringOrUndefined(record.errorCode) ?? stringOrUndefined(record.code);
  return path === undefined && errorCode === undefined ? undefined : { path, errorCode };
}

function fileSearchDisplay(
  input: ToolDisplayNormalizationInput,
): Extract<ToolDisplayProjection, { readonly kind: "file_search_results" }> {
  const request = asRecord(input.input);
  const output = asRecord(input.output);
  const values = Array.isArray(output.matches)
    ? output.matches
    : Array.isArray(output.matchesPreview) ? output.matchesPreview : [];
  const matches = values
    .map(fileSearchMatch)
    .filter((match): match is NonNullable<ReturnType<typeof fileSearchMatch>> => match !== undefined);
  return {
    kind: "file_search_results",
    query: stringOrUndefined(output.query) ?? stringOrUndefined(output.pattern) ??
      stringOrUndefined(request.query) ?? stringOrUndefined(request.pattern),
    path: stringOrUndefined(output.path) ?? stringOrUndefined(request.path),
    skippedUnreadableFiles: numberOrUndefined(output.skippedUnreadableFiles),
    matches,
  };
}

function fileSearchMatch(value: unknown): { readonly path: string; readonly line?: number; readonly preview?: string } | undefined {
  if (typeof value === "string") return { path: value };
  const record = asRecord(value);
  const path = stringOrUndefined(record.path) ?? stringOrUndefined(record.file);
  if (path === undefined) return undefined;
  return {
    path,
    line: numberOrUndefined(record.line) ?? numberOrUndefined(record.lineNumber),
    preview: stringOrUndefined(record.preview) ?? stringOrUndefined(record.text) ?? stringOrUndefined(record.lineText),
  };
}

function fileChangeDisplay(input: ToolDisplayNormalizationInput): ToolDisplayProjection {
  const request = asRecord(input.input);
  const output = asRecord(input.output);
  const path = stringOrUndefined(output.path) ?? stringOrUndefined(request.path);
  const operation = fileDisplayOperation(output.operation) ?? (input.toolName === "Edit" ? "edit" : undefined);
  const preview = diffPreview(output.diff);
  return preview === undefined
    ? { kind: "file_change_summary", path, operation }
    : { kind: "file_diff_preview", path, operation, preview };
}

function fileDisplayOperation(value: unknown): ToolFileDisplayOperation | undefined {
  return value === "create" || value === "write" || value === "append" || value === "edit" || value === "delete"
    ? value
    : undefined;
}

function diffPreview(value: unknown): string | undefined {
  const diff = asRecord(value);
  return diff.status === "available" ? stringOrUndefined(diff.unifiedDiff) : undefined;
}

function rawToolDisplay(
  input: ToolDisplayNormalizationInput,
): Extract<ToolDisplayProjection, { readonly kind: "raw_tool_result" }> {
  return {
    kind: "raw_tool_result",
    toolName: input.toolName,
    label: toolDisplayName(input.toolName),
    value: input.output,
  };
}

export function projectToolDisplayResultFacts(
  output: ToolFactValue | undefined,
): Pick<ToolDisplayProjection, "truncated" | "continuation"> {
  const record = asRecord(output);
  const continuation = asRecord(record.continuation);
  const ref = stringOrUndefined(continuation.ref);
  const note = stringOrUndefined(continuation.note);
  const nextInput = continuation.nextInput as ToolFactValue | undefined;
  return {
    truncated: booleanOrUndefined(record.truncated),
    continuation: ref === undefined && note === undefined && nextInput === undefined
      ? undefined
      : { ref, note, nextInput },
  };
}
