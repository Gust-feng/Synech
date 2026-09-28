import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Text notice substituted for image content when the active model does not
 * accept image input. The replacement is deliberately a plain-text notice:
 * it must not fake image content, summarize pixels, or silently drop the
 * user's attachment. It lets a text-only model answer the rest of the turn
 * while remaining able to tell the user that the image was not delivered.
 */
export const UNSUPPORTED_IMAGE_PLACEHOLDER =
  "[Image not delivered: the active model does not accept image input. " +
  "The image cannot be inspected in this run; tell the user and suggest " +
  "switching to a vision-capable model if the image content matters.]";

/**
 * Text notice substituted for image content inside the compaction prefix. Pi
 * has no image-aware compaction, so the summarizer can only be told that the
 * image existed and that its content is gone; it must not fake, summarize, or
 * silently drop the user's attachment.
 */
export const COMPACTION_IMAGE_PLACEHOLDER =
  "[Image not carried over: this image belonged to the compacted history and " +
  "context compaction cannot preserve image content. The image content is " +
  "unavailable in this run.]";

/**
 * Replaces every image content block with `placeholderText` and reports how
 * many blocks were replaced. Messages without image content keep their
 * original references and the same array is returned when nothing changed.
 */
export function replaceImageBlocks<TMessage extends AgentMessage>(
  messages: readonly TMessage[],
  placeholderText: string,
): { readonly messages: readonly TMessage[]; readonly replacedImageBlocks: number } {
  let replacedImageBlocks = 0;
  let changed = false;
  const replaced = messages.map((message) => {
    const content = (message as { readonly content?: unknown }).content;
    if (typeof content !== "object" || content === null || !Array.isArray(content)) return message;
    if (!content.some(isImageBlock)) return message;
    changed = true;
    let messageReplacements = 0;
    const replacedContent = content.map((block) => {
      if (!isImageBlock(block)) return block;
      messageReplacements += 1;
      return { type: "text" as const, text: placeholderText };
    });
    replacedImageBlocks += messageReplacements;
    return { ...message, content: replacedContent } as TMessage;
  });
  return { messages: changed ? replaced : messages, replacedImageBlocks };
}

/**
 * Returns the messages with every image content block replaced by
 * {@link UNSUPPORTED_IMAGE_PLACEHOLDER} when the model is text-only.
 * Messages without image content (or with a vision-capable model) keep their
 * original references so callers can detect that nothing changed.
 */
export function replaceUnsupportedImageBlocks<TMessage extends AgentMessage>(
  messages: readonly TMessage[],
  modelInputSupportsImage: boolean,
): readonly TMessage[] {
  if (modelInputSupportsImage) return messages;
  return replaceImageBlocks(messages, UNSUPPORTED_IMAGE_PLACEHOLDER).messages;
}

function isImageBlock(block: unknown): block is { readonly type: "image" } {
  return typeof block === "object" && block !== null &&
    (block as { readonly type?: unknown }).type === "image";
}
