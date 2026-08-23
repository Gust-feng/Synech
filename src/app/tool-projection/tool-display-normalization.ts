import { stringOrUndefined } from "../../kernel/values/index.js";
import type { ToolDisplayProjection } from "../panel-api/tool-display.js";
import type { ToolFactValue, ToolFileDisplayOperation } from "../../domain/tools/index.js";
import { toolDisplayName } from "../../domain/tools/index.js";

export type ToolDisplayNormalizationInput = {
  readonly toolName: string;
  readonly input?: ToolFactValue;
  readonly output?: ToolFactValue;
};

export function normalizeToolDisplayForOperation(input: ToolDisplayNormalizationInput): ToolDisplayProjection {
  return {
    ...normalizeToolDisplayCore(input),
    ...projectToolDisplayResultFacts(input.output),
  };
}

function normalizeToolDisplayCore(input: ToolDisplayNormalizationInput): ToolDisplayProjection {
  const structuredDisplay = structuredToolDisplayForOperation(input);
  if (structuredDisplay !== undefined) {
    return structuredDisplay;
  }
  const externalSourceDisplay = externalSourceDisplayForOperation(input);
  if (externalSourceDisplay !== undefined) {
    return externalSourceDisplay;
  }
  const fileGroupDisplay = fileChangeGroupDisplayForOperation(input);
  if (fileGroupDisplay !== undefined) {
    return fileGroupDisplay;
  }
  const fileDisplay = fileToolDisplayForOperation(input);
  if (fileDisplay !== undefined) {
    return fileDisplay;
  }
  return genericToolDisplayForOperation(input);
}

function fileChangeGroupDisplayForOperation(
  input: ToolDisplayNormalizationInput,
): Extract<ToolDisplayProjection, { readonly kind: "file_change_group" }> | undefined {
  const output = asRecord(input.output);
  const candidates = Array.isArray(output.files)
    ? output.files
    : Array.isArray(output.changes)
      ? output.changes
      : undefined;
  if (candidates === undefined || candidates.length < 2) {
    return undefined;
  }
  const files = candidates
    .map(fileChangeGroupItem)
    .filter((item): item is NonNullable<ReturnType<typeof fileChangeGroupItem>> => item !== undefined);
  if (files.length < 2) {
    return undefined;
  }
  return {
    kind: "file_change_group",
    files,
  };
}

function fileChangeGroupItem(value: unknown): {
  readonly path: string;
  readonly operation?: ToolFileDisplayOperation;
  readonly preview?: string;
} | undefined {
  const item = asRecord(value);
  const path = stringOrUndefined(item.path);
  if (path === undefined) {
    return undefined;
  }
  const canonicalDiff = canonicalEditFileDiffPreview(item.diff);
  const preview = canonicalDiff ?? compactDiffPreview(stringOrUndefined(item.preview));
  return {
    path,
    operation: fileDisplayOperationOrUndefined(item.operation) ?? (canonicalDiff === undefined ? undefined : "edit"),
    preview: preview?.text,
  };
}

function structuredToolDisplayForOperation(input: ToolDisplayNormalizationInput): ToolDisplayProjection | undefined {
  const toolName = input.toolName.trim().toLowerCase();
  const output = asRecord(input.output);
  const inputRecord = asRecord(input.input);
  if (isDirectoryListingTool(toolName)) {
    const entries = (Array.isArray(output.entries) ? output.entries : [])
      .map(directoryEntryDisplayItem)
      .filter((item): item is NonNullable<ReturnType<typeof directoryEntryDisplayItem>> => item !== undefined);
    return {
      kind: "directory_listing",
      path: stringOrUndefined(output.path) ?? stringOrUndefined(inputRecord.path),
      unreadableDirectories: numberOrUndefined(output.unreadableDirectories),
      unreadableSamples: Array.isArray(output.unreadableSamples)
        ? output.unreadableSamples
          .map(unreadableDirectorySample)
          .filter((item): item is NonNullable<ReturnType<typeof unreadableDirectorySample>> => item !== undefined)
        : undefined,
      entries,
    };
  }
  if (isFileSearchTool(toolName)) {
    const matches = (Array.isArray(output.matches) ? output.matches : [])
      .map(fileSearchMatchDisplayItem)
      .filter((item): item is NonNullable<ReturnType<typeof fileSearchMatchDisplayItem>> => item !== undefined);
    return {
      kind: "file_search_results",
      query: stringOrUndefined(output.query) ?? stringOrUndefined(output.pattern) ??
        stringOrUndefined(inputRecord.query) ?? stringOrUndefined(inputRecord.pattern),
      path: stringOrUndefined(output.path) ?? stringOrUndefined(inputRecord.path),
      skippedUnreadableFiles: numberOrUndefined(output.skippedUnreadableFiles),
      matches,
    };
  }
  return undefined;
}

