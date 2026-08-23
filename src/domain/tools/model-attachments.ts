import type { ModelInputAttachment } from "../intelligence/model-input-attachments.js";

const TOOL_MODEL_ATTACHMENTS = Symbol("synech.toolModelAttachments");

type ToolModelAttachmentCarrier = {
  readonly [TOOL_MODEL_ATTACHMENTS]?: readonly ModelInputAttachment[];
};

export function withToolModelAttachments<T extends object>(
  output: T,
  attachments: readonly ModelInputAttachment[]
): T {
  if (attachments.length === 0) {
    return output;
  }
  Object.defineProperty(output, TOOL_MODEL_ATTACHMENTS, {
    value: attachments.map((attachment) => globalThis.structuredClone(attachment)),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return output;
}

export function toolModelAttachmentsFromOutput(output: unknown): readonly ModelInputAttachment[] | undefined {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }
  const attachments = (output as ToolModelAttachmentCarrier)[TOOL_MODEL_ATTACHMENTS];
  if (attachments === undefined || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((attachment) => globalThis.structuredClone(attachment));
}

/** Preserves the out-of-band model carrier while the JSON fact body is normalized. */
export function copyToolModelAttachments<T extends object>(source: unknown, target: T): T {
  const attachments = toolModelAttachmentsFromOutput(source);
  return attachments === undefined ? target : withToolModelAttachments(target, attachments);
}
