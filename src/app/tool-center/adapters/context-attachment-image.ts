import { stringOrUndefined } from "../../../kernel/values/index.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelInputAttachment } from "../../../domain/intelligence/index.js";
import type { OrdinaryRunContextReference } from "../../../domain/ordinary/index.js";
import type { ToolExecutor } from "../../../domain/tools/index.js";
import { withToolModelAttachments } from "../../../domain/tools/index.js";
import {
  asRecord,
  safeRefToken,
  throwIfAborted,
} from "./local-workspace-common.js";
import {
  assertAttachmentAuthorized,
  attachmentTitle,
  requireAttachmentEntry,
  resolveAttachmentTarget,
  statAttachmentTarget,
  tableTargetExtension,
  tableTargetFormat,
  type AttachmentEntry,
  type AttachmentTarget,
  type ContextAttachmentToolOptions,
} from "./context-attachment-access.js";

const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** Creates the attachment tool that adds an image to the next model turn. */
export function createReadContextAttachmentImageTool(
  options: ContextAttachmentToolOptions = {},
): ToolExecutor {
  return {
    definition: {
      name: "AttachmentReadImage",
      description: "Read an image context attachment as an ephemeral model vision input using attachmentId instead of a local path.",
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
          path: { type: "string", description: "Relative image path inside a project or workspace attachment." },
          detail: { type: "string", description: "Vision detail hint: auto, low, or high. Defaults to auto." },
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
      const stat = await statAttachmentTarget(target.targetAbsolutePath, "Attachment image target could not be read.");
      const detail = imageDetailFromUnknown(record.detail);
      if (options.supportsVisionInput === false) {
        return unsupportedImageResult({
          entry,
          target,
          reason: "model_does_not_support_vision_input",
          bytes: stat.size,
          detail,
        });
      }
      if (!stat.isFile()) {
        return unsupportedImageResult({ entry, target, reason: "not_a_file", bytes: stat.size, detail });
      }
      const mimeType = imageMimeTypeForTarget(entry.ref, target);
      if (mimeType === undefined) {
        return unsupportedImageResult({ entry, target, reason: "not_an_image", bytes: stat.size, detail });
      }
      if (stat.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        return unsupportedImageResult({
          entry,
          target,
          reason: "image_file_too_large",
          bytes: stat.size,
          mimeType,
          detail,
        });
      }
      const buffer = await fs.readFile(target.targetAbsolutePath).catch(() => undefined);
      if (buffer === undefined) {
        return unsupportedImageResult({
          entry,
          target,
          reason: "image_file_unreadable",
          bytes: stat.size,
          mimeType,
          detail,
        });
      }
      const output = {
        refId: `context-attachment:${entry.attachmentId}:image:${safeRefToken(target.targetPath)}`,
        attachmentId: entry.attachmentId,
        kind: entry.ref.kind,
        title: attachmentTitle(entry),
        path: target.targetPath,
        mimeType,
        bytes: stat.size,
        format: "image",
        readable: true,
        modelInput: { attached: true, detail },
      };
      return withToolModelAttachments(output, [
        imageModelAttachment({
          entry,
          target,
          mimeType,
          data: buffer,
          detail,
          byteLength: stat.size,
        }),
      ]);
    },
  };
}

function unsupportedImageResult(input: {
  readonly entry: AttachmentEntry;
  readonly target: AttachmentTarget;
  readonly reason: string;
  readonly bytes?: number;
  readonly mimeType?: string;
  readonly detail: "auto" | "low" | "high";
}): Readonly<Record<string, unknown>> {
  const mimeType = input.mimeType ?? imageMimeTypeForTarget(input.entry.ref, input.target);
  return {
    refId: `context-attachment:${input.entry.attachmentId}:image:${safeRefToken(input.target.targetPath)}`,
    attachmentId: input.entry.attachmentId,
    kind: input.entry.ref.kind,
    title: attachmentTitle(input.entry),
    path: input.target.targetPath,
    mimeType,
    bytes: input.bytes,
    format: mimeType === undefined ? tableTargetFormat(input.entry.ref, input.target.targetPath) : "image",
    readable: false,
    reason: input.reason,
    modelInput: { attached: false, detail: input.detail },
  };
}

function imageModelAttachment(input: {
  readonly entry: AttachmentEntry;
  readonly target: AttachmentTarget;
  readonly mimeType: string;
  readonly data: Buffer;
  readonly detail: "auto" | "low" | "high";
  readonly byteLength: number;
}): ModelInputAttachment {
  return {
    kind: "image",
    source: { kind: "data", mimeType: input.mimeType, data: input.data.toString("base64") },
    attachmentId: input.entry.attachmentId,
    inputRef: `context-attachment:${input.entry.attachmentId}:image:${safeRefToken(input.target.targetPath)}`,
    filename: imageModelFilename(input.entry, input.target),
    detail: input.detail,
    byteLength: input.byteLength,
  };
}

function imageModelFilename(entry: AttachmentEntry, target: AttachmentTarget): string {
  if (target.targetPath !== ".") {
    return path.posix.basename(target.targetPath) || attachmentTitle(entry);
  }
  return path.basename(attachmentTitle(entry)) || "attachment-image";
}

function imageMimeTypeForTarget(ref: OrdinaryRunContextReference, target: AttachmentTarget): string | undefined {
  const mimeFromExtension = IMAGE_MIME_BY_EXTENSION[tableTargetExtension(ref, target.targetPath)];
  if (mimeFromExtension !== undefined) {
    return mimeFromExtension;
  }
  if (target.targetPath !== ".") {
    return undefined;
  }
  const metadataMimeType = ref.metadata?.mimeType?.toLowerCase();
  return metadataMimeType !== undefined && Object.values(IMAGE_MIME_BY_EXTENSION).includes(metadataMimeType)
    ? metadataMimeType
    : undefined;
}

function imageDetailFromUnknown(value: unknown): "auto" | "low" | "high" {
  return value === "low" || value === "high" ? value : "auto";
}
