/** JSON-safe context accepted when an Ordinary turn is submitted. */
export type OrdinaryRunContextReferenceInput = {
  readonly attachmentId?: string;
  readonly ref: string;
  readonly pathGranted?: boolean;
  readonly automaticSpaceReference?: boolean;
  readonly sourceIdentity?: string;
  readonly kind: "workspace" | "file" | "project" | "web";
  readonly title?: string;
  readonly summary?: string;
  readonly metadata?: {
    readonly byteLength?: number;
    readonly mimeType?: string;
    readonly available?: boolean;
    readonly truncated?: boolean;
  };
  readonly readonlyPreview?: { readonly title?: string; readonly text: string };
};

export type OrdinaryRunContextInput = {
  readonly contextRefs?: readonly OrdinaryRunContextReferenceInput[];
  readonly permissionBoundaryRefs?: readonly string[];
};
