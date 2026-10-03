import { promises as fs } from "node:fs";
import type { ModelInputAttachment } from "../../../domain/intelligence/index.js";
import { throwIfAborted } from "./local-workspace-common.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Shared image input policy after the caller has authorized and locked its path. */
export async function readImageInput(input: {
  readonly absolutePath: string;
  readonly mimeType?: string;
  readonly supportsVisionInput?: boolean;
  readonly detail: "auto" | "low" | "high";
  readonly filename: string;
  readonly inputRef: string;
  readonly attachmentId?: string;
  readonly abortSignal?: AbortSignal;
}): Promise<
  | { readonly readable: true; readonly bytes: number; readonly attachment: ModelInputAttachment }
  | { readonly readable: false; readonly reason: string; readonly bytes?: number }
> {
  throwIfAborted(input.abortSignal);
  if (input.supportsVisionInput === false) return { readable: false, reason: "model_does_not_support_vision_input" };
  const stat = await fs.stat(input.absolutePath);
  if (!stat.isFile()) return { readable: false, reason: "not_a_file", bytes: stat.size };
  if (input.mimeType === undefined) return { readable: false, reason: "not_an_image", bytes: stat.size };
  if (stat.size > MAX_IMAGE_BYTES) return { readable: false, reason: "image_file_too_large", bytes: stat.size };
  const buffer = await fs.readFile(input.absolutePath, { signal: input.abortSignal });
  throwIfAborted(input.abortSignal);
  if (buffer.length > MAX_IMAGE_BYTES) return { readable: false, reason: "image_file_too_large", bytes: buffer.length };
  return {
    readable: true,
    bytes: buffer.length,
    attachment: {
      kind: "image",
      source: { kind: "data", mimeType: input.mimeType, data: buffer.toString("base64") },
      filename: input.filename,
      inputRef: input.inputRef,
      ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }),
      detail: input.detail,
      byteLength: buffer.length,
    },
  };
}

export function imageDetailFromUnknown(value: unknown): "auto" | "low" | "high" {
  return value === "low" || value === "high" ? value : "auto";
}
