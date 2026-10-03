import type { ConversationOwner } from "../../domain/execution-scope/contracts.js";

/** ADR 0019 Accepted target contracts. Runtime/SQL integration is pending. */
export type MemoryRevisionKind = "initial" | "supplement" | "change" | "correction" | "withdrawal";
export type MemoryEntryRevisionRef = { readonly entryId: string; readonly revisionId: string };
export type MemoryEntry = {
  readonly entryId: string;
  readonly owner: ConversationOwner;
  readonly generation: number;
  readonly headRevisionId: string;
  readonly createdAt: number;
};
export type MemoryTopic = {
  readonly topicId: string;
  readonly owner: ConversationOwner;
  readonly name: string;
  readonly aliases: readonly string[];
};
export type MemoryRelatedEntry = {
  readonly entryId: string;
  readonly sourceIds: readonly string[];
};
export type MemoryEntryContent = {
  readonly markdown: string;
  readonly applicability: string | null;
  /** Evidence-backed event time, including imprecise descriptions; null means unknown. */
  readonly occurredAt: string | null;
  /** Evidence message or user submission time, never the publication time. */
  readonly reportedAt: string;
  readonly reason: { readonly text: string; readonly sourceIds: readonly string[] } | null;
  readonly topicIds: readonly string[];
  readonly related: readonly MemoryRelatedEntry[];
};
export type MemoryEntryRevision = MemoryEntryContent & {
  readonly revisionId: string;
  readonly entryId: string;
  readonly revision: number;
  readonly previousRevisionId: string | null;
  readonly kind: MemoryRevisionKind;
  readonly origin: "model" | "user_edit";
  readonly sourceIds: readonly string[];
  /** Only correction/withdrawal may revoke explicitly identified revisions of this entry. */
  readonly retractsRevisionIds: readonly string[];
  readonly publishedAt: number;
};
export type MemorySourceLocator =
  | {
      readonly kind: "conversation_range";
      readonly conversationId: string;
      readonly fromOrdinal: number;
      readonly toOrdinal: number;
      readonly sourceRevision: number;
      readonly conversationGeneration: number;
    }
  | { readonly kind: "user_edit"; readonly requestId: string };
export type MemorySource = {
  readonly sourceId: string;
  readonly owner: ConversationOwner;
  readonly locator: MemorySourceLocator;
  /** Independent facts: deletion must not erase a previous branch retirement. */
  readonly lifecycle: "present" | "deleted";
  readonly branch: "selected" | "superseded";
  readonly createdAt: number;
};
export type MemorySourceView = MemorySource & {
  /** Dynamically checked by the host; transient errors never become durable deletion. */
  readonly readback: "available" | "deleted" | "superseded" | "temporarily_unavailable" | "not_applicable";
};
export type MemoryEntryRevisionView = {
  readonly entry: MemoryEntry;
  readonly revision: MemoryEntryRevision;
  readonly supplyState: "eligible" | "revoked";
  readonly role: "current" | "historical" | "withdrawn";
  /** Null if the head cannot currently supply a recognition; do not fall back to an older head. */
  readonly currentRevisionId: string | null;
  readonly sources: readonly MemorySourceView[];
};
/** Query-only projection: source references and relation/reason sourceIds cover this source page.
 * Full repository/admin views remain unchanged; continuation returns every source, never silently drops it. */
export type MemoryEntryQueryView = MemoryEntryRevisionView & {
  /** Content slices concatenate in order: markdown, applicability, then reason.text; lengths locate each field. */
  readonly contentPage: { readonly offset: number; readonly total: number; readonly nextOffset: number | null;
    readonly markdownChars: number; readonly applicabilityChars: number; readonly reasonChars: number };
  readonly sourcePage: { readonly offset: number; readonly total: number; readonly nextOffset: number | null };
  readonly sourceSummary: { readonly total: number; readonly deleted: number; readonly superseded: number };
};
/** Existing MemoryOwnerDoc remains the immutable overview snapshot. */
export type MemoryOverviewDependencies = {
  readonly revisionId: string;
  readonly entries: readonly MemoryEntryRevisionRef[];
};
export type MemoryOverviewSourceState = {
  readonly sourceId: string;
  readonly readback: MemorySourceView["readback"];
};

