import { createHash } from "node:crypto";

import type { IdFactory } from "../../kernel/id.js";
import { OrdinaryFeatureError } from "./contracts.js";

export type CreateManagedAttachmentDraftInput = {
  readonly originalName: string;
  readonly mimeType?: string;
  readonly content: Uint8Array;
  readonly uploadRequestId?: string;
  readonly uploadFileIndex?: number;
};

export function managedAttachmentDraftId(
  input: Pick<CreateManagedAttachmentDraftInput, "uploadRequestId" | "uploadFileIndex">,
  idFactory: IdFactory,
): string {
  const { uploadRequestId, uploadFileIndex } = input;
  if (uploadRequestId === undefined && uploadFileIndex === undefined) {
    return idFactory("ordinary-managed-attachment");
  }
  if (uploadRequestId === undefined || uploadFileIndex === undefined ||
      uploadRequestId.trim().length === 0 || uploadRequestId.length > 200 || uploadRequestId.includes("\0") ||
      !Number.isSafeInteger(uploadFileIndex) || uploadFileIndex < 0 || uploadFileIndex > 10_000) {
    throw new OrdinaryFeatureError(
      "ordinary_managed_attachment_unavailable",
      "Managed attachment upload identity is invalid.",
    );
  }
  const digest = createHash("sha256")
    .update("ordinary-managed-upload/v1\0")
    .update(uploadRequestId)
    .update("\0")
    .update(String(uploadFileIndex))
    .digest("base64url")
    .slice(0, 32);
  return `ordinary-managed-attachment-${digest}`;
}