type ExternalSourceDisplayItem = {
  readonly title: string;
  readonly url: string;
  readonly source?: string;
};

function externalSourceDisplayForOperation(input: ToolDisplayNormalizationInput): ToolDisplayProjection | undefined {
  const sources = externalSourcesFromValue(input.output);
  if (sources.length === 0) {
    return undefined;
  }
  const request = asRecord(input.input);
  const query = stringOrUndefined(request.query) ?? stringOrUndefined(request.searchQuery);
  if (query !== undefined || sources.length > 1) {
    return {
      kind: "search_results",
      query,
      results: sources,
    };
  }
  const source = sources[0];
  return {
    kind: "read_result",
    title: source?.title,
    url: source?.url,
    uri: source?.url,
  };
}

function externalSourcesFromValue(value: unknown, depth = 0): readonly ExternalSourceDisplayItem[] {
  if (depth > 4) {
    return [];
  }
  if (typeof value === "string") {
    return externalSourcesFromText(value);
  }
  if (Array.isArray(value)) {
    return uniqueExternalSources(value.flatMap((item) => externalSourcesFromValue(item, depth + 1)));
  }
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return [];
  }

  const directUrl = externalHttpUrl(
    stringOrUndefined(record.url) ??
    stringOrUndefined(record.uri) ??
    stringOrUndefined(record.href) ??
    stringOrUndefined(record.link),
  );
  const direct = directUrl === undefined
    ? []
    : [externalSourceItem(
        stringOrUndefined(record.title) ?? stringOrUndefined(record.name),
        directUrl,
      )];
  const nested = [
    record.results,
    record.items,
    record.sources,
    record.data,
    record.structuredContent,
    record.content,
    record.text,
    record.resource,
  ].flatMap((item) => externalSourcesFromValue(item, depth + 1));
  return uniqueExternalSources([...direct, ...nested]);
}

function externalSourcesFromText(value: string): readonly ExternalSourceDisplayItem[] {
  const text = value.replace(/\r\n?/g, "\n");
  const sources: ExternalSourceDisplayItem[] = [];
  const titleBlocks = text.split(/(?=^\s*Title\s*:)/gimu);
  for (const block of titleBlocks) {
    const title = lineField(block, "Title");
    const url = externalHttpUrl(lineField(block, "URL"));
    if (url !== undefined) {
      sources.push(externalSourceItem(title, url));
    }
  }

  const markdownLinkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/giu;
  for (const match of text.matchAll(markdownLinkPattern)) {
    const url = externalHttpUrl(match[2]);
    if (url !== undefined) {
      sources.push(externalSourceItem(match[1], url));
    }
  }

  const urlPattern = /https?:\/\/[^\s<>"']+/giu;
  for (const match of text.matchAll(urlPattern)) {
    const url = externalHttpUrl(match[0]);
    if (url === undefined) {
      continue;
    }
    const line = text.slice(text.lastIndexOf("\n", match.index ?? 0) + 1, text.indexOf("\n", match.index ?? 0) === -1 ? text.length : text.indexOf("\n", match.index ?? 0));
    const candidate = line.replace(match[0], " ");
    sources.push(externalSourceItem(candidate, url));
  }
  return uniqueExternalSources(sources);
}

function lineField(text: string, field: string): string | undefined {
  const match = new RegExp(`^\\s*${field}\\s*:\\s*(.+)$`, "imu").exec(text);
  return stringOrUndefined(match?.[1]);
}

function externalSourceItem(title: string | undefined, url: string): ExternalSourceDisplayItem {
  const source = externalSourceHost(url);
  return {
    title: cleanExternalSourceTitle(title, url) ?? source ?? url,
    url,
    source,
  };
}

function cleanExternalSourceTitle(value: string | undefined, url: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const title = value
    .replace(url, " ")
    .replace(/^\s*(?:Title|URL)\s*:\s*/iu, "")
    .replace(/^\s*#+\s*/u, "")
    .replace(/[\s|·:：\-–—]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return title.length === 0 || title.length > 280 ? undefined : title;
}

function externalHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const candidate = value.replace(/[),.;，。；]+$/u, "");
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function externalSourceHost(value: string): string | undefined {
  try {
    return new URL(value).hostname.replace(/^www\./u, "") || undefined;
  } catch {
    return undefined;
  }
}

function uniqueExternalSources(values: readonly ExternalSourceDisplayItem[]): readonly ExternalSourceDisplayItem[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.url)) {
      return false;
    }
    seen.add(value.url);
    return true;
  });
}

function isDirectoryListingTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === "list" ||
    normalized === "list_files" ||
    normalized === "attachmentlistfiles" ||
    normalized === "attachmentinspectarchive";
}

function isFileSearchTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === "glob" || normalized === "grep" ||
    normalized === "attachmentsearchfiles";
}

function fileToolDisplayForOperation(
  input: ToolDisplayNormalizationInput
): ToolDisplayProjection | undefined {
  const toolName = input.toolName.trim().toLowerCase();
  const inputRecord = asRecord(input.input);
  const outputRecord = asRecord(input.output);
  const operation = fileOperationKind(toolName, inputRecord, outputRecord);
  if (operation === undefined) {
    return undefined;
  }
  const path = stringOrUndefined(outputRecord.path) ??
    stringOrUndefined(inputRecord.path);
  if (path === undefined) {
    return undefined;
  }
  if (operation.kind === "edit") {
    return fileDiffDisplay(inputRecord, outputRecord, operation.operation);
  }
  return fileChangeDisplay(input, inputRecord, outputRecord, operation.operation);
}

function fileChangeDisplay(
  input: ToolDisplayNormalizationInput,
  inputRecord: Readonly<Record<string, unknown>>,
  outputRecord: Readonly<Record<string, unknown>>,
  operation: ToolFileDisplayOperation
): ToolDisplayProjection {
  const content = stringOrUndefined(inputRecord.content);
  const allowDerivedPreview = isBuiltInFileToolName(input.toolName);
  const preview = operation === "delete" || !allowDerivedPreview
    ? undefined
    : fileWriteDiffPreview({
        content,
        mode: operation === "create" ? "create" : operation === "append" ? "append" : "write",
      });
  return {
    kind: "file_change_summary",
    path: stringOrUndefined(outputRecord.path) ?? stringOrUndefined(inputRecord.path),
    operation,
    preview: allowDerivedPreview ? stringOrUndefined(outputRecord.preview) ?? preview?.text : undefined,
  };
}

function fileDiffDisplay(
  inputRecord: Readonly<Record<string, unknown>>,
  outputRecord: Readonly<Record<string, unknown>>,
  operation: ToolFileDisplayOperation
): ToolDisplayProjection {
  const preview = canonicalEditFileDiffPreview(outputRecord.diff);
  return {
    kind: "file_diff_preview",
    path: stringOrUndefined(outputRecord.path) ?? stringOrUndefined(inputRecord.path),
    operation,
    preview: preview?.text,
  };
}

function genericToolDisplayForOperation(input: ToolDisplayNormalizationInput): ToolDisplayProjection {
  const request = asRecord(input.input);
  const output = asRecord(input.output);
  const text = stringOrUndefined(output.text) ?? stringOrUndefined(output.content);
  const items = [
    ...stringArray(output.items),
    ...(text === undefined ? [] : [text]),
    ...mcpContentItems(output.content),
    ...structuredContentItems(output.structuredContent),
  ]
    .map((item) => stringOrUndefined(item))
    .filter((item): item is string => item !== undefined);
  return {
    kind: "raw_tool_result",
    action: toolDisplayName(input.toolName),
    summary: stringOrUndefined(request.query) ?? genericFactSummary(output) ?? genericRequestTarget(request),
    items: items.length === 0 ? undefined : items,
  };
}

export function projectToolDisplayResultFacts(output: ToolFactValue | undefined): Pick<ToolDisplayProjection, "truncated" | "continuation"> {
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

function genericRequestTarget(request: Readonly<Record<string, unknown>>): string | undefined {
  return stringOrUndefined(request.path) ??
    stringOrUndefined(request.url) ??
    stringOrUndefined(request.uri) ??
    stringOrUndefined(request.ref) ??
    stringOrUndefined(request.name);
}

function fileOperationKind(
  toolName: string,
  inputRecord: Readonly<Record<string, unknown>>,
  outputRecord: Readonly<Record<string, unknown>>
): {
  readonly kind: "write" | "edit";
  readonly operation: ToolFileDisplayOperation;
} | undefined {
  const explicitOperation =
    fileDisplayOperationOrUndefined(outputRecord.operation) ??
    fileDisplayOperationOrUndefined(inputRecord.operation);
  if (explicitOperation !== undefined) {
    return {
      kind: explicitOperation === "edit" ? "edit" : "write",
      operation: explicitOperation,
    };
  }
  if (toolName === "edit") {
    return { kind: "edit", operation: "edit" };
  }
  if (toolName === "create") {
    return { kind: "write", operation: "create" };
  }
  if (toolName === "delete") {
    return { kind: "write", operation: "delete" };
  }
  if (toolName === "write") {
    return {
      kind: "write",
      operation: booleanOrUndefined(outputRecord.append) ?? booleanOrUndefined(inputRecord.append) ? "append" : "write",
    };
  }
  return undefined;
}

function isBuiltInFileToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "write" ||
    normalized === "create" ||
    normalized === "delete" ||
    normalized === "edit";
}

