import { promises as fs } from "node:fs";
import path from "node:path";
import { CodedExecutionError } from "../execution-errors/index.js";
import type { ModelCapabilities } from "../../domain/config/index.js";
import type { ModelInputAttachment, ModelMessage } from "../../domain/intelligence/index.js";
import {
  managedAttachmentId,
  parseContextReference,
  parsePermissionBoundaryRef,
  serializeContextReference,
  type OrdinaryRunContext,
  type OrdinaryRunContextReference,
} from "../../domain/ordinary/index.js";
import { isConversationOwnerContextRef } from "../../domain/ordinary/index.js";

const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export async function attachOrdinaryFileInputsToModelMessages(input: {
  readonly messages: readonly ModelMessage[];
  readonly runContext: OrdinaryRunContext;
  readonly modelCapabilities?: ModelCapabilities;
  readonly workspaceRoot?: string;
  readonly resolveManagedAttachmentPath?: (attachmentId: string) => Promise<string | undefined>;
  readonly readAuthorization?: {
    assertReadAllowed(attachmentId: string): void | Promise<void>;
  };
}): Promise<readonly ModelMessage[]> {
  const imageRefs = input.runContext.contextRefs.filter(isImageContextRef);
  if (imageRefs.length === 0) {
    return input.messages;
  }
  if (input.modelCapabilities === undefined) {
    // Capability is unknown: the run cannot claim that image delivery works,
    // so it must not silently drop the user's attachments.
    throw new CodedExecutionError(
      "model_vision_input_unsupported",
      "This run contains image attachments, but the frozen model capability is unknown.",
    );
  }
  if (input.modelCapabilities.supportsVisionInput !== true) {
    // A text-only model cannot consume the images right now, but the bytes
    // must still be resolved and attached: they enter the Pi durable Session
    // so a later vision-capable model in the same conversation can rebuild
    // and inspect them. Model visibility is substituted later by the loop's
    // context boundary with an observable text notice. Resolution failures
    // are reported as a text notice instead of failing the run, so the
    // text-only model keeps answering the rest of the turn.
    const attachments = await resolveImageAttachments({
      runContext: input.runContext,
      workspaceRoot: input.workspaceRoot ?? process.cwd(),
      resolveManagedAttachmentPath: input.resolveManagedAttachmentPath,
      readAuthorization: input.readAuthorization,
    });
    const resolved = attachments.items.length === 0
      ? input.messages
      : appendAttachmentsToCurrentUserMessage(input.messages, attachments.items);
    return attachments.failures.length === 0
      ? resolved
      : appendNoticeToCurrentUserMessage(resolved, undeliverableAttachmentNotice(attachments.failures));
  }
  const attachments = await resolveImageAttachments({
    runContext: input.runContext,
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    resolveManagedAttachmentPath: input.resolveManagedAttachmentPath,
    readAuthorization: input.readAuthorization,
  });
  if (attachments.failures.length > 0) {
    throw new CodedExecutionError(
      "model_input_attachment_unavailable",
      `Image attachments could not be delivered: ${attachments.failures.join("; ")}`,
    );
  }
  if (attachments.items.length === 0) {
    // Every image reference belongs to the Space standing context and was
    // deliberately skipped; those are not this turn's attachments.
    return input.messages;
  }
  return appendAttachmentsToCurrentUserMessage(input.messages, attachments.items);
}

type ResolvedImageAttachments = {
  readonly items: readonly ModelInputAttachment[];
  readonly failures: readonly string[];
};

async function resolveImageAttachments(input: {
  readonly runContext: OrdinaryRunContext;
  readonly workspaceRoot: string;
  readonly resolveManagedAttachmentPath?: (attachmentId: string) => Promise<string | undefined>;
  readonly readAuthorization?: {
    assertReadAllowed(attachmentId: string): void | Promise<void>;
  };
}): Promise<ResolvedImageAttachments> {
  const attachments: ModelInputAttachment[] = [];
  const failures: string[] = [];
  for (const ref of input.runContext.contextRefs) {
    if (!isImageContextRef(ref)) continue;
    if (ref.attachmentId !== undefined) {
      try {
        await input.readAuthorization?.assertReadAllowed(ref.attachmentId);
      } catch (error) {
        failures.push(`${ref.ref}: ${error instanceof Error ? error.message : "read authorization failed"}`);
        continue;
      }
    }
    const resolved = await resolveReadableFileRef(
      ref,
      input.workspaceRoot,
      input.runContext.permissionBoundaryRefs,
      input.resolveManagedAttachmentPath,
    );
    if (resolved === undefined) {
      failures.push(`${ref.ref}: file is unavailable or not authorized`);
      continue;
    }
    const mimeType = imageMimeTypeFor(ref, resolved.absolutePath);
    if (mimeType === undefined) {
      failures.push(`${ref.ref}: image MIME type could not be determined`);
      continue;
    }
    const stat = await fs.stat(resolved.absolutePath).catch(() => undefined);
    if (stat?.isFile() !== true) {
      failures.push(`${ref.ref}: not a readable file`);
      continue;
    }
    if (stat.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      failures.push(`${ref.ref}: exceeds the ${MAX_IMAGE_ATTACHMENT_BYTES} byte image limit`);
      continue;
    }
    const data = await fs.readFile(resolved.absolutePath).catch(() => undefined);
    if (data === undefined) {
      failures.push(`${ref.ref}: file could not be read`);
      continue;
    }
    attachments.push({
      kind: "image",
      attachmentId: ref.attachmentId,
      inputRef: ref.ref,
      source: {
        kind: "data",
        mimeType,
        data: data.toString("base64"),
      },
      filename: path.basename(resolved.absolutePath),
      detail: "auto",
      byteLength: stat.size,
    });
  }
  return { items: attachments, failures };
}

