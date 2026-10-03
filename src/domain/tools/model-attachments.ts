import { z } from "zod";
import type { ModelInputAttachment } from "../model-input/index.js";
import type { ToolCallResult, ToolExecutionResult, ToolExecutorOutput } from "./contracts.js";

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("data"), mimeType: z.string().min(1), data: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("url"), url: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("file_id"), fileId: z.string().min(1) }).strict(),
]);
const fields = {
  source: sourceSchema,
  attachmentId: z.string().min(1).optional(),
  inputRef: z.string().min(1).optional(),
  byteLength: z.number().int().nonnegative().optional(),
};
const attachmentsSchema = z.array(z.discriminatedUnion("kind", [
  z.object({ ...fields, kind: z.literal("image"), filename: z.string().optional(),
    detail: z.enum(["auto", "low", "high", "original"]).optional() }).strict(),
  z.object({ ...fields, kind: z.literal("audio"), filename: z.string() }).strict(),
  z.object({ ...fields, kind: z.literal("file"), filename: z.string(),
    detail: z.enum(["low", "high"]).optional() }).strict(),
]));

/** Explicit fields survive normal copies; business output stays free of binary data. */
export function toolOutputWithAttachments(
  output: unknown,
  modelAttachments: readonly ModelInputAttachment[],
): ToolExecutorOutput {
  return { kind: "tool_output", output, modelAttachments };
}

/** Executor/MCP data is validated once at the ToolCenter boundary. */
export function normalizeToolModelAttachments(value: unknown): readonly ModelInputAttachment[] | undefined {
  if (value === undefined) return undefined;
  const attachments = attachmentsSchema.parse(value);
  return attachments.length === 0 ? undefined : attachments;
}

/** The adapter uses this at every product/Session-details exit, never during live delivery. */
export function durableToolCallResult(result: ToolExecutionResult): ToolCallResult {
  const { modelAttachments: _modelAttachments, ...fact } = result;
  return globalThis.structuredClone(fact);
}
