import { stringOrUndefined } from "../../../kernel/values/index.js";
import path from "node:path";
import { imageMimeTypeForExtension } from "../../local-filesystem/index.js";
import type { OrdinaryRunContextReference } from "../../../domain/ordinary/index.js";
import type { ToolExecutor } from "../../../domain/tools/index.js";
import { toolOutputWithAttachments } from "../../../domain/tools/index.js";
import {
  asRecord,
  safeRefToken,
  throwIfAborted,
} from "./local-workspace-common.js";
import {
  assertAttachmentAuthorized,
  attachmentTitle,
  guardContextAttachmentTool,
  requireAttachmentEntry,
  resolveAttachmentTarget,
  tableTargetExtension,
  tableTargetFormat,
  type AttachmentEntry,
  type AttachmentTarget,
  type ContextAttachmentToolOptions,
} from "./context-attachment-access.js";
import { imageDetailFromUnknown, readImageInput } from "./image-input.js";

/** Creates the attachment tool that adds an image to the next model turn. */
export function createReadContextAttachmentImageTool(
  options: ContextAttachmentToolOptions = {},
): ToolExecutor {
  return guardContextAttachmentTool(options, {
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
      const detail = imageDetailFromUnknown(record.detail);
      const mimeType = imageMimeTypeForTarget(entry.ref, target);
      const refId = `context-attachment:${entry.attachmentId}:image:${safeRefToken(target.targetPath)}`;
      const image = await readImageInput({
        absolutePath: target.targetAbsolutePath,
        mimeType,
        supportsVisionInput: options.supportsVisionInput,
        detail,
        filename: imageModelFilename(entry, target),
        inputRef: refId,
        attachmentId: entry.attachmentId,
        abortSignal: context.abortSignal,
      });
      if (!image.readable) {
        return unsupportedImageResult({
          entry,
          target,
          reason: image.reason,
          bytes: image.bytes,
          mimeType,
          detail,
        });
      }
      const output = {
        refId,
        attachmentId: entry.attachmentId,
        kind: entry.ref.kind,
        title: attachmentTitle(entry),
        path: target.targetPath,
        mimeType,
        bytes: image.bytes,
        format: "image",
        readable: true,
        detail,
      };
      return toolOutputWithAttachments(output, [image.attachment]);
    },
  });
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
    detail: input.detail,
  };
}

function imageModelFilename(entry: AttachmentEntry, target: AttachmentTarget): string {
  if (target.targetPath !== ".") {
    return path.posix.basename(target.targetPath) || attachmentTitle(entry);
  }
  return path.basename(attachmentTitle(entry)) || "attachment-image";
}

function imageMimeTypeForTarget(ref: OrdinaryRunContextReference, target: AttachmentTarget): string | undefined {
  const mimeFromExtension = imageMimeTypeForExtension(tableTargetExtension(ref, target.targetPath));
  if (mimeFromExtension !== undefined) {
    return mimeFromExtension;
  }
  if (target.targetPath !== ".") {
    return undefined;
  }
  const metadataMimeType = ref.metadata?.mimeType?.toLowerCase();
  return metadataMimeType !== undefined && imageMimeTypeForExtension(`.${metadataMimeType.slice("image/".length)}`) === metadataMimeType
    ? metadataMimeType
    : undefined;
}
