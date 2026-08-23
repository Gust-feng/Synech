/**
 * Ordinary-owned, JSON-safe context facts accepted when a turn is submitted.
 * This contract remains independent of Electron and Panel protocol details.
 */
export type OrdinaryRunContextReferenceInput = {
  readonly attachmentId?: string;
  readonly ref: string;
  /** Derived by the Host from an explicit permission, never trusted from a client. */
  readonly pathGranted?: boolean;
  /** Marks a reference injected from the conversation owner rather than this turn. */
  readonly automaticSpaceReference?: boolean;
  /** Frozen filesystem identity used by the Host authorization boundary. */
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
  readonly readonlyPreview?: {
    readonly title?: string;
    readonly text: string;
  };
};

export type OrdinaryRunContextInput = {
  readonly contextRefs?: readonly OrdinaryRunContextReferenceInput[];
  readonly permissionBoundaryRefs?: readonly string[];
};
