import type { MemoryOwner } from "../../domain/memory/index.js";

/** User-authored standing rules are a separate owner from AgentNotes and implicit Memory. */
export type CollaborationRuleScope = MemoryOwner;
export type CollaborationRuleOwner = Exclude<CollaborationRuleScope, { readonly kind: "global" }>;
export type CollaborationRuleVersion = `sha256:${string}`;

export type CollaborationRulesDocument = {
  readonly scope: CollaborationRuleScope;
  readonly content: string;
  readonly version: CollaborationRuleVersion;
  readonly updatedAt: string | undefined;
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
 * Per-scope mechanical pre-budget. Global and owner rules can both contribute,
 * so this stays deliberately small; writes fail instead of silently truncating.
 */
export const COLLABORATION_RULES_MAX_CHARS = 2_000;

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
      "Collaboration-rule scope must be global or a concrete Space/Workspace owner.",
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
    startupSnapshot(owner: CollaborationRuleOwner): Promise<CollaborationRulesStartupSnapshot>;
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
