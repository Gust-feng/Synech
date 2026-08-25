import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  PanelContextAttachment as ContextAttachment,
  PanelContextAttachmentKind as ContextAttachmentKind,
} from "../../panel-api/ordinary-agent.js";
import { createId } from "../../../kernel/id.js";
import {
  managedAttachmentRef,
  parseContextReference,
  serializeContextReference,
  serializePermissionBoundaryRef,
} from "../../../domain/ordinary/index.js";

const MAX_FILE_PREVIEW_BYTES = 96_000;
const MAX_FILE_PREVIEW_CHARS = 8_000;
const MAX_DIRECTORY_PREVIEW_ENTRIES = 80;

const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".js": "text/javascript",
  ".jsx": "text/jsx",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

/** Converts a user-selected resource into the Panel attachment contract. */
export class ContextAttachmentPreviewError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ContextAttachmentPreviewError";
  }
}

export type CreateContextAttachmentPreviewInput = {
  readonly kind?: ContextAttachmentKind;
  readonly value?: string;
  readonly ref?: string;
  readonly title?: string;
  readonly summary?: string;
};

export type LocalContextAttachmentSelection = {
  readonly kind: "file" | "project";
  readonly path: string;
};

export type UploadedContextAttachmentInput = {
  readonly attachmentId: string;
  readonly path: string;
  readonly originalName: string;
  readonly mimeType?: string;
};

export async function createContextAttachmentPreview(input: {
  readonly raw: CreateContextAttachmentPreviewInput;
  readonly workspaceRoot: string;
}): Promise<ContextAttachment> {
  const value = requiredText(input.raw.value ?? input.raw.ref, "上下文引用不能为空。");
  const kind = input.raw.kind ?? inferAttachmentKind(value);
  if (kind === "web") {
    return webAttachment(value, input.raw);
  }
  if (kind === "workspace") {
    return workspaceAttachment(input.workspaceRoot, input.raw);
  }
  return fileSystemAttachment({
    kind,
    value,
    raw: input.raw,
    workspaceRoot: input.workspaceRoot,
  });
}

export async function createSelectedLocalContextAttachment(
  input: LocalContextAttachmentSelection
): Promise<ContextAttachment> {
  const absolutePath = requiredAbsolutePath(input.path);
  const stat = await fs.stat(absolutePath).catch(() => undefined);
  const actualKind = stat?.isDirectory() === true ? "project" : "file";
  const kind = stat === undefined ? input.kind : actualKind;
  const title = safeText(path.basename(absolutePath) || absolutePath, 120);
  const ref = serializeContextReference(kind === "project"
    ? { scheme: "local_project", path: absolutePath }
    : { scheme: "local_file", path: absolutePath });
  const preview = stat === undefined
    ? undefined
    : kind === "project"
      ? await directoryReadonlyPreview(absolutePath, title)
      : await fileReadonlyPreview(absolutePath, title, stat.size, mimeTypeForPath(absolutePath));
  const available = stat !== undefined &&
    ((kind === "project" && stat.isDirectory()) || (kind === "file" && stat.isFile()));
  return {
    attachmentId: createId("ctx"),
    kind,
    sourceKind: kind === "project" ? "local_project" : "local_file",
    ref,
    title,
    summary: safeText(
      defaultLocalSummary({ kind, absolutePath, stat, preview }),
      280
    ),
    readonlyPreview: preview,
    permissionRefs: [readPermission(ref)],
    readonlyPreviewMeta: {
      available,
      title,
      byteLength: stat?.isFile() === true ? stat.size : undefined,
      mimeType: stat?.isFile() === true ? mimeTypeForPath(absolutePath) : undefined,
      truncated: preview?.truncated ?? false,
    },
    status: available ? "ready" : "blocked",
    warning: available ? undefined : "没有找到这个本地路径。",
  };
}

export async function createUploadedContextAttachment(
  input: UploadedContextAttachmentInput
): Promise<ContextAttachment> {
  const absolutePath = requiredAbsolutePath(input.path);
  const stat = await fs.stat(absolutePath).catch(() => undefined);
  if (stat?.isFile() !== true) {
    throw new ContextAttachmentPreviewError("uploaded_attachment_missing", "上传附件保存失败。");
  }
  const title = safeText(path.basename(input.originalName) || path.basename(absolutePath) || "attachment", 120);
  const mimeType = safeText(input.mimeType ?? mimeTypeForPath(title) ?? mimeTypeForPath(absolutePath) ?? "application/octet-stream", 160);
  const preview = await fileReadonlyPreview(absolutePath, title, stat.size, mimeType);
  const ref = managedAttachmentRef(input.attachmentId);
  return {
    attachmentId: input.attachmentId,
    kind: "file",
    sourceKind: "managed_upload",
    ref,
    title,
    summary: safeText(`上传附件：${title} · ${stat.size} bytes${preview?.truncated === true ? " · 预览已截断" : ""}`, 280),
    readonlyPreview: preview,
    permissionRefs: [readPermission(ref)],
    readonlyPreviewMeta: {
      available: true,
      title,
      byteLength: stat.size,
      mimeType,
      truncated: preview?.truncated ?? false,
    },
    status: "ready",
  };
}

