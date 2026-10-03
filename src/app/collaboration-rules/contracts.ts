/** User-authored standing rules are distinct from historical Memory. */
export type CollaborationRuleScope =
  | { readonly kind: "global" }
  | { readonly kind: "space"; readonly id: string }
  /**
   * Workspace scope is deliberately independent from MemoryOwner and
   * ConversationOwner. It identifies the external AGENTS.md resource only;
   * it is not a conversation, run, or durable-memory owner.
   */
  | { readonly kind: "workspace"; readonly id: string };
export type CollaborationRuleOwner = Exclude<CollaborationRuleScope, { readonly kind: "global" }>;
export type CollaborationRuleVersion = `sha256:${string}`;

/**
 * Durable location of one rules document.
 *
 * Global/Space rules live in the managed Product Home store; Workspace rules are
 * the root AGENTS.md of the mounted directory and are never mirrored internally.
 */
export type CollaborationRulesSource =
  | { readonly kind: "managed" }
  | { readonly kind: "workspace_file"; readonly path: string };

export type CollaborationRulesDocument = {
  readonly scope: CollaborationRuleScope;
  readonly content: string;
  readonly version: CollaborationRuleVersion;
  readonly updatedAt: string | undefined;
  /** Optional only so existing fixtures can omit it; every real query resolves it. */
  readonly source?: CollaborationRulesSource;
};

export type CollaborationRulesWriteInput = {
  readonly scope: CollaborationRuleScope;
  readonly content: string;
  readonly expectedVersion: CollaborationRuleVersion;
};

export type CollaborationRulesRepositoryWriteInput = CollaborationRulesWriteInput & {
  readonly updatedAt: string;
};

export type CollaborationRulesWriteResult =
  | { readonly status: "saved"; readonly document: CollaborationRulesDocument }
  | { readonly status: "conflict"; readonly current: CollaborationRulesDocument };

export type CollaborationRulesDeleteInput = {
  readonly scope: CollaborationRuleScope;
  readonly expectedVersion: CollaborationRuleVersion;
};

export type CollaborationRulesDeleteResult =
  | { readonly status: "deleted"; readonly document: CollaborationRulesDocument }
  | { readonly status: "conflict"; readonly current: CollaborationRulesDocument };

/**
 * Per-scope mechanical pre-budget for the managed store. Global and owner rules
 * can both contribute, so this stays deliberately small; writes fail instead of
 * silently truncating.
 */
export const COLLABORATION_RULES_MAX_CHARS = 2_000;

/** Workspace root AGENTS.md budget; over-budget writes fail instead of truncating. */
export const COLLABORATION_RULES_WORKSPACE_MAX_TOKENS = 8_000;

/** Workspace rules have exactly one file; no nested inheritance and no internal copy. */
export const WORKSPACE_COLLABORATION_RULES_FILE_NAME = "AGENTS.md";

/** Host-supplied tokenizer; the rules contract never imports a provider tokenizer. */
export type CollaborationRulesTokenCounter = (text: string) => number;

export type CollaborationRuleWorkspaceScope = Extract<CollaborationRuleScope, { readonly kind: "workspace" }>;

export type WorkspaceRulesWriteInput = Omit<CollaborationRulesWriteInput, "scope"> & {
  readonly scope: CollaborationRuleWorkspaceScope;
};

export type WorkspaceRulesDeleteInput = Omit<CollaborationRulesDeleteInput, "scope"> & {
  readonly scope: CollaborationRuleWorkspaceScope;
};

/**
 * Narrow document-I/O seam for the single external Workspace rules file.
 *
 * The Application decides managed-vs-workspace storage, admission and budget; it
 * never sees paths, mounts or leases. The Host adapter owns mount resolution, source
 * identity re-verification, the shared path lease, CAS against the original content
 * and the atomic write, and it reports unavailable/unsupported as structured errors.
 */
export type WorkspaceRulesPort = {
  get(workspaceId: string): Promise<CollaborationRulesDocument>;
  write(command: WorkspaceRulesWriteInput): Promise<CollaborationRulesWriteResult>;
  delete(command: WorkspaceRulesDeleteInput): Promise<CollaborationRulesDeleteResult>;
};

/** Structured failure raised by the Application boundary; never a display string. */
export type CollaborationRulesApplicationErrorCode =
  | "collaboration_rules_scope_unsupported"
  | "collaboration_rules_scope_unavailable"
  | "collaboration_rules_capacity_exceeded";

export class CollaborationRulesApplicationError extends Error {
  constructor(
    readonly code: CollaborationRulesApplicationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CollaborationRulesApplicationError";
  }
}

export function assertCollaborationRuleScope(value: unknown): asserts value is CollaborationRuleScope {
  const candidate = typeof value === "object" && value !== null
    ? value as { readonly kind?: unknown; readonly id?: unknown }
    : undefined;
  const valid = candidate !== undefined && (
    candidate.kind === "global"
      ? candidate.id === undefined
      : (candidate.kind === "space" || candidate.kind === "workspace") &&
        typeof candidate.id === "string" && candidate.id.length > 0
  );
  if (!valid) {
    throw new CollaborationRulesError(
      "collaboration_rule_invalid_scope",
      "Collaboration-rule scope must be global or a concrete Space/Workspace resource.",
    );
  }
}

export interface CollaborationRulesRepository {
  read(scope: CollaborationRuleScope): Promise<CollaborationRulesDocument>;
  write(input: CollaborationRulesRepositoryWriteInput): Promise<CollaborationRulesWriteResult>;
  delete(input: CollaborationRulesDeleteInput): Promise<CollaborationRulesDeleteResult>;
  deleteByOwner(owner: CollaborationRuleOwner): Promise<void>;
}

export type CollaborationRulesStartupSnapshot = {
  /** User-layer standing context; empty rules produce no model-visible block. */
  readonly injection: string | undefined;
};

export type CollaborationRulesFeature = {
  readonly queries: {
    get(scope: CollaborationRuleScope): Promise<CollaborationRulesDocument>;
  };
  readonly commands: {
    write(input: CollaborationRulesWriteInput): Promise<CollaborationRulesWriteResult>;
    delete(input: CollaborationRulesDeleteInput): Promise<CollaborationRulesDeleteResult>;
    deleteByOwner(owner: CollaborationRuleOwner): Promise<void>;
  };
};

export class CollaborationRulesError extends Error {
  constructor(
    readonly code:
      | "collaboration_rule_too_large"
      | "collaboration_rule_io_failure"
      | "collaboration_rule_invalid_scope"
      | "collaboration_rule_owner_deleted",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CollaborationRulesError";
  }
}