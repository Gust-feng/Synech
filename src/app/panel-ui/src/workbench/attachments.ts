import type { ContextAttachment } from "../contracts/context";
import type { ConversationTurnAttachment } from "../contracts/conversation";
import { ApiError, postJson } from "../api";

export function contextInputFromAttachments(attachments: readonly ContextAttachment[]): {
  readonly contextRefs?: readonly {
    readonly attachmentId?: string;
    readonly ref: string;
    readonly kind: ContextAttachment["kind"];
    readonly title?: string;
    readonly summary?: string;
    readonly metadata?: {
      readonly byteLength?: number;
      readonly mimeType?: string;
      readonly available?: boolean;
      readonly truncated?: boolean;
    };
    readonly readonlyPreview?: ContextAttachment["readonlyPreview"];
  }[];
  readonly permissionBoundaryRefs?: readonly string[];
} | undefined {
  const ready = attachments.filter((attachment) => attachment.status === "ready");
  if (ready.length === 0) {
    return undefined;
  }
  return {
    contextRefs: ready.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      ref: attachment.ref,
      kind: attachment.kind,
      title: attachment.title,
      summary: attachment.summary,
      metadata: {
        byteLength: attachment.readonlyPreviewMeta.byteLength,
        mimeType: attachment.readonlyPreviewMeta.mimeType,
        available: attachment.readonlyPreviewMeta.available,
        truncated: attachment.readonlyPreviewMeta.truncated,
      },
      readonlyPreview: attachment.readonlyPreview,
    })),
    permissionBoundaryRefs: Array.from(new Set(ready.flatMap((attachment) => attachment.permissionRefs))),
  };
}

export function uniqueAttachments(attachments: readonly ContextAttachment[]): readonly ContextAttachment[] {
  const seen = new Set<string>();
  const result: ContextAttachment[] = [];
  for (const attachment of attachments) {
    const key = `${attachment.kind}:${attachment.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(attachment);
  }
  return result;
}

export function conversationTurnAttachmentsFromContextAttachments(
  attachments: readonly ContextAttachment[]
): readonly ConversationTurnAttachment[] | undefined {
  const ready = attachments.filter((attachment) => attachment.status === "ready");
  if (ready.length === 0) {
    return undefined;
  }
  return ready.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    kind: attachment.kind,
    title: attachment.title,
    summary: safeConversationAttachmentSummary(attachment),
    readonlyPreviewMeta: {
      available: attachment.readonlyPreviewMeta.available,
      title: attachment.readonlyPreviewMeta.title,
      byteLength: attachment.readonlyPreviewMeta.byteLength,
      mimeType: attachment.readonlyPreviewMeta.mimeType,
      truncated: attachment.readonlyPreviewMeta.truncated,
    },
    mediaPreview: attachment.mediaPreview?.kind === "image" ? attachment.mediaPreview : undefined,
  }));
}

function safeConversationAttachmentSummary(attachment: ContextAttachment): string | undefined {
  const parts = [
    attachment.mediaPreview?.mimeType ?? attachment.readonlyPreviewMeta.mimeType,
    byteSizeLabel(attachment.mediaPreview?.byteLength ?? attachment.readonlyPreviewMeta.byteLength),
  ].filter((value): value is string => value !== undefined);
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  if (attachment.ref.startsWith("local-file:")) {
    return "本地文件";
  }
  if (attachment.ref.startsWith("local-project:")) {
    return "本地文件夹";
  }
  return attachment.summary;
}

function byteSizeLabel(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} bytes`;
}

export async function previewContextAttachment(input: {
  readonly kind: ContextAttachment["kind"];
  readonly value: string;
}): Promise<ContextAttachment> {
  const response = await postJson<{ readonly attachment: ContextAttachment }>("/api/context/attachments/preview", {
    kind: input.kind,
    value: input.value,
  });
  return response.attachment;
}

export async function selectLocalContextAttachment(): Promise<ContextAttachment | undefined> {
  const response = await postJson<{
    readonly status?: "completed" | "cancelled";
    readonly attachment?: ContextAttachment;
  }>("/api/context/attachments/select-local", {});
  return response.status === "cancelled" ? undefined : response.attachment;
}

export async function uploadContextAttachmentFiles(
  files: readonly File[],
  uploadRequestId: string,
): Promise<readonly ContextAttachment[]> {
  if (files.length === 0) {
    return [];
  }
  const body = new FormData();
  for (const file of files) {
    body.append("files", file, file.name || "attachment");
  }
  const response = await fetch("/api/context/attachments/upload", {
    method: "POST",
    headers: { "idempotency-key": uploadRequestId },
    body,
  });
  const text = await response.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    throw new ApiError(
      response.status,
      errorCode(parsed),
      errorMessage(parsed) ?? `请求失败：${response.status}`
    );
  }
  const attachments = attachmentsFromUploadResponse(parsed);
  if (attachments === undefined) {
    throw new ApiError(response.status, "invalid_attachment_upload_response", "附件上传响应无效。");
  }
  return attachments;
}

export function isManagedUploadAttachment(attachment: Pick<ContextAttachment, "ref">): boolean {
  return attachment.ref.startsWith("uploaded-attachment:");
}

export async function discardManagedUploadAttachment(attachmentId: string): Promise<void> {
  const response = await fetch(`/api/context/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE",
  });
  if (response.ok) return;
  const text = await response.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : {};
  throw new ApiError(response.status, errorCode(parsed), errorMessage(parsed) ?? `请求失败：${response.status}`);
}

export function blockedContextAttachment(input: {
  readonly kind: ContextAttachment["kind"];
  readonly value: string;
  readonly error: unknown;
  readonly createdAt?: number;
}): ContextAttachment {
  const message = input.error instanceof Error ? input.error.message : "上下文暂时不可用。";
  return {
    attachmentId: `blocked:${input.kind}:${input.value}:${input.createdAt ?? Date.now()}`,
    kind: input.kind,
    ref: input.value,
    title: input.kind === "web" ? "网页不可用" : "上下文不可用",
    summary: message,
    permissionRefs: [],
    readonlyPreviewMeta: { available: false },
    status: "blocked",
    warning: message,
  };
}

function attachmentsFromUploadResponse(value: unknown): readonly ContextAttachment[] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const attachments = (value as { readonly attachments?: unknown }).attachments;
  return Array.isArray(attachments) ? attachments as readonly ContextAttachment[] : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as { readonly error?: { readonly message?: unknown }; readonly message?: unknown };
  if (typeof record.error?.message === "string") {
    return record.error.message;
  }
  return typeof record.message === "string" ? record.message : undefined;
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as { readonly error?: { readonly code?: unknown }; readonly code?: unknown };
  if (typeof record.error?.code === "string") {
    return record.error.code;
  }
  return typeof record.code === "string" ? record.code : undefined;
}