function workspaceAttachment(workspaceRoot: string, raw: CreateContextAttachmentPreviewInput): ContextAttachment {
  const label = safeText(raw.title ?? (path.basename(workspaceRoot) || "当前工作区"), 120);
  return {
    attachmentId: createId("ctx"),
    kind: "workspace",
    sourceKind: "workspace",
    ref: serializeContextReference({ scheme: "workspace", value: "current" }),
    title: label,
    summary: safeText(raw.summary ?? "允许本轮任务使用当前工作区上下文。", 280),
    readonlyPreview: raw.summary === undefined
      ? undefined
      : { title: label, text: safeText(raw.summary, MAX_FILE_PREVIEW_CHARS), truncated: false },
    permissionRefs: [readPermission("workspace:current-task")],
    readonlyPreviewMeta: { available: true, title: label },
    status: "ready",
  };
}

async function fileSystemAttachment(input: {
  readonly kind: "file" | "project";
  readonly value: string;
  readonly raw: CreateContextAttachmentPreviewInput;
  readonly workspaceRoot: string;
}): Promise<ContextAttachment> {
  const resolved = resolveWorkspacePath(input.workspaceRoot, input.value);
  const relativePath = toPortableRelativePath(input.workspaceRoot, resolved);
  const stat = await fs.stat(resolved).catch(() => undefined);
  const title = safeText(input.raw.title ?? (path.basename(resolved) || relativePath || "工作区"), 120);
  const isExpectedKind =
    stat === undefined ||
    (input.kind === "file" && stat.isFile()) ||
    (input.kind === "project" && stat.isDirectory());
  const readonlyPreview = stat !== undefined && isExpectedKind
    ? input.kind === "project"
      ? await directoryReadonlyPreview(resolved, title)
      : await fileReadonlyPreview(resolved, title, stat.size, mimeTypeForPath(resolved))
    : undefined;
  return {
    attachmentId: createId("ctx"),
    kind: input.kind,
    sourceKind: input.kind === "project" ? "workspace_project" : "workspace_file",
    ref: serializeContextReference(input.kind === "file"
      ? { scheme: "file", path: relativePath || "." }
      : { scheme: "project", path: relativePath || "." }),
    title,
    summary: safeText(input.raw.summary ?? defaultFileSystemSummary(input.kind, relativePath, stat), 280),
    readonlyPreview,
    permissionRefs:
      input.kind === "file"
        ? [readPermission(serializeContextReference({ scheme: "file", path: relativePath }))]
        : [
            readPermission("workspace:current-task"),
            readPermission(serializeContextReference({ scheme: "project", path: relativePath || "." })),
          ],
    readonlyPreviewMeta: {
      available: stat !== undefined && isExpectedKind,
      title,
      byteLength: stat?.isFile() === true ? stat.size : undefined,
      mimeType: stat?.isFile() === true ? mimeTypeForPath(resolved) : undefined,
      truncated: readonlyPreview?.truncated ?? false,
    },
    status: stat !== undefined && isExpectedKind ? "ready" : "blocked",
    warning:
      stat === undefined
        ? "没有找到这个路径。"
        : isExpectedKind
          ? undefined
          : input.kind === "file"
            ? "请选择一个文件。"
            : "请选择一个文件夹。",
  };
}

function webAttachment(value: string, raw: CreateContextAttachmentPreviewInput): ContextAttachment {
  const url = parseSafeWebUrl(value);
  const title = safeText(raw.title ?? url.hostname, 120);
  return {
    attachmentId: createId("ctx"),
    kind: "web",
    sourceKind: "web",
    ref: serializeContextReference({ scheme: "web", value: url.toString() }),
    title,
    summary: safeText(raw.summary ?? `网页引用：${url.toString()}`, 280),
    readonlyPreview: { title, text: safeText(url.toString(), MAX_FILE_PREVIEW_CHARS), truncated: false },
    permissionRefs: [readPermission("web")],
    readonlyPreviewMeta: { available: true, title },
    status: "ready",
  };
}

function readPermission(target: string): string {
  return serializePermissionBoundaryRef({ kind: "access", mode: "read", target });
}

