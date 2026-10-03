import { z } from "zod";
import type {
  MemoryEntry, MemoryEntryRevision, MemorySource, MemoryTopic, MemoryOverviewDependencies,
} from "../entry-contracts.js";
import { memoryOwnerFromKey } from "./owner-keys.js";

/** ADR 0019 domain validators; A maps SQLite rows before parsing. No new SQL owner. */
const entryIdentity = z.string().min(1);
const entryOwnerSchema = z.object({
  kind: z.literal("space"), id: entryIdentity,
}).strict();
const revisionRefSchema = z.object({ entryId: entryIdentity, revisionId: entryIdentity }).strict();
export const memoryEntrySchema = z.object({
  entryId: entryIdentity,
  owner: entryOwnerSchema,
  generation: z.number().int().nonnegative(),
  headRevisionId: entryIdentity,
  createdAt: z.number().finite().int().nonnegative(),
}).strict();
export const memoryTopicSchema = z.object({
  topicId: entryIdentity,
  owner: entryOwnerSchema,
  name: entryIdentity,
  aliases: z.array(entryIdentity).max(4),
}).strict();
export const memorySourceSchema = z.object({
  sourceId: entryIdentity,
  owner: entryOwnerSchema,
  locator: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("conversation_range"),
      conversationId: entryIdentity,
      fromOrdinal: z.number().int().nonnegative(),
      toOrdinal: z.number().int().nonnegative(),
      sourceRevision: z.number().int().nonnegative(),
      conversationGeneration: z.number().int().nonnegative(),
    }).strict(),
    z.object({ kind: z.literal("user_edit"), requestId: entryIdentity }).strict(),
  ]),
  lifecycle: z.enum(["present", "deleted"]),
  branch: z.enum(["selected", "superseded"]),
  createdAt: z.number().finite().int().nonnegative(),
}).strict().superRefine((source, context) => {
  if (source.locator.kind === "conversation_range" && source.locator.fromOrdinal > source.locator.toOrdinal) {
    context.addIssue({ code: "custom", message: "Source range is reversed." });
  }
  if (source.locator.kind === "user_edit" && (source.lifecycle !== "present" || source.branch !== "selected")) {
    context.addIssue({ code: "custom", message: "User edit provenance has no conversation lifecycle." });
  }
});
export const memoryEntryRevisionSchema = z.object({
  revisionId: entryIdentity,
  entryId: entryIdentity,
  revision: z.number().int().positive(),
  previousRevisionId: entryIdentity.nullable(),
  kind: z.enum(["initial", "supplement", "change", "correction", "withdrawal"]),
  origin: z.enum(["model", "user_edit"]),
  markdown: z.string(),
  applicability: entryIdentity.nullable(),
  occurredAt: entryIdentity.nullable(),
  reportedAt: z.string().datetime({ offset: true }),
  reason: z.object({ text: entryIdentity, sourceIds: z.array(entryIdentity).min(1) }).strict().nullable(),
  topicIds: z.array(entryIdentity).max(4),
  related: z.array(z.object({ entryId: entryIdentity, sourceIds: z.array(entryIdentity).min(1) }).strict()).max(3),
  sourceIds: z.array(entryIdentity).min(1),
  retractsRevisionIds: z.array(entryIdentity),
  publishedAt: z.number().finite().int().nonnegative(),
}).strict().superRefine((item, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if ((item.kind === "initial") !== (item.previousRevisionId === null) ||
      (item.kind === "initial" && item.revision !== 1)) issue("Initial revision must start a chain.");
  if (item.kind !== "withdrawal" && item.markdown.trim().length === 0) issue("Only withdrawal can have empty content.");
  const retracting = item.kind === "correction" || item.kind === "withdrawal";
  if (retracting !== (item.retractsRevisionIds.length > 0)) issue("Retractions require correction or withdrawal and explicit revisions.");
  if (item.related.some((link) => link.entryId === item.entryId)) issue("Related entries cannot reference themselves.");
  if (item.reason?.sourceIds.some((id) => !item.sourceIds.includes(id)) ||
      item.related.some((link) => link.sourceIds.some((id) => !item.sourceIds.includes(id)))) {
    issue("Reason and relation evidence must belong to revision sources.");
  }
  if (item.retractsRevisionIds.includes(item.revisionId)) issue("A revision cannot retract itself.");
});
export const memoryOverviewDependenciesSchema = z.object({
  revisionId: entryIdentity,
  entries: z.array(revisionRefSchema),
}).strict();
export function parseMemoryEntry(value: unknown): MemoryEntry { return memoryEntrySchema.parse(value); }
export function parseMemoryEntryRevision(value: unknown): MemoryEntryRevision { return memoryEntryRevisionSchema.parse(value); }
export function parseMemorySource(value: unknown): MemorySource { return memorySourceSchema.parse(value); }
export function parseMemoryTopic(value: unknown): MemoryTopic { return memoryTopicSchema.parse(value); }
export function parseMemoryOverviewDependencies(value: unknown): MemoryOverviewDependencies {
  return memoryOverviewDependenciesSchema.parse(value);
}

