import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PanelContextAttachment as ContextAttachment } from "../../panel-api/ordinary-agent.js";
import {
  ContextAttachmentPreviewError,
  createContextAttachmentPreview,
  createSelectedLocalContextAttachment,
  createUploadedContextAttachment,
} from "./context-attachment-preview.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";
import { parseContextAttachmentPreviewRequest } from "../request-parsers.js";
import type { PanelContextAttachmentMediaEntry, PanelContextAttachmentSelection } from "../types.js";
import type { OrdinaryAgentFeature } from "../../ordinary-agent/index.js";

export type PanelContextRouteRuntime = {
  readonly directoryPicker?: () => Promise<string | undefined>;
  readonly contextAttachmentPicker?: () => Promise<PanelContextAttachmentSelection | undefined>;
  readonly contextAttachmentMedia: Map<string, PanelContextAttachmentMediaEntry>;
  /** Host-selected root for relative context preview requests. */
  readonly contextPreviewRoot: string;
  readonly ordinaryAgentFeature: {
    readonly commands: Pick<OrdinaryAgentFeature["commands"], "discardManagedAttachmentDraft" | "createManagedAttachmentDraft">;
    readonly queries: Pick<OrdinaryAgentFeature["queries"], "getManagedAttachment">;
  };
  readonly resolveManagedAttachmentPath: (attachmentId: string) => Promise<string | undefined>;
};

const MAX_ATTACHMENT_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_ATTACHMENT_UPLOAD_FILES = 12;