async function fileReadonlyPreview(
  absolutePath: string,
  title: string,
  byteLength: number,
  mimeType?: string
): Promise<NonNullable<ContextAttachment["readonlyPreview"]> | undefined> {
  if (isKnownBinaryFile(mimeType ?? mimeTypeForPath(absolutePath))) {
    return {
      title,
      text: "[binary file preview omitted]",
      truncated: false,
    };
  }
  const byteLimit = Math.min(byteLength, MAX_FILE_PREVIEW_BYTES);
  const handle = await fs.open(absolutePath, "r").catch(() => undefined);
  if (handle === undefined) {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0);
    const body = buffer.subarray(0, bytesRead);
    if (body.includes(0)) {
      return {
        title,
        text: "[binary file preview omitted]",
        truncated: byteLength > byteLimit,
      };
    }
    const raw = body.toString("utf8");
    const redacted = safeText(raw, MAX_FILE_PREVIEW_CHARS);
    return {
      title,
      text: redacted,
      truncated: byteLength > byteLimit || redacted.length < raw.length,
    };
  } finally {
    await handle.close();
  }
}

async function directoryReadonlyPreview(
  absolutePath: string,
  title: string
): Promise<NonNullable<ContextAttachment["readonlyPreview"]> | undefined> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) {
    return undefined;
  }
  const selected = entries.slice(0, MAX_DIRECTORY_PREVIEW_ENTRIES).map((entry) => {
    const kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
    return `${kind} ${entry.name}`;
  });
  return {
    title,
    text: selected.join("\n") || "(empty directory)",
    truncated: entries.length > selected.length,
  };
}

function defaultLocalSummary(input: {
  readonly kind: "file" | "project";
  readonly absolutePath: string;
  readonly stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
  readonly preview: ContextAttachment["readonlyPreview"] | undefined;
}): string {
  if (input.stat === undefined) {
    return `${input.kind === "file" ? "本地文件" : "本地文件夹"}：${input.absolutePath}`;
  }
  if (input.stat.isDirectory()) {
    const suffix = input.preview?.truncated === true ? " · 已截断" : "";
    return `本地文件夹：${input.absolutePath}${suffix}`;
  }
  const suffix = input.preview?.truncated === true ? " · 预览已截断" : "";
  return `本地文件：${input.absolutePath} · ${input.stat.size} bytes${suffix}`;
}

function requiredAbsolutePath(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ContextAttachmentPreviewError("missing_context_value", "本地附件路径不能为空。");
  }
  if (!path.isAbsolute(normalized)) {
    throw new ContextAttachmentPreviewError("invalid_local_context_path", "本地附件必须是系统选择器返回的绝对路径。");
  }
  return path.resolve(normalized);
}

function inferAttachmentKind(value: string): ContextAttachmentKind {
  if (/^https?:\/\//i.test(value.trim())) {
    return "web";
  }
  return value.trim() === "." ? "workspace" : "file";
}

function resolveWorkspacePath(workspaceRoot: string, value: string): string {
  const root = path.resolve(workspaceRoot);
  const parsed = parseContextReference(value);
  const rawPath = parsed?.scheme === "file" || parsed?.scheme === "project"
    ? parsed.path
    : value;
  const resolved = path.resolve(root, rawPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ContextAttachmentPreviewError("context_path_outside_workspace", "上下文路径必须位于当前工作区内。");
  }
  return resolved;
}

function parseSafeWebUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ContextAttachmentPreviewError("invalid_web_context", "网页上下文需要有效的 HTTP 或 HTTPS 地址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ContextAttachmentPreviewError("invalid_web_context", "网页上下文只支持 HTTP 或 HTTPS 地址。");
  }
  return url;
}

function defaultFileSystemSummary(
  kind: "file" | "project",
  relativePath: string,
  stat: Awaited<ReturnType<typeof fs.stat>> | undefined
): string {
  if (stat === undefined) {
    return `${kind === "file" ? "文件" : "文件夹"}引用：${relativePath}`;
  }
  if (stat.isDirectory()) {
    return `文件夹引用：${relativePath || "."}`;
  }
  return `文件引用：${relativePath} · ${stat.size} bytes`;
}

function toPortableRelativePath(workspaceRoot: string, resolved: string): string {
  return path.relative(path.resolve(workspaceRoot), resolved).replaceAll(path.sep, "/") || ".";
}

function mimeTypeForPath(filePath: string): string | undefined {
  return MIME_TYPE_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

function isKnownBinaryFile(mimeType: string | undefined): boolean {
  if (mimeType === undefined) {
    return false;
  }
  if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/x-ndjson") {
    return false;
  }
  return true;
}

function requiredText(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw new ContextAttachmentPreviewError("missing_context_value", message);
  }
  return normalized;
}

function safeText(value: string, maxLength: number): string {
  const text = value.trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