/**
 * Only explicitly user-attached image refs are auto-attached to the model
 * message. Space-authorized references（automaticSpaceReference）stay visible
 * in the reference list and can be read on demand through attachment tools,
 * but must not silently ride along every turn of a new conversation.
 */
function isImageContextRef(ref: OrdinaryRunContextReference): boolean {
  if (ref.kind !== "file") return false;
  if (isConversationOwnerContextRef(ref)) return false;
  if (ref.metadata?.mimeType?.startsWith("image/") === true) return true;
  return IMAGE_MIME_BY_EXTENSION[path.extname(ref.ref).toLowerCase()] !== undefined;
}

function imageMimeTypeFor(ref: OrdinaryRunContextReference, absolutePath: string): string | undefined {
  const metadataMimeType = ref.metadata?.mimeType;
  if (metadataMimeType !== undefined && metadataMimeType.startsWith("image/")) {
    return metadataMimeType;
  }
  return IMAGE_MIME_BY_EXTENSION[path.extname(absolutePath).toLowerCase()];
}

async function resolveReadableFileRef(
  ref: OrdinaryRunContextReference,
  workspaceRoot: string,
  permissionRefs: readonly string[],
  resolveManagedAttachmentPath: ((attachmentId: string) => Promise<string | undefined>) | undefined,
): Promise<{ readonly absolutePath: string } | undefined> {
  if (ref.kind !== "file") {
    return undefined;
  }
  const parsed = parseContextReference(ref.ref, ref.kind);
  const attachmentId = parsed?.scheme === "uploaded_attachment"
    ? parsed.attachmentId
    : managedAttachmentId(ref.ref);
  if (attachmentId !== undefined) {
    if (!hasReadPermission(permissionRefs, `uploaded-attachment:${attachmentId}`)) return undefined;
    const absolutePath = await resolveManagedAttachmentPath?.(attachmentId);
    return absolutePath !== undefined && path.isAbsolute(absolutePath)
      ? { absolutePath: path.resolve(absolutePath) }
      : undefined;
  }
  if (parsed?.scheme === "local_file") {
    const absolutePath = parsed.path;
    if (!path.isAbsolute(absolutePath) || !hasReadPermission(permissionRefs, serializeContextReference(parsed))) {
      return undefined;
    }
    return { absolutePath: path.resolve(absolutePath) };
  }
  if (parsed?.scheme === "file") {
    const relativePath = parsed.path;
    if (!hasReadPermission(permissionRefs, serializeContextReference(parsed))) {
      return undefined;
    }
    return resolveWorkspaceRelativeFile(workspaceRoot, relativePath);
  }
  if (parsed?.scheme === "workspace") {
    const relativePath = parsed.value;
    if (relativePath.length === 0 || relativePath === "current" || relativePath.startsWith("goal-")) {
      return undefined;
    }
    if (!hasReadPermission(permissionRefs, "workspace:current-task")) {
      return undefined;
    }
    return resolveWorkspaceRelativeFile(workspaceRoot, relativePath);
  }
  return undefined;
}

function hasReadPermission(permissionRefs: readonly string[], target: string): boolean {
  return permissionRefs.some((value) => {
    const permission = parsePermissionBoundaryRef(value);
    return permission?.kind === "access" && permission.mode === "read" && permission.target === target;
  });
}

function resolveWorkspaceRelativeFile(
  workspaceRoot: string,
  relativePath: string
): { readonly absolutePath: string } | undefined {
  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return { absolutePath };
}

function appendAttachmentsToCurrentUserMessage(
  messages: readonly ModelMessage[],
  attachments: readonly ModelInputAttachment[]
): readonly ModelMessage[] {
  let targetIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) {
    return messages;
  }
  return messages.map((message, index) => {
    if (index !== targetIndex) {
      return message;
    }
    return {
      ...message,
      attachments: [...(message.attachments ?? []), ...attachments],
    };
  });
}

function undeliverableAttachmentNotice(failures: readonly string[]): string {
  return `[${failures.length} image attachment(s) could not be delivered: ` +
    `${failures.join("; ")}. Tell the user which images were not delivered.]`;
}

function appendNoticeToCurrentUserMessage(
  messages: readonly ModelMessage[],
  notice: string,
): readonly ModelMessage[] {
  let targetIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) {
    return messages;
  }
  return messages.map((message, index) => {
    if (index !== targetIndex) {
      return message;
    }
    return {
      ...message,
      content: message.content.length === 0 ? notice : `${message.content}\n\n${notice}`,
    };
  });
}
