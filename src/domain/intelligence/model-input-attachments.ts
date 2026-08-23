export type ModelInputAttachmentSource =
  | {
      readonly kind: "data";
      readonly mimeType: string;
      readonly data: string;
    }
  | {
      readonly kind: "url";
      readonly url: string;
    }
  | {
      readonly kind: "file_id";
      readonly fileId: string;
    };

export type ModelInputAttachment =
  | {
      readonly kind: "image";
      readonly source: ModelInputAttachmentSource;
      readonly attachmentId?: string;
      readonly inputRef?: string;
      readonly filename?: string;
      readonly detail?: "auto" | "low" | "high" | "original";
      readonly byteLength?: number;
    }
  | {
      readonly kind: "audio";
      readonly source: ModelInputAttachmentSource;
      readonly attachmentId?: string;
      readonly inputRef?: string;
      readonly filename: string;
      readonly byteLength?: number;
    }
  | {
      readonly kind: "file";
      readonly source: ModelInputAttachmentSource;
      readonly attachmentId?: string;
      readonly inputRef?: string;
      readonly filename: string;
      readonly detail?: "low" | "high";
      readonly byteLength?: number;
  };

/** JSON-safe identity for an inline image already written to a Pi Session. */
export type ModelInputAttachmentRef = {
  readonly kind: "image";
  readonly attachmentId?: string;
  readonly inputRef?: string;
  readonly mimeType: string;
  readonly byteLength?: number;
  readonly sha256: string;
};