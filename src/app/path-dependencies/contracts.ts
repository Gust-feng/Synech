import { createHash } from "node:crypto";
import type { MemoryOwner } from "../../domain/memory/index.js";

export const PATH_DEPENDENCY_SCHEMA_VERSION = "path-dependency/v1" as const;

export const PATH_DEPENDENCY_MAX_TITLE_CHARS = 240;
export const PATH_DEPENDENCY_MAX_METHODOLOGY_CHARS = 50_000;
export const PATH_DEPENDENCY_MAX_TAGS = 24;
export const PATH_DEPENDENCY_MAX_TAG_CHARS = 80;
export const PATH_DEPENDENCY_MAX_SOURCE_REFS = 32;
export const PATH_DEPENDENCY_MAX_EVIDENCE_REFS = 64;

export type PathDependencyFeatureErrorCode =
  | "path_dependency_feature_released"
  | "path_dependency_invalid_input"
  | "path_dependency_owner_deleted"
  | "path_dependency_not_found"
  | "path_dependency_revision_conflict"
  | "path_dependency_snapshot_incompatible"
  | "path_dependency_repository_failure";

export class PathDependencyFeatureError extends Error {
  readonly name = "PathDependencyFeatureError";

  constructor(
    readonly code: PathDependencyFeatureErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Memory ids are opaque record keys, never filesystem paths. Keep the check at
 * the public feature and repository boundaries so an adapter cannot smuggle a
 * path segment into the file-backed repository (or accidentally recreate a
 * deleted id without an explicit update baseline).
 */
export function assertPathDependencyMemoryId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 ||
      value === "." || value === ".." || /[\\/\u0000-\u001f\u007f]/u.test(value)) {
    throw new PathDependencyFeatureError(
      "path_dependency_invalid_input",
      "memoryId must be a non-empty opaque id without path separators or control characters.",
    );
  }
}

export type PathDependencyVerification = {
  /** Model-side observation only; user governance is deletion in Memory Center. */
  readonly status: "not_recorded" | "observed";
};

/**
 * Partial verification supplied by a save command. Evidence references live
 * on the PathDependency record as the single provenance fact source.
 * Persisted records always use the complete PathDependencyVerification shape
 * above.
 */
export type PathDependencyVerificationInput = {
  readonly status: PathDependencyVerification["status"];
};

/** Minimal provenance; it never embeds transcript, tool output or absolute paths. */
export type PathDependencySourceRef = {
  readonly runId: string;
  readonly conversationId?: string;
  readonly title?: string;
};

export type PathDependency = {
  readonly id: string;
  readonly owner: MemoryOwner;
  readonly title: string;
  readonly methodology: string;
  readonly sourceRunRefs: readonly PathDependencySourceRef[];
  readonly verification: PathDependencyVerification;
  readonly evidenceRefs: readonly string[];
  readonly revision: number;
  readonly contentVersion: `sha256:${string}`;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: "agent" | "user";
  readonly tags: readonly string[];
};

export type PathDependencyDocument = {
  readonly schemaVersion: typeof PATH_DEPENDENCY_SCHEMA_VERSION;
  readonly dependency: PathDependency;
};

export type PathDependencySaveInput = {
  readonly owner: MemoryOwner;
  /** Omit for a new dependency; include the current id for an update. */
  readonly memoryId?: string;
  readonly title: string;
  readonly methodology: string;
  readonly sourceRunRefs?: readonly PathDependencySourceRef[];
  readonly verification?: PathDependencyVerificationInput;
  readonly evidenceRefs?: readonly string[];
  readonly tags?: readonly string[];
  /** Required for every update; creation must not guess a baseline. */
  readonly expectedRevision?: number;
  readonly createdBy?: "agent" | "user";
};

export type PathDependencySaveResult =
  | { readonly status: "created" | "updated"; readonly dependency: PathDependency }
  | { readonly status: "conflict"; readonly current: PathDependency };

export type PathDependencyDirectoryEntry = {
  readonly id: string;
  readonly kind: "path_dependency";
  readonly owner: MemoryOwner;
  readonly title: string;
  readonly excerpt: string;
  readonly revision: number;
  readonly contentVersion: PathDependency["contentVersion"];
  readonly verification: PathDependencyVerification["status"];
  readonly tags: readonly string[];
};

export type PathDependencyListQuery = {
  readonly owners?: readonly MemoryOwner[];
  readonly limit?: number;
};

export type PathDependencySearchInput = {
  readonly text: string;
  readonly owners?: readonly MemoryOwner[];
  readonly limit?: number;
};

export type PathDependencySearchMatch = {
  readonly dependency: PathDependency;
  readonly score: number;
  readonly matchedFields: readonly ("title" | "methodology" | "tag")[];
};

export type PathDependencyEvent =
  | { readonly type: "path_dependency.created"; readonly dependency: PathDependency }
  | { readonly type: "path_dependency.updated"; readonly dependency: PathDependency }
  | { readonly type: "path_dependency.deleted"; readonly memoryId: string; readonly owner: MemoryOwner; readonly revision: number };

export interface PathDependencyRepository {
  save(input: { readonly dependency: PathDependency; readonly expectedRevision?: number }): Promise<PathDependencySaveResult>;
  get(memoryId: string): Promise<PathDependency | undefined>;
  list(query?: PathDependencyListQuery): Promise<readonly PathDependency[]>;
  delete(input: { readonly memoryId: string; readonly expectedRevision: number }): Promise<PathDependency | undefined>;
}

export interface PathDependencyFeature {
  readonly commands: {
    save(input: PathDependencySaveInput): Promise<PathDependencySaveResult>;
    delete(input: { readonly memoryId: string; readonly expectedRevision: number }): Promise<void>;
    /** Owner deletion is coordinated by the owning Space / Workspace host flow. */
    deleteByOwner(owner: Exclude<MemoryOwner, { readonly kind: "global" }>): Promise<number>;
  };
  readonly queries: {
    get(memoryId: string): Promise<PathDependency | undefined>;
    list(query?: PathDependencyListQuery): Promise<readonly PathDependency[]>;
    search(input: PathDependencySearchInput): Promise<readonly PathDependencySearchMatch[]>;
    directory(input: {
      readonly owners: readonly MemoryOwner[];
      readonly limit?: number;
      readonly excerptChars?: number;
    }): Promise<readonly PathDependencyDirectoryEntry[]>;
  };
  readonly events: {
    subscribe(listener: (event: PathDependencyEvent) => void): () => void;
  };
  release(): Promise<void>;
}

export function pathDependencyContentVersion(input: Pick<PathDependency, "title" | "methodology" | "tags" | "verification" | "evidenceRefs">): PathDependency["contentVersion"] {
  const value = JSON.stringify({
    title: input.title,
    methodology: input.methodology,
    tags: input.tags,
    verification: input.verification,
    evidenceRefs: input.evidenceRefs,
  });
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
