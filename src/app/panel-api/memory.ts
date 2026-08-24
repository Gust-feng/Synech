import type { MemoryOwner as DomainMemoryOwner } from "../../domain/memory/index.js";
import type { AgentNotebook } from "../agent-notes/index.js";
import type { OrdinaryMemoryFact } from "../ordinary-agent/index.js";
import type { PathDependency as DomainPathDependency } from "../path-dependencies/index.js";

export type MemoryOwner =
  | Extract<DomainMemoryOwner, { readonly kind: "global" }>
  | (Exclude<DomainMemoryOwner, { readonly kind: "global" }> & { readonly title?: string });

export type MemoryOwnerSelection = DomainMemoryOwner;
export type MemoryNote = AgentNotebook;
export type MemoryVerification = DomainPathDependency["verification"];
export type MemoryVerificationStatus = MemoryVerification["status"];
export type MemorySourceRef = string | DomainPathDependency["sourceRunRefs"][number];

export type MemoryReferenceFact = Pick<
  OrdinaryMemoryFact,
  "factId" | "kind" | "runId" | "conversationId" | "revision" | "title" | "recordedAt" | "note"
>;

export type PathDependency = Omit<DomainPathDependency, "owner"> & {
  readonly kind: "path_dependency";
  readonly owner: MemoryOwner;
  readonly excerpt: string;
  readonly sourceRunCount: number;
  readonly evidenceCount: number;
  readonly readCount: number;
  readonly useCount: number;
  readonly references: readonly MemoryReferenceFact[];
};

export type DeletedMemoryHistory = {
  readonly historyKey: string;
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
  readonly owners: readonly MemoryOwner[];
  readonly globalNote: MemoryNote;
  readonly ownerNote?: MemoryNote;
  readonly pathDependencies: readonly PathDependency[];
  readonly history: readonly DeletedMemoryHistory[];
};

export type MemorySnapshotResponse = Omit<MemorySnapshot, "owner"> & {
  readonly ok: true;
  readonly owner: MemoryOwner | null;
  readonly scopes: readonly DomainMemoryOwner[];
  readonly notes: {
    readonly global: MemoryNote;
    readonly owner?: MemoryNote;
  };
};

export type PathDependencyDeleteInput = {
  readonly conversationId?: string;
  readonly ownerKind?: "space" | "workspace";
  readonly ownerId?: string;
  readonly expectedRevision: number;
};

export type PathDependencyResponse = {
  readonly ok: true;
  readonly dependency: PathDependency;
};
