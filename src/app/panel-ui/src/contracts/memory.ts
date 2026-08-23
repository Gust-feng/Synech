/**
 * Panel-facing Memory Center DTOs.
 *
 * Memory Center composes Agent Notes and path dependencies, but it does not
 * own either feature's repository or state.  These types intentionally model
 * only the HTTP facts needed by the panel.
 */

export type MemoryOwner =
  | { readonly kind: "global" }
  | { readonly kind: "space" | "workspace"; readonly id: string; readonly title?: string };

/** A browser may only select one of the owner identities returned by the
 * Memory Center query; it never invents an owner id. */
export type MemoryOwnerSelection =
  | { readonly kind: "global" }
  | { readonly kind: "space" | "workspace"; readonly id: string };

export type MemoryNote = {
  readonly scope: MemoryOwner;
  readonly content: string;
  readonly version: string;
  readonly updatedAt?: string;
};

export type MemoryVerificationStatus = "not_recorded" | "observed";

/** The API currently returns an object; the string form keeps the client
 * compatible with the small provisional contract used by the first panel. */
export type MemoryVerification =
  | MemoryVerificationStatus
  | {
      readonly status: MemoryVerificationStatus;
    };

export type MemorySourceRef =
  | string
  | {
      readonly runId: string;
      readonly conversationId?: string;
      readonly title?: string;
    };

export type MemoryReferenceFact = {
  readonly factId?: string;
  readonly kind?: "read" | "applied" | string;
  readonly runId?: string;
  readonly conversationId?: string;
  readonly revision?: number;
  readonly title?: string;
  readonly recordedAt?: string;
  readonly note?: string;
};

export type PathDependency = {
  readonly id: string;
  readonly owner: MemoryOwner;
  readonly title: string;
  readonly methodology?: string;
  readonly excerpt?: string;
  readonly revision: number;
  readonly verification?: MemoryVerification;
  readonly tags?: readonly string[];
  readonly sourceRunRefs?: readonly MemorySourceRef[];
  readonly evidenceRefs?: readonly string[];
  readonly sourceRunCount?: number;
  readonly evidenceCount?: number;
  readonly readCount?: number;
  readonly useCount?: number;
  readonly references?: readonly MemoryReferenceFact[];
  readonly contentVersion?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly createdBy?: "agent" | "user" | string;
};

/** A durable Ordinary fact whose path-dependency body has since been deleted. */
export type DeletedMemoryHistory = {
  /** memory id plus owner key; prevents a deleted generation from colliding with another owner. */
  readonly historyKey?: string;
  readonly id: string;
  readonly kind: "path_dependency";
  readonly owner: MemoryOwner;
  readonly title: string;
  readonly revision: number;
  readonly available: false;
  readonly readCount: number;
  readonly useCount: number;
  readonly references: readonly MemoryReferenceFact[];
};

export type MemorySnapshot = {
  readonly conversationId?: string;
  readonly owner?: MemoryOwner;
  /** Registered scopes available when no conversation context is selected. */
  readonly owners?: readonly MemoryOwner[];
  readonly globalNote?: MemoryNote;
  readonly ownerNote?: MemoryNote;
  readonly pathDependencies: readonly PathDependency[];
  /** Historical read/use facts remain visible after direct memory deletion. */
  readonly history?: readonly DeletedMemoryHistory[];
};

export type PathDependencyDeleteInput = {
  readonly conversationId?: string;
  readonly ownerKind?: "space" | "workspace";
  readonly ownerId?: string;
  readonly expectedRevision: number;
};