const entrySqlRowSchema = z.object({
  entry_id: entryIdentity, owner_key: entryIdentity, generation: z.number().int().nonnegative(),
  head_revision_id: entryIdentity, created_at: z.number().finite().int().nonnegative(),
}).strict();
const revisionSqlRowSchema = z.object({
  revision_id: entryIdentity, entry_id: entryIdentity, owner_key: entryIdentity,
  revision: z.number().int().positive(), previous_revision_id: entryIdentity.nullable(),
  kind: z.enum(["initial", "supplement", "change", "correction", "withdrawal"]),
  origin: z.enum(["model", "user_edit"]), content_json: z.string(), source_ids_json: z.string(),
  retracts_revision_ids_json: z.string(), published_at: z.number().finite().int().nonnegative(),
  supply_state: z.enum(["eligible", "revoked"]),
}).strict();
const sourceSqlRowSchema = z.object({
  source_id: entryIdentity, owner_key: entryIdentity, locator_json: z.string(),
  lifecycle: z.enum(["present", "deleted"]), branch: z.enum(["selected", "superseded"]),
  created_at: z.number().finite().int().nonnegative(),
}).strict();
const topicSqlRowSchema = z.object({
  topic_id: entryIdentity, owner_key: entryIdentity, name: entryIdentity, aliases_json: z.string(),
}).strict();
export function parseMemoryEntryRow(value: unknown): MemoryEntry {
  const row = entrySqlRowSchema.parse(value);
  return parseMemoryEntry({ entryId: row.entry_id, owner: memoryOwnerFromKey(row.owner_key),
    generation: row.generation, headRevisionId: row.head_revision_id, createdAt: row.created_at });
}
/** SQL envelope retains owner and mutable supply state outside the immutable revision. */
export type MemoryEntryRevisionRow = MemoryEntryRevision & {
  readonly owner: MemoryEntry["owner"];
  readonly supplyState: "eligible" | "revoked";
};
export function parseMemoryEntryRevisionRow(value: unknown): MemoryEntryRevisionRow {
  const row = revisionSqlRowSchema.parse(value);
  const content = z.object({
    markdown: z.string(), applicability: entryIdentity.nullable(), occurredAt: entryIdentity.nullable(),
    reportedAt: z.string().datetime({ offset: true }),
    reason: z.object({ text: entryIdentity, sourceIds: z.array(entryIdentity).min(1) }).strict().nullable(),
    topicIds: z.array(entryIdentity),
    related: z.array(z.object({ entryId: entryIdentity, sourceIds: z.array(entryIdentity).min(1) }).strict()),
  }).strict().parse(JSON.parse(row.content_json));
  const parsed = parseMemoryEntryRevision({ ...content,
    revisionId: row.revision_id, entryId: row.entry_id, revision: row.revision,
    previousRevisionId: row.previous_revision_id, kind: row.kind, origin: row.origin,
    sourceIds: JSON.parse(row.source_ids_json), retractsRevisionIds: JSON.parse(row.retracts_revision_ids_json),
    publishedAt: row.published_at,
  });
  return { ...parsed, owner: entryOwnerSchema.parse(memoryOwnerFromKey(row.owner_key)), supplyState: row.supply_state };
}
export function parseMemorySourceRow(value: unknown): MemorySource {
  const row = sourceSqlRowSchema.parse(value);
  return parseMemorySource({ sourceId: row.source_id, owner: memoryOwnerFromKey(row.owner_key),
    locator: JSON.parse(row.locator_json), lifecycle: row.lifecycle, branch: row.branch, createdAt: row.created_at });
}
export function parseMemoryTopicRow(value: unknown): MemoryTopic {
  const row = topicSqlRowSchema.parse(value);
  return parseMemoryTopic({ topicId: row.topic_id, owner: memoryOwnerFromKey(row.owner_key),
    name: row.name, aliases: JSON.parse(row.aliases_json) });
}

