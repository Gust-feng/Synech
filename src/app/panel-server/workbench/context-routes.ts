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
import type { ContextAttachmentUploadApplication } from "../../application/context-attachment-application.js";
import { parseContextReference } from "../../../domain/ordinary/index.js";

export type PanelContextRouteRuntime = {
  readonly directoryPicker?: () => Promise<string | undefined>;
  readonly contextAttachmentPicker?: () => Promise<PanelContextAttachmentSelection | undefined>;
  readonly contextAttachmentMedia: Map<string, PanelContextAttachmentMediaEntry>;
  /** Host-selected root for relative context preview requests. */
  readonly contextPreviewRoot: string;
  readonly contextAttachmentUploadApplication: ContextAttachmentUploadApplication;
  readonly ordinaryAgentFeature: {
    readonly commands: Pick<OrdinaryAgentFeature["commands"], "discardManagedAttachmentDraft">;
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
    const attachments = await runtime.contextAttachmentUploadApplication.upload({
      uploadRequestId,
      files,
      createPreview: async ({ record, path: savedPath }) => {
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
        return await attachMediaPreview(runtime, attachment);
      },
    });
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
  readonly filename: string;
  readonly contentType?: string;
  readonly body: Uint8Array;
};

async function readMultipartAttachmentUpload(request: IncomingMessage): Promise<readonly UploadedMultipartFile[]> {
  const contentType = request.headers["content-type"];
  if (contentType === undefined || !/^multipart\/form-data(?:;|$)/iu.test(contentType)) {
    throw new PanelHttpError(400, "invalid_attachment_upload", "附件上传请求必须使用 multipart/form-data。");
  }
  const body = await readRequestBuffer(request, MAX_ATTACHMENT_UPLOAD_BYTES);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new PanelHttpError(400, "invalid_attachment_upload", "附件上传请求格式无效。");
  }
  const files = form.getAll("files").filter((value): value is File => typeof value !== "string");
  if (files.length > MAX_ATTACHMENT_UPLOAD_FILES) {
    throw new PanelHttpError(413, "too_many_attachment_files", `一次最多上传 ${MAX_ATTACHMENT_UPLOAD_FILES} 个附件。`);
  }
  return await Promise.all(files.map(async (file) => ({
    filename: file.name,
    contentType: file.type,
    body: new Uint8Array(await file.arrayBuffer()),
  })));
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
  const parsed = parseContextReference(ref);
  if (parsed?.scheme === "uploaded_attachment") {
    return await runtime.resolveManagedAttachmentPath(parsed.attachmentId);
  }
  if (parsed?.scheme === "local_file") {
    const absolutePath = parsed.path;
    return path.isAbsolute(absolutePath) ? path.resolve(absolutePath) : undefined;
  }
  if (workspaceRoot === undefined) {
    return undefined;
  }
  if (parsed?.scheme === "file") {
    return resolveWorkspaceFilePath(workspaceRoot, parsed.path);
  }
  if (parsed?.scheme === "workspace") {
    const relativePath = parsed.value;
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
