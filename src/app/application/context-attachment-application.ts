import type {
  OrdinaryAgentFeature,
  OrdinaryManagedAttachmentRecord,
} from "../ordinary-agent/index.js";

export type ContextAttachmentUploadFile = {
  readonly filename: string;
  readonly contentType?: string;
  readonly body: Uint8Array;
};

export type ContextAttachmentUploadPreviewInput = {
  readonly record: OrdinaryManagedAttachmentRecord;
  readonly path: string;
};

export type ContextAttachmentUploadApplicationErrorCode =
  | "uploaded_attachment_missing"
  | "attachment_upload_compensation_failed";

export class ContextAttachmentUploadApplicationError extends Error {
  readonly name = "ContextAttachmentUploadApplicationError";

  constructor(
    readonly code: ContextAttachmentUploadApplicationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type ContextAttachmentUploadApplication = {
  upload<T>(input: {
    readonly uploadRequestId: string;
    readonly files: readonly ContextAttachmentUploadFile[];
    readonly createPreview: (input: ContextAttachmentUploadPreviewInput) => Promise<T>;
  }): Promise<readonly T[]>;
};

export function createContextAttachmentUploadApplication(input: {
  readonly ordinaryAgentFeature: {
    readonly commands: Pick<OrdinaryAgentFeature["commands"], "createManagedAttachmentDraft" | "discardManagedAttachmentDraft">;
  };
  readonly resolveManagedAttachmentPath: (attachmentId: string) => Promise<string | undefined>;
}): ContextAttachmentUploadApplication {
  return {
    upload: async <T>({ uploadRequestId, files, createPreview }: {
      readonly uploadRequestId: string;
      readonly files: readonly ContextAttachmentUploadFile[];
      readonly createPreview: (input: ContextAttachmentUploadPreviewInput) => Promise<T>;
    }): Promise<readonly T[]> => {
      const attachments: T[] = [];
      const createdAttachmentIds: string[] = [];
      try {
        for (const [uploadFileIndex, file] of files.entries()) {
          const draft = await input.ordinaryAgentFeature.commands.createManagedAttachmentDraft({
            originalName: file.filename,
            ...(file.contentType === undefined ? {} : { mimeType: file.contentType }),
            content: file.body,
            uploadRequestId,
            uploadFileIndex,
          });
          if (draft.created) createdAttachmentIds.push(draft.record.attachmentId);
          const savedPath = await input.resolveManagedAttachmentPath(draft.record.attachmentId);
          if (savedPath === undefined) {
            throw new ContextAttachmentUploadApplicationError(
              "uploaded_attachment_missing",
              "上传附件保存失败。",
            );
          }
          attachments.push(await createPreview({ record: draft.record, path: savedPath }));
        }
        return attachments;
      } catch (error) {
        const cleanupErrors = (await Promise.allSettled(createdAttachmentIds.map((attachmentId) =>
          input.ordinaryAgentFeature.commands.discardManagedAttachmentDraft(attachmentId)))).flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []);
        if (cleanupErrors.length > 0) {
          throw new ContextAttachmentUploadApplicationError(
            "attachment_upload_compensation_failed",
            "附件上传失败，且已创建的草稿无法全部清理。",
            { cause: new AggregateError([error, ...cleanupErrors]) },
          );
        }
        throw error;
      }
    },
  };
}