function fileDisplayOperationOrUndefined(value: unknown): ToolFileDisplayOperation | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "create" ||
    normalized === "write" ||
    normalized === "append" ||
    normalized === "edit" ||
    normalized === "delete"
  ) {
    return normalized;
  }
  return undefined;
}

type FilePreviewResult = {
  readonly text: string;
};

function fileWriteDiffPreview(input: {
  readonly content: string | undefined;
  readonly mode: "create" | "write" | "append";
}): FilePreviewResult | undefined {
  if (input.content === undefined) return undefined;
  const normalized = input.content.replace(/\r\n?/g, "\n");
  if (normalized.length === 0) return undefined;
  if (normalized.trim().length === 0 && !normalized.includes("\n")) {
    const label = input.mode === "append" ? "追加内容" : input.mode === "create" ? "新增内容" : "写入内容";
    return { text: `+ ${label}` };
  }
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  return {
    text: lines
      .map((line) => `+ ${line.length === 0 ? " " : line}`)
      .join("\n"),
  };
}

function canonicalEditFileDiffPreview(value: unknown): FilePreviewResult | undefined {
  const diff = asRecord(value);
  if (diff.status !== "available") {
    return undefined;
  }
  const unifiedDiff = stringOrUndefined(diff.unifiedDiff);
  return unifiedDiff === undefined ? undefined : completeDiffText(unifiedDiff);
}

function compactDiffPreview(value: string | undefined): FilePreviewResult | undefined {
  return value === undefined ? undefined : completeDiffText(value);
}

function completeDiffText(value: string): FilePreviewResult | undefined {
  const text = value.trimEnd();
  if (text.trim().length === 0) return undefined;
  return { text };
}

function mcpContentItems(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .slice(0, 8)
    .map(mcpContentSummary)
    .filter((item): item is string => item !== undefined);
}

function mcpContentSummary(value: unknown): string | undefined {
  const record = asRecord(value);
  const type = stringOrUndefined(record.type);
  if (type === "text") {
    return stringOrUndefined(record.text);
  }
  if (type === "resource_link") {
    return stringOrUndefined([
      stringOrUndefined(record.title) ?? stringOrUndefined(record.name),
      stringOrUndefined(record.uri),
    ].filter((item): item is string => item !== undefined).join(" · "));
  }
  if (type === "resource") {
    const resource = asRecord(record.resource);
    const resourceText = stringOrUndefined(resource.text);
    return resourceText ?? stringOrUndefined(resource.uri);
  }
  return undefined;
}

function structuredContentItems(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 8)
      .map(structuredFactText)
      .filter((item): item is string => item !== undefined);
  }
  const item = structuredFactText(value);
  return item === undefined ? [] : [item];
}

function structuredFactText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const record = asRecord(value);
  const parts = uniqueStrings([
    stringOrUndefined(record.title) ?? stringOrUndefined(record.name),
    stringOrUndefined(record.path) ?? stringOrUndefined(record.url) ?? stringOrUndefined(record.uri),
  ]);
  return stringOrUndefined(parts.join(" · "));
}

function genericFactSummary(output: Readonly<Record<string, unknown>>): string | undefined {
  const parts = uniqueStrings([
    stringOrUndefined(output.title) ?? stringOrUndefined(output.name),
    stringOrUndefined(output.path) ?? stringOrUndefined(output.url) ?? stringOrUndefined(output.uri),
    stringOrUndefined(output.refId) ?? stringOrUndefined(output.ref),
  ]);
  if (parts.length > 0) {
    return stringOrUndefined(parts.join(" · "));
  }
  return stringOrUndefined(output.message);
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function directoryEntryDisplayItem(value: unknown): {
  readonly path: string;
  readonly kind?: string;
} | undefined {
  const record = asRecord(value);
  const path = stringOrUndefined(record.path) ?? stringOrUndefined(record.name);
  if (path === undefined) {
    return undefined;
  }
  return {
    path,
    kind: stringOrUndefined(record.kind),
  };
}

function unreadableDirectorySample(value: unknown): {
  readonly path?: string;
  readonly errorCode?: string;
} | undefined {
  const record = asRecord(value);
  const path = stringOrUndefined(record.path);
  const errorCode = stringOrUndefined(record.errorCode);
  if (path === undefined && errorCode === undefined) {
    return undefined;
  }
  return {
    path,
    errorCode,
  };
}

function fileSearchMatchDisplayItem(value: unknown): {
  readonly path: string;
  readonly line?: number;
  readonly preview?: string;
} | undefined {
  const record = asRecord(value);
  const path = stringOrUndefined(record.path);
  if (path === undefined) {
    return undefined;
  }
  return {
    path,
    line: numberOrUndefined(record.line),
    preview: stringOrUndefined(record.preview),
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}


function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}