export async function handlePanelContextRoute(
  runtime: PanelContextRouteRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const mediaMatch = /^\/api\/context\/attachments\/media\/([^/]+)$/u.exec(url.pathname);
  if (request.method === "GET" && mediaMatch !== null) {
    await writeContextAttachmentMedia(runtime, decodeMediaAttachmentId(mediaMatch[1] ?? ""), response);
    return true;
  }

  const discardMatch = /^\/api\/context\/attachments\/([^/]+)$/u.exec(url.pathname);
  if (request.method === "DELETE" && discardMatch !== null) {
    const attachmentId = decodeMediaAttachmentId(discardMatch[1] ?? "");
    await runtime.ordinaryAgentFeature.commands.discardManagedAttachmentDraft(attachmentId);
    runtime.contextAttachmentMedia.delete(attachmentId);
    writeJson(response, 200, { ok: true, discardedAttachmentId: attachmentId });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/context/attachments/preview") {
    const body = await readJsonBody(request);
    const attachment = await createContextAttachmentPreview({
      raw: parseContextAttachmentPreviewRequest(body),
       workspaceRoot: runtime.contextPreviewRoot,
    }).catch((error: unknown) => {
      if (error instanceof ContextAttachmentPreviewError) {
        throw new PanelHttpError(400, error.code, error.message);
      }
      throw error;
    });
    writeJson(response, 200, {
      ok: true,
       attachment: await attachMediaPreview(runtime, attachment, runtime.contextPreviewRoot),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/context/attachments/upload") {
    const uploadRequestId = requireAttachmentUploadIdempotencyKey(request);
    const files = await readMultipartAttachmentUpload(request);
    if (files.length === 0) {
      throw new PanelHttpError(400, "missing_attachment_files", "上传请求没有包含文件。");
    }
    if (files.length > MAX_ATTACHMENT_UPLOAD_FILES) {
      throw new PanelHttpError(413, "too_many_attachment_files", `一次最多上传 ${MAX_ATTACHMENT_UPLOAD_FILES} 个附件。`);
    }
    const attachments: ContextAttachment[] = [];
    const createdAttachmentIds: string[] = [];
    try {
      for (const [uploadFileIndex, file] of files.entries()) {
        const draft = await runtime.ordinaryAgentFeature.commands.createManagedAttachmentDraft({
          originalName: file.filename,
          ...(file.contentType === undefined ? {} : { mimeType: file.contentType }),
          content: file.body,
          uploadRequestId,
          uploadFileIndex,
        });
        const record = draft.record;
        if (draft.created) createdAttachmentIds.push(record.attachmentId);
        const savedPath = await runtime.resolveManagedAttachmentPath(record.attachmentId);
        if (savedPath === undefined) {
          throw new PanelHttpError(500, "uploaded_attachment_missing", "上传附件保存失败。");
        }
        const attachment = await createUploadedContextAttachment({
          attachmentId: record.attachmentId,
          path: savedPath,
          originalName: record.originalName,
          mimeType: record.mimeType,
        }).catch((error: unknown) => {
          if (error instanceof ContextAttachmentPreviewError) {
            throw new PanelHttpError(400, error.code, error.message);
          }
          throw error;
        });
        attachments.push(await attachMediaPreview(runtime, attachment));
      }
    } catch (error) {
      await Promise.allSettled(createdAttachmentIds.map((attachmentId) =>
        runtime.ordinaryAgentFeature.commands.discardManagedAttachmentDraft(attachmentId)));
      throw error;
    }
    writeJson(response, 200, {
      ok: true,
      attachments,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/context/attachments/select-local") {
    if (runtime.contextAttachmentPicker === undefined) {
      throw new PanelHttpError(501, "context_attachment_picker_unavailable", "当前环境不支持系统附件选择器。");
    }
    const selected = await runtime.contextAttachmentPicker();
    if (selected === undefined) {
      writeJson(response, 200, {
        ok: true,
        status: "cancelled",
        message: "已取消选择附件。",
      });
      return true;
    }
    const attachment = await createSelectedLocalContextAttachment(selected).catch((error: unknown) => {
      if (error instanceof ContextAttachmentPreviewError) {
        throw new PanelHttpError(400, error.code, error.message);
      }
      throw error;
    });
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      attachment: await attachMediaPreview(runtime, attachment),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/context/workspace/select-directory") {
    if (runtime.directoryPicker === undefined) {
      throw new PanelHttpError(501, "workspace_picker_unavailable", "当前环境不支持系统文件夹选择器。");
    }
    const selectedDirectory = await runtime.directoryPicker();
    if (selectedDirectory === undefined) {
      writeJson(response, 200, {
        ok: true,
        status: "cancelled",
        message: "已取消选择文件夹。",
      });
      return true;
    }
    writeJson(response, 200, {
      ok: true,
      status: "completed",
      directory: path.resolve(selectedDirectory),
    });
    return true;
  }
  return false;
}

function requireAttachmentUploadIdempotencyKey(request: IncomingMessage): string {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (value === undefined || value.trim().length === 0 || value.length > 200 || value.includes("\0")) {
    throw new PanelHttpError(
      400,
      "invalid_attachment_upload_idempotency_key",
      "附件上传需要有效的 Idempotency-Key。",
    );
  }
  return value;
}

type UploadedMultipartFile = {
  readonly fieldName: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly body: Buffer;
};

async function readMultipartAttachmentUpload(request: IncomingMessage): Promise<readonly UploadedMultipartFile[]> {
  const boundary = multipartBoundary(request.headers["content-type"]);
  if (boundary === undefined) {
    throw new PanelHttpError(400, "invalid_attachment_upload", "附件上传请求必须使用 multipart/form-data。");
  }
  const body = await readRequestBuffer(request, MAX_ATTACHMENT_UPLOAD_BYTES);
  return parseMultipartFiles(body, boundary).filter((file) => file.fieldName === "files");
}

function multipartBoundary(contentType: string | readonly string[] | undefined): string | undefined {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/iu.exec(value ?? "");
  return match?.[1] ?? match?.[2]?.trim();
}

async function readRequestBuffer(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "binary");
    total += buffer.length;
    if (total > maxBytes) {
      throw new PanelHttpError(413, "attachment_upload_too_large", "上传附件总大小过大。");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseMultipartFiles(body: Buffer, boundary: string): readonly UploadedMultipartFile[] {
  const marker = Buffer.from(`--${boundary}`, "utf8");
  const files: UploadedMultipartFile[] = [];
  let cursor = body.indexOf(marker);
  while (cursor >= 0) {
    cursor += marker.length;
    if (body.subarray(cursor, cursor + 2).toString("latin1") === "--") {
      break;
    }
    if (body.subarray(cursor, cursor + 2).toString("latin1") === "\r\n") {
      cursor += 2;
    } else if (body.subarray(cursor, cursor + 1).toString("latin1") === "\n") {
      cursor += 1;
    }
    const next = body.indexOf(marker, cursor);
    if (next < 0) {
      break;
    }
    const part = trimPartBody(body.subarray(cursor, next));
    const parsed = parseMultipartFilePart(part);
    if (parsed !== undefined) {
      files.push(parsed);
    }
    cursor = next;
  }
  return files;
}

function trimPartBody(part: Buffer): Buffer {
  if (part.length >= 2 && part.subarray(part.length - 2).toString("latin1") === "\r\n") {
    return part.subarray(0, part.length - 2);
  }
  if (part.length >= 1 && part.subarray(part.length - 1).toString("latin1") === "\n") {
    return part.subarray(0, part.length - 1);
  }
  return part;
}

function parseMultipartFilePart(part: Buffer): UploadedMultipartFile | undefined {
  const headerEnd = part.indexOf(Buffer.from("\r\n\r\n", "latin1"));
  const delimiterLength = headerEnd >= 0 ? 4 : 2;
  const effectiveHeaderEnd = headerEnd >= 0 ? headerEnd : part.indexOf(Buffer.from("\n\n", "latin1"));
  if (effectiveHeaderEnd < 0) {
    return undefined;
  }
  const headers = parseMultipartHeaders(part.subarray(0, effectiveHeaderEnd).toString("latin1"));
  const disposition = headers.get("content-disposition");
  const dispositionParams = parseHeaderParameters(disposition);
  const fieldName = dispositionParams.name;
  const filename = dispositionParams.filename ?? dispositionParams["filename*"];
  if (fieldName === undefined || filename === undefined || filename.length === 0) {
    return undefined;
  }
  return {
    fieldName,
    filename,
    contentType: headers.get("content-type"),
    body: part.subarray(effectiveHeaderEnd + delimiterLength),
  };
}

function parseMultipartHeaders(value: string): ReadonlyMap<string, string> {
  const headers = new Map<string, string>();
  for (const line of value.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

function parseHeaderParameters(value: string | undefined): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const part of value?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator).trim().toLowerCase();
    const raw = part.slice(separator + 1).trim();
    result[key] = decodeHeaderParameter(raw, key.endsWith("*"));
  }
  return result;
}

function decodeHeaderParameter(value: string, encoded: boolean): string {
  const unquoted = value.startsWith("\"") && value.endsWith("\"")
    ? value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
    : value;
  if (!encoded) {
    return unquoted;
  }
  const encodedMatch = /^[^']*'[^']*'(.+)$/u.exec(unquoted);
  try {
    return decodeURIComponent(encodedMatch?.[1] ?? unquoted);
  } catch {
    return unquoted;
  }
}

async function attachMediaPreview(
  runtime: PanelContextRouteRuntime,
  attachment: ContextAttachment,
  workspaceRoot?: string
): Promise<ContextAttachment> {
  const entry = await mediaEntryForAttachment(runtime, attachment, workspaceRoot);
  if (entry === undefined) {
    return attachment;
  }
  runtime.contextAttachmentMedia.set(entry.attachmentId, entry);
  return {
    ...attachment,
    mediaPreview: {
      kind: entry.kind,
      url: mediaPreviewUrl(entry.attachmentId),
      mimeType: entry.mimeType,
      byteLength: entry.byteLength,
    },
  };
}

async function mediaEntryForAttachment(
  runtime: PanelContextRouteRuntime,
  attachment: ContextAttachment,
  workspaceRoot?: string
): Promise<PanelContextAttachmentMediaEntry | undefined> {
  const mimeType = attachment.readonlyPreviewMeta.mimeType;
  if (
    attachment.kind !== "file" ||
    attachment.status !== "ready" ||
    mimeType === undefined ||
    !isImageMimeType(mimeType)
  ) {
    return undefined;
  }
  const absolutePath = await resolveAttachmentFilePath(runtime, attachment.ref, workspaceRoot);
  if (absolutePath === undefined) {
    return undefined;
  }
  const stat = await fs.stat(absolutePath).catch(() => undefined);
  if (stat?.isFile() !== true) {
    return undefined;
  }
  return {
    attachmentId: attachment.attachmentId,
    kind: "image",
    absolutePath,
    mimeType,
    byteLength: stat.size,
    title: attachment.title,
  };
}

async function writeContextAttachmentMedia(
  runtime: PanelContextRouteRuntime,
  attachmentId: string,
  response: ServerResponse
): Promise<void> {
  if (attachmentId.length === 0) {
    throw new PanelHttpError(400, "invalid_attachment_media_id", "附件媒体 ID 无效。");
  }
  let entry = runtime.contextAttachmentMedia.get(attachmentId);
  if (entry === undefined) {
    const record = await runtime.ordinaryAgentFeature.queries.getManagedAttachment(attachmentId);
    const absolutePath = record === undefined
      ? undefined
      : await runtime.resolveManagedAttachmentPath(attachmentId);
    if (record !== undefined && absolutePath !== undefined && isImageMimeType(record.mimeType ?? "")) {
      entry = {
        attachmentId,
        kind: "image",
        absolutePath,
        mimeType: record.mimeType!,
        byteLength: record.byteLength,
        title: record.originalName,
      };
      runtime.contextAttachmentMedia.set(attachmentId, entry);
    }
  }
  if (entry === undefined) {
    throw new PanelHttpError(404, "attachment_media_not_found", "没有找到这个附件预览。");
  }
  if (!isImageMimeType(entry.mimeType)) {
    throw new PanelHttpError(404, "attachment_media_not_found", "没有找到这个附件预览。");
  }
  const stat = await fs.stat(entry.absolutePath).catch(() => undefined);
  if (stat?.isFile() !== true) {
    runtime.contextAttachmentMedia.delete(attachmentId);
    throw new PanelHttpError(410, "attachment_media_unavailable", "附件预览文件已不可用。");
  }
  const body = await fs.readFile(entry.absolutePath).catch(() => undefined);
  if (body === undefined) {
    throw new PanelHttpError(410, "attachment_media_unavailable", "附件预览文件已不可用。");
  }
  response.writeHead(200, {
    "content-type": entry.mimeType,
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function resolveAttachmentFilePath(
  runtime: PanelContextRouteRuntime,
  ref: string,
  workspaceRoot: string | undefined,
): Promise<string | undefined> {
  if (ref.startsWith("uploaded-attachment:")) {
    const attachmentId = ref.slice("uploaded-attachment:".length);
    return attachmentId.length === 0 ? undefined : await runtime.resolveManagedAttachmentPath(attachmentId);
  }
  if (ref.startsWith("local-file:")) {
    const absolutePath = ref.slice("local-file:".length);
    return path.isAbsolute(absolutePath) ? path.resolve(absolutePath) : undefined;
  }
  if (workspaceRoot === undefined) {
    return undefined;
  }
  if (ref.startsWith("file:")) {
    return resolveWorkspaceFilePath(workspaceRoot, ref.slice("file:".length));
  }
  if (ref.startsWith("workspace:")) {
    const relativePath = ref.slice("workspace:".length);
    if (relativePath.length === 0 || relativePath === "current" || relativePath.startsWith("goal-")) {
      return undefined;
    }
    return resolveWorkspaceFilePath(workspaceRoot, relativePath);
  }
  return undefined;
}

function resolveWorkspaceFilePath(workspaceRoot: string, relativePath: string): string | undefined {
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return absolutePath;
}

function mediaPreviewUrl(attachmentId: string): string {
  return `/api/context/attachments/media/${encodeURIComponent(attachmentId)}`;
}

function decodeMediaAttachmentId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PanelHttpError(400, "invalid_attachment_media_id", "附件媒体 ID 无效。");
  }
}

function isImageMimeType(mimeType: string): boolean {
  return /^image\/(?:png|jpeg|gif|webp)$/iu.test(mimeType);
}