/**
 * Memory 文档产物（0.6.0 正式设计）的行 schema。
 * 所有从 SQLite 读出的行必须先经 zod parse 才进入领域层，禁止 `JSON.parse(x) as T`。
 * 结构字段（origin/validity/dep_kind/fence_state）用枚举约束，负责程序分支。
 *
 * 目标 schema 见《架构决策记录》"记忆系统文档产物重构"条：
 * - memory_policy / memory_lifecycle：策略分账和生命周期控制；
 * - memory_owner_doc / memory_conversation_summary：不可变 revision 的文档产物；
 * - memory_doc_source：文档级保守依赖（revision 间复制继承）；
 * - memory_capture_progress：processed / excluded 两种进度分离；
 * - memory_job：每会话至多一个活跃待办（eligible_at / claim_token 调度边界）；
 * - memory_summary_fts / memory_transcript_fts：FTS5 派生投影。
 * 未发布 v1：这里维护目标 schema，不为旧开发数据保留兼容层。
 */

const epochMs = z.number().finite().int().nonnegative();
const revision = z.number().int().positive();
const generation = z.number().int().nonnegative();
const ordinal = z.number().int().nonnegative();

export const policyKindSchema = z.enum([
  "global_consent",
  "rollout",
]);
export type PersistedPolicyKind = z.infer<typeof policyKindSchema>;

export const fenceStateSchema = z.enum(["none", "preparing", "fenced", "tombstone"]);
export type PersistedFenceState = z.infer<typeof fenceStateSchema>;

export const jobStatusSchema = z.enum(["queued", "running", "done", "failed"]);
export type PersistedJobStatus = z.infer<typeof jobStatusSchema>;

const policyRowSchema = z.object({
  policy_key: z.string().min(1),
  policy_kind: policyKindSchema,
  scope_owner_key: z.string().nullable(),
  enabled: z.number().int().min(0).max(1),
  revision,
  updated_at: epochMs,
}).strict();

const lifecycleRowSchema = z.object({
  owner_key: z.string().min(1),
  generation,
  capture_after: epochMs.nullable(),
  fence_state: fenceStateSchema,
  updated_at: epochMs,
}).strict();

const jobRowSchema = z.object({
  job_id: z.string().min(1),
  conversation_id: z.string().min(1),
  owner_key: z.string().min(1),
  status: jobStatusSchema,
  requested_through_ordinal: ordinal,
  target_through_ordinal: ordinal,
  eligible_at: epochMs,
  ready_queued_at: epochMs,
  next_attempt_at: epochMs.nullable(),
  claim_token: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  generation,
  policy_revision: z.string().min(1),
  last_failure: z.string().nullable(),
  created_at: epochMs,
  updated_at: epochMs,
}).strict();

export type MemoryPolicyRow = {
  readonly key: string;
  readonly kind: PersistedPolicyKind;
  readonly scopeOwnerKey: string | null;
  readonly enabled: boolean;
  readonly revision: number;
  readonly updatedAt: number;
};

export type MemoryLifecycleRow = {
  readonly ownerKey: string;
  readonly generation: number;
  readonly captureAfter: number | null;
  readonly fenceState: PersistedFenceState;
  readonly updatedAt: number;
};

