import { z } from "zod";

/**
 * Memory 文档产物（0.6.0 正式设计）的行 schema。
 * 所有从 SQLite 读出的行必须先经 zod parse 才进入领域层，禁止 `JSON.parse(x) as T`。
 * 结构字段（origin/validity/dep_kind/fence_state）用枚举约束，负责程序分支。
 *
 * 目标 schema 见《架构决策记录》"记忆系统文档产物重构"条：
 * - memory_policy / memory_lifecycle：沿用 Memory v2 分账（迁移 v1–v4 不变）；
 * - memory_space_doc / memory_conversation_summary：不可变 revision 的文档产物；
 * - memory_doc_source：文档级保守依赖（revision 间复制继承）；
 * - memory_capture_progress：processed / excluded 两种进度分离；
 * - memory_job：每会话至多一个活跃待办（eligible_at / claim_token 调度边界）；
 * - memory_summary_fts / memory_transcript_fts：FTS5 派生投影（迁移 v5 内创建）。
 */

const epochMs = z.number().finite().int().nonnegative();
const revision = z.number().int().positive();
const generation = z.number().int().nonnegative();
const ordinal = z.number().int().nonnegative();

export const policyKindSchema = z.enum([
  "global_consent",
  "rollout",
  "space_participation",
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
// 文档产物行（memory/5）
// ---------------------------------------------------------------------------

export const docOriginSchema = z.enum(["model", "user_edit"]);
export type PersistedDocOrigin = z.infer<typeof docOriginSchema>;

export const docValiditySchema = z.enum(["valid", "invalidated"]);
export type PersistedDocValidity = z.infer<typeof docValiditySchema>;

export const docSourceKindSchema = z.enum(["conversation_range", "user_edit"]);
export type PersistedDocSourceKind = z.infer<typeof docSourceKindSchema>;

const spaceDocRowSchema = z.object({
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

export type MemorySpaceDocRow = {
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

export function parseSpaceDocRow(value: unknown): MemorySpaceDocRow {
  const row = spaceDocRowSchema.parse(value);
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
