import path from "node:path";
import { CodedExecutionError } from "../execution-errors/index.js";
import { imageMimeTypeForPath } from "../local-filesystem/index.js";
import { resolvedSupportsVisionInput, type ResolvedModelCapabilities } from "../../domain/config/index.js";
import type { ModelInputAttachment, ModelMessage } from "../../domain/intelligence/index.js";
import {
  type OrdinaryRunContext,
  type OrdinaryRunContextReference,
} from "../../domain/ordinary/index.js";
import { isConversationOwnerContextRef } from "../../domain/ordinary/index.js";
import {
  attachmentEntries,
  runContextAttachmentRead,
  type ContextAttachmentToolOptions,
} from "../tool-center/adapters/context-attachment-access.js";
import { readImageInput } from "../tool-center/adapters/image-input.js";

type ImageAttachmentReadOptions = Pick<ContextAttachmentToolOptions,
  "workspaceRoot" | "resolveManagedAttachmentPath" | "readAuthorization" | "pathAuthorization" | "mutationCoordinator"
> & {
  readonly runContext: OrdinaryRunContext;
  readonly abortSignal?: AbortSignal;
};

export async function attachOrdinaryFileInputsToModelMessages(input: ImageAttachmentReadOptions & {
  readonly messages: readonly ModelMessage[];
  readonly modelCapabilities?: ResolvedModelCapabilities;
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
  if (resolvedSupportsVisionInput(input.modelCapabilities) !== true) {
    // A text-only model cannot consume the images right now, but the bytes
    // must still be resolved and attached: they enter the Pi durable Session
    // so a later vision-capable model in the same conversation can rebuild
    // and inspect them. Model visibility is substituted later by the loop's
    // context boundary with an observable text notice. Resolution failures
    // are reported as a text notice instead of failing the run, so the
    // text-only model keeps answering the rest of the turn.
    const attachments = await resolveImageAttachments({
      ...input,
      workspaceRoot: input.workspaceRoot ?? process.cwd(),
    });
    const resolved = attachments.items.length === 0
      ? input.messages
      : appendAttachmentsToCurrentUserMessage(input.messages, attachments.items);
    return attachments.failures.length === 0
      ? resolved
      : appendNoticeToCurrentUserMessage(resolved, undeliverableAttachmentNotice(attachments.failures));
  }
  const attachments = await resolveImageAttachments({
    ...input,
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
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

async function resolveImageAttachments(input: ImageAttachmentReadOptions): Promise<ResolvedImageAttachments> {
  const attachments: ModelInputAttachment[] = [];
  const failures: string[] = [];
  for (const entry of attachmentEntries(input.runContext)) {
    const ref = entry.ref;
    if (!isImageContextRef(ref)) continue;
    try {
      const attachment = await runContextAttachmentRead({
        ...input,
        entry,
        context: {
          callerAgentId: "ordinary",
          traceId: input.runContext.traceId ?? input.runContext.contextId,
          goalId: input.runContext.goalId ?? input.runContext.contextId,
          abortSignal: input.abortSignal,
        },
      }, async (target): Promise<ModelInputAttachment> => {
        const mimeType = imageMimeTypeFor(ref, target.targetAbsolutePath);
        // Resolve bytes even for text-only turns: Pi retains them for a later visual model.
        const image = await readImageInput({
          absolutePath: target.targetAbsolutePath,
          mimeType,
          attachmentId: ref.attachmentId,
          inputRef: ref.ref,
          filename: path.basename(target.targetAbsolutePath),
          detail: "auto",
          abortSignal: input.abortSignal,
        });
        if (!image.readable) throw new Error(image.reason);
        return image.attachment;
      });
      attachments.push(attachment);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      failures.push(`${ref.ref}: ${error instanceof Error ? error.message : "file could not be read"}`);
    }
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
  return imageMimeTypeForPath(ref.ref) !== undefined;
}

function imageMimeTypeFor(ref: OrdinaryRunContextReference, absolutePath: string): string | undefined {
  const metadataMimeType = ref.metadata?.mimeType;
  if (metadataMimeType !== undefined && metadataMimeType.startsWith("image/")) {
    return metadataMimeType;
  }
  return imageMimeTypeForPath(absolutePath);
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