export type MemoryEntrySearchInput = {
  readonly owner: ConversationOwner;
  readonly query: string;
  readonly topicId?: string;
  readonly conversationId?: string;
  readonly includeHistory?: boolean;
  readonly limit: number;
  readonly cursor?: string;
};
export type MemoryEntrySearchResult = {
  readonly outcome: "ok" | "no_hit" | "disabled" | "unavailable";
  readonly items: readonly MemoryEntryQueryView[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
};
export type MemoryEntryReadInput = {
  readonly owner: ConversationOwner;
  readonly entryId: string;
  readonly revisionId?: string;
  readonly includeHistory?: boolean;
  readonly includeRelated?: boolean;
  readonly limitTokens: number;
  readonly cursor?: string;
};
export type MemoryEntryReadResult =
  | {
      readonly outcome: "ok";
      readonly item: MemoryEntryQueryView;
      readonly history: readonly MemoryEntryQueryView[];
      /** At most one hop; all included contents share the response token budget. */
      readonly related: readonly MemoryEntryQueryView[];
      readonly nextCursor: string | null;
      readonly truncated: boolean;
    }
  | { readonly outcome: "disabled" | "not_found" | "unavailable"; readonly reason: string };
/** Extend the existing history query implementation/tool chain; no query-time model calls. */
export interface MemoryEntryQueryPort {
  searchEntries(input: MemoryEntrySearchInput): Promise<MemoryEntrySearchResult>;
  readEntry(input: MemoryEntryReadInput): Promise<MemoryEntryReadResult>;
}

export type MemoryEntryMutation = MemoryEntryContent & {
  readonly entryId: string;
  readonly sourceIds: readonly string[];
} & (
  | { readonly operation: "create"; readonly expectedRevisionId: null; readonly kind: "initial"; readonly retractsRevisionIds: readonly [] }
  | { readonly operation: "revise"; readonly expectedRevisionId: string; readonly kind: Exclude<MemoryRevisionKind, "initial">; readonly retractsRevisionIds: readonly string[] }
);
/** IDs are allocated by the host after parsing the model proposal, before SQL publication. */
export type MemoryEntryPublicationMutation = MemoryEntryMutation & { readonly revisionId: string };
/** User provenance is created by the host, never accepted from UI as a conversation source. */
export type UpdateMemoryEntryInput = {
  readonly owner: ConversationOwner;
  readonly requestId: string;
  readonly edit: Omit<MemoryEntryContent, "reportedAt" | "reason"> & (
    | { readonly operation: "create"; readonly entryId: string; readonly expectedRevisionId: null; readonly kind: "initial"; readonly retractsRevisionIds: readonly [] }
    | { readonly operation: "revise"; readonly entryId: string; readonly expectedRevisionId: string; readonly kind: Exclude<MemoryRevisionKind, "initial">; readonly retractsRevisionIds: readonly string[] }
  ) & { readonly reason: string | null };
};
export type UpdateMemoryEntryResult = {
  readonly entryId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly overviewRevisionId: string | null;
};
/** Target signatures replace existing admin methods during worker D integration. */
export interface MemoryEntryAdminPort {
  updateMemory(input: UpdateMemoryEntryInput): Promise<UpdateMemoryEntryResult>;
  getMemoryView(input: {
    readonly owner: ConversationOwner;
    /** Omit for head list; set to page the immutable revisions of one entry. */
    readonly entryId?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<{
    readonly document: import("./contracts.js").OwnerMemoryBackground | undefined;
    readonly entries: readonly MemoryEntryRevisionView[];
    readonly topics: readonly MemoryTopic[];
    readonly nextCursor: string | null;
    readonly summaryCount: number;
    readonly lastMaintenanceAt: number | null;
  }>;
}
export type SupersedeConversationSourcesInput = {
  readonly conversationId: string;
  readonly owner: ConversationOwner;
  /** Ranges intersecting the replaced suffix retire as a whole; null retires all ranges. */
  readonly retainedThroughOrdinal: number | null;
};
export interface MemorySourceLifecyclePort {
  supersedeConversationSources(input: SupersedeConversationSourcesInput): Promise<void>;
}

/** Host grants these reads per claimed job; model cannot select an owner or arbitrary tools. */
export type MemoryConsolidationReadRequest =
  | { readonly kind: "search_entries"; readonly query: string; readonly topicId?: string }
  | { readonly kind: "read_entry"; readonly entryId: string; readonly revisionId?: string }
  | { readonly kind: "read_evidence"; readonly sourceId: string };
export type MemoryConsolidationReadResult = {
  readonly request: MemoryConsolidationReadRequest;
  readonly outcome: "ok" | "not_found" | "unavailable" | "budget_exceeded";
  readonly content: string;
};
export interface MemoryConsolidationReadPort {
  read(request: MemoryConsolidationReadRequest): Promise<MemoryConsolidationReadResult>;
}
/** finite continuation over existing MemoryMaintenanceModelPort.generate */
export type MemoryConsolidationProposal =
  | { readonly status: "needs_read"; readonly requests: readonly MemoryConsolidationReadRequest[] }
  | {
      readonly status: "ready";
      readonly mutations: readonly MemoryEntryMutation[];
      readonly topics: readonly Omit<MemoryTopic, "owner">[];
      readonly overview: { readonly markdown: string; readonly entryIds: readonly string[] } | null;
    };
