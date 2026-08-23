import { stringOrUndefined } from "../../../kernel/values/index.js";
import { promises as fs } from "node:fs";
import type { ToolExecutor } from "../../../domain/tools/index.js";
import {
  asRecord,
  positiveInteger,
  safeRefToken,
  throwIfAborted,
} from "./local-workspace-common.js";
import {
  archiveTargetExtension,
  assertAttachmentAuthorized,
  attachmentTitle,
  requireAttachmentEntry,
  resolveAttachmentTarget,
  statAttachmentTarget,
  tableTargetFormat,
  type AttachmentEntry,
  type AttachmentTarget,
  type ContextAttachmentToolOptions,
} from "./context-attachment-access.js";
import { readZipEntries, normalizeZipEntryName, type ZipEntry } from "./context-attachment-zip.js";

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_LIST_ENTRIES = 200;

/** Creates the bounded, metadata-only ZIP archive inspection tool. */
export function createInspectContextAttachmentArchiveTool(
  options: ContextAttachmentToolOptions = {},
): ToolExecutor {
  return {
    definition: {
      name: "AttachmentInspectArchive",
      description: "Inspect a ZIP archive context attachment and return bounded internal entry metadata without extracting files.",
      metadata: {
        category: "filesystem",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          attachmentId: { type: "string", description: "Attachment id from the current run context, preferred over ref." },
          ref: { type: "string", description: "Exact non-local context ref when attachmentId is unavailable." },
          path: { type: "string", description: "Relative archive path inside a project attachment." },
          limit: { type: "number", description: "Maximum archive entries to return." },
          offset: { type: "number", description: "Zero-based archive entry offset for continuation." },
        },
      },
    },
    execute: async (input, context) => {
      throwIfAborted(context.abortSignal);
      const record = asRecord(input);
      const entry = requireAttachmentEntry(options.runContext, record);
      assertAttachmentAuthorized(entry);
      const target = await resolveAttachmentTarget({
        entry,
        workspaceRoot: options.workspaceRoot ?? process.cwd(),
        requestedPath: stringOrUndefined(record.path),
        requireFile: true,
        projectPathRequired: true,
        resolveManagedAttachmentPath: options.resolveManagedAttachmentPath,
        readAuthorization: options.readAuthorization,
      });
      const stat = await statAttachmentTarget(target.targetAbsolutePath, "Attachment archive target could not be read.");
      if (!stat.isFile()) {
        throw new Error("attachment_inspect_archive expects a file target.");
      }
      const format = tableTargetFormat(entry.ref, target.targetPath);
      if (format !== "archive" || archiveTargetExtension(entry.ref, target.targetPath) !== ".zip") {
        return unsupportedArchiveResult({
          entry,
          target,
          reason: format === "archive" ? "unsupported_archive_format" : "not_an_archive",
          bytes: stat.size,
        });
      }
      if (stat.size > MAX_ARCHIVE_BYTES) {
        return unsupportedArchiveResult({ entry, target, reason: "archive_file_too_large", bytes: stat.size });
      }
      const buffer = await fs.readFile(target.targetAbsolutePath).catch(() => undefined);
      if (buffer === undefined) {
        return unsupportedArchiveResult({ entry, target, reason: "archive_file_unreadable", bytes: stat.size });
      }
      const parsed = (() => {
        try {
          return { supported: true as const, entries: readZipEntries(buffer) };
        } catch (error: unknown) {
          return { supported: false as const, reason: archiveReadErrorReason(error) };
        }
      })();
      if (!parsed.supported) {
        return unsupportedArchiveResult({ entry, target, reason: parsed.reason, bytes: stat.size });
      }
      const limit = Math.min(MAX_ARCHIVE_LIST_ENTRIES, positiveInteger(record.limit) ?? MAX_ARCHIVE_LIST_ENTRIES);
      const offset = nonNegativeInteger(record.offset) ?? 0;
      const archiveEntries = parsed.entries.map(archiveEntrySummary);
      const returned = archiveEntries.slice(offset, offset + limit);
      const nextOffset = offset + returned.length < archiveEntries.length ? offset + returned.length : undefined;
      const truncated = nextOffset !== undefined;
      return {
        refId: `context-attachment:${entry.attachmentId}:archive:${safeRefToken(target.targetPath)}`,
        attachmentId: entry.attachmentId,
        kind: entry.ref.kind,
        title: attachmentTitle(entry),
        path: target.targetPath,
        mimeType: entry.ref.metadata?.mimeType,
        bytes: stat.size,
        archive: true,
        format: "zip",
        offset,
        limit,
        entryCount: archiveEntries.length,
        entriesReturned: returned.length,
        entries: returned,
        truncated,
        continuation: nextOffset === undefined
          ? undefined
          : {
              nextInput: compactRecord({
                attachmentId: entry.attachmentId,
                path: target.targetPath,
                limit,
                offset: nextOffset,
              }),
            },
      };
    },
  };
}

function unsupportedArchiveResult(input: {
  readonly entry: AttachmentEntry;
  readonly target: AttachmentTarget;
  readonly reason: string;
  readonly bytes?: number;
}): Readonly<Record<string, unknown>> {
  return {
    refId: `context-attachment:${input.entry.attachmentId}:archive:${safeRefToken(input.target.targetPath)}`,
    attachmentId: input.entry.attachmentId,
    kind: input.entry.ref.kind,
    title: attachmentTitle(input.entry),
    path: input.target.targetPath,
    mimeType: input.entry.ref.metadata?.mimeType,
    bytes: input.bytes,
    archive: false,
    format: tableTargetFormat(input.entry.ref, input.target.targetPath),
    readable: false,
    reason: input.reason,
  };
}

function archiveReadErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z0-9_]+$/u.test(message) ? message : "archive_parse_failed";
}

function archiveEntrySummary(entry: ZipEntry): {
  readonly path: string;
  readonly name: string;
  readonly kind: "directory" | "file";
  readonly bytes: number;
  readonly compressedBytes: number;
  readonly compressionMethod: number;
  readonly unsafePath: boolean;
} {
  const rawName = entry.name.replace(/\\/g, "/");
  const normalized = normalizeZipEntryName(entry.name);
  const safePath = normalized.length === 0 ? "." : normalized;
  const basename = safePath === "." ? "." : safePath.replace(/\/$/u, "").split("/").at(-1) ?? safePath;
  return {
    path: safePath,
    name: basename,
    kind: safePath.endsWith("/") ? "directory" : "file",
    bytes: entry.uncompressedSize,
    compressedBytes: entry.compressedSize,
    compressionMethod: entry.compressionMethod,
    unsafePath: isUnsafeArchivePath(rawName),
  };
}

function isUnsafeArchivePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized) || normalized.split("/").some((part) => part === "..");
}


function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function compactRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