export type MemoryJobRow = {
  readonly jobId: string;
  readonly conversationId: string;
  readonly ownerKey: string;
  readonly status: PersistedJobStatus;
  readonly requestedThroughOrdinal: number;
  readonly targetThroughOrdinal: number;
  readonly eligibleAt: number;
  readonly readyQueuedAt: number;
  readonly nextAttemptAt: number | null;
  readonly claimToken: string | null;
  readonly attempt: number;
  readonly generation: number;
  readonly policyRevision: string;
  readonly lastFailure: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export function parsePolicyRow(value: unknown): MemoryPolicyRow {
  const row = policyRowSchema.parse(value);
  return {
    key: row.policy_key,
    kind: row.policy_kind,
    scopeOwnerKey: row.scope_owner_key,
    enabled: row.enabled === 1,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function parseLifecycleRow(value: unknown): MemoryLifecycleRow {
  const row = lifecycleRowSchema.parse(value);
  return {
    ownerKey: row.owner_key,
    generation: row.generation,
    captureAfter: row.capture_after,
    fenceState: row.fence_state,
    updatedAt: row.updated_at,
  };
}

export function parseJobRow(value: unknown): MemoryJobRow {
  const row = jobRowSchema.parse(value);
  return {
    jobId: row.job_id,
    conversationId: row.conversation_id,
    ownerKey: row.owner_key,
    status: row.status,
    requestedThroughOrdinal: row.requested_through_ordinal,
    targetThroughOrdinal: row.target_through_ordinal,
    eligibleAt: row.eligible_at,
    readyQueuedAt: row.ready_queued_at,
    nextAttemptAt: row.next_attempt_at,
    claimToken: row.claim_token,
    attempt: row.attempt,
    generation: row.generation,
    policyRevision: row.policy_revision,
    lastFailure: row.last_failure,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// 文档产物行
// ---------------------------------------------------------------------------

export const docOriginSchema = z.enum(["model", "user_edit"]);
export type PersistedDocOrigin = z.infer<typeof docOriginSchema>;

export const docValiditySchema = z.enum(["valid", "invalidated"]);
export type PersistedDocValidity = z.infer<typeof docValiditySchema>;

export const docSourceKindSchema = z.enum(["conversation_range", "user_edit"]);
export type PersistedDocSourceKind = z.infer<typeof docSourceKindSchema>;

const ownerDocRowSchema = z.object({
  revision_id: z.string().min(1),
  owner_key: z.string().min(1),
  revision,
  origin: docOriginSchema,
  markdown: z.string(),
  validity: docValiditySchema,
  generation,
  content_hash: z.string().min(1),
  updated_at: epochMs,
}).strict();

const summaryRowSchema = z.object({
  revision_id: z.string().min(1),
  conversation_id: z.string().min(1),
  owner_key: z.string().min(1),
  revision,
  markdown: z.string().min(1),
  validity: docValiditySchema,
  generation,
  content_hash: z.string().min(1),
  covered_through_ordinal: ordinal,
  updated_at: epochMs,
}).strict();

const docSourceRowSchema = z.object({
  source_id: z.string().min(1),
  revision_id: z.string().min(1),
  dep_kind: docSourceKindSchema,
  conversation_id: z.string().min(1).nullable(),
  from_ordinal: ordinal.nullable(),
  to_ordinal: ordinal.nullable(),
  source_revision: z.number().int().nonnegative(),
  request_id: z.string().min(1).nullable(),
  created_at: epochMs,
}).strict();

const captureProgressRowSchema = z.object({
  conversation_id: z.string().min(1),
  owner_key: z.string().min(1),
  processed_through_ordinal: ordinal,
  excluded_through_ordinal: ordinal,
  // 片段级进度（N04）：单轮超过请求容量时按片段消费，记录该轮内已消费的
  // 字符偏移；null 表示该轮已完整处理（无未消费片段）。
  processed_fragment_ordinal: ordinal.nullable(),
  processed_fragment_end: ordinal.nullable(),
  source_fingerprint: z.string().min(1),
  updated_at: epochMs,
}).strict();

const transcriptCoverageRowSchema = z.object({
  conversation_id: z.string().min(1),
  owner_key: z.string().min(1),
  indexed_through_ordinal: ordinal,
  source_revision: z.number().int().nonnegative(),
  updated_at: epochMs,
}).strict();

export type MemoryOwnerDocRow = {
  readonly revisionId: string;
  readonly ownerKey: string;
  readonly revision: number;
  readonly origin: PersistedDocOrigin;
  readonly markdown: string;
  readonly validity: PersistedDocValidity;
  readonly generation: number;
  readonly contentHash: string;
  readonly updatedAt: number;
};

export type MemorySummaryRow = {
  readonly revisionId: string;
  readonly conversationId: string;
  readonly ownerKey: string;
  readonly revision: number;
  readonly markdown: string;
  readonly validity: PersistedDocValidity;
  readonly generation: number;
  readonly contentHash: string;
  readonly coveredThroughOrdinal: number;
  readonly updatedAt: number;
};

export type MemoryDocSourceRow = {
  readonly sourceId: string;
  readonly revisionId: string;
  readonly depKind: PersistedDocSourceKind;
  readonly conversationId: string | null;
  readonly fromOrdinal: number | null;
  readonly toOrdinal: number | null;
  readonly sourceRevision: number;
  readonly requestId: string | null;
  readonly createdAt: number;
};

export type MemoryCaptureProgressRow = {
  readonly conversationId: string;
  readonly ownerKey: string;
  readonly processedThroughOrdinal: number;
  readonly excludedThroughOrdinal: number;
  /** 片段级进度：该 ordinal 内已消费的字符终点；null = 无未完成片段。 */
  readonly processedFragmentOrdinal: number | null;
  readonly processedFragmentEnd: number | null;
  readonly sourceFingerprint: string;
  readonly updatedAt: number;
};

export type MemoryTranscriptCoverageRow = {
  readonly conversationId: string;
  readonly ownerKey: string;
  readonly indexedThroughOrdinal: number;
  readonly sourceRevision: number;
  readonly updatedAt: number;
};

export function parseOwnerDocRow(value: unknown): MemoryOwnerDocRow {
  const row = ownerDocRowSchema.parse(value);
  return {
    revisionId: row.revision_id,
    ownerKey: row.owner_key,
    revision: row.revision,
    origin: row.origin,
    markdown: row.markdown,
    validity: row.validity,
    generation: row.generation,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
  };
}

export function parseSummaryRow(value: unknown): MemorySummaryRow {
  const row = summaryRowSchema.parse(value);
  return {
    revisionId: row.revision_id,
    conversationId: row.conversation_id,
    ownerKey: row.owner_key,
    revision: row.revision,
    markdown: row.markdown,
    validity: row.validity,
    generation: row.generation,
    contentHash: row.content_hash,
    coveredThroughOrdinal: row.covered_through_ordinal,
    updatedAt: row.updated_at,
  };
}

export function parseDocSourceRow(value: unknown): MemoryDocSourceRow {
  const row = docSourceRowSchema.parse(value);
  return {
    sourceId: row.source_id,
    revisionId: row.revision_id,
    depKind: row.dep_kind,
    conversationId: row.conversation_id,
    fromOrdinal: row.from_ordinal,
    toOrdinal: row.to_ordinal,
    sourceRevision: row.source_revision,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

export function parseCaptureProgressRow(value: unknown): MemoryCaptureProgressRow {
  const row = captureProgressRowSchema.parse(value);
  return {
    conversationId: row.conversation_id,
    ownerKey: row.owner_key,
    processedThroughOrdinal: row.processed_through_ordinal,
    excludedThroughOrdinal: row.excluded_through_ordinal,
    processedFragmentOrdinal: row.processed_fragment_ordinal,
    processedFragmentEnd: row.processed_fragment_end,
    sourceFingerprint: row.source_fingerprint,
    updatedAt: row.updated_at,
  };
}

export function parseTranscriptCoverageRow(value: unknown): MemoryTranscriptCoverageRow {
  const row = transcriptCoverageRowSchema.parse(value);
  return {
    conversationId: row.conversation_id,
    ownerKey: row.owner_key,
    indexedThroughOrdinal: row.indexed_through_ordinal,
    sourceRevision: row.source_revision,
    updatedAt: row.updated_at,
  };
}
