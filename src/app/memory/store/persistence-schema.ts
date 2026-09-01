import { z } from "zod";

/**
 * Memory 控制状态三表的行 schema（Phase 1，只持久化控制状态，不冻结 Record schema）。
 * 所有从 SQLite 读出的行必须先经 zod parse 才进入领域层，禁止 `JSON.parse(x) as T`。
 * 结构字段（kind/status/fence_state）用枚举约束，负责程序分支。
 */

const epochMs = z.number().finite().int().nonnegative();
const revision = z.number().int().positive();
const generation = z.number().int().nonnegative();

export const policyKindSchema = z.enum([
  "global_consent",
  "rollout",
  "scope_participation",
  "conversation_exclusion",
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
  covered_through_turn_id: z.string().nullable(),
  covered_through_ordinal: generation,
  source_fingerprint: z.string(),
  status: jobStatusSchema,
  attempt: generation,
  generation,
  policy_revision: z.string().min(1),
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
  readonly coveredThroughTurnId: string | null;
  readonly coveredThroughOrdinal: number;
  readonly sourceFingerprint: string;
  readonly status: PersistedJobStatus;
  readonly attempt: number;
  readonly generation: number;
  readonly policyRevision: string;
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
    coveredThroughTurnId: row.covered_through_turn_id,
    coveredThroughOrdinal: row.covered_through_ordinal,
    sourceFingerprint: row.source_fingerprint,
    status: row.status,
    attempt: row.attempt,
    generation: row.generation,
    policyRevision: row.policy_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// migration v2：内容表（Record / Source / Cursor / Outbox），《手册》8.2–8.5
// ---------------------------------------------------------------------------

export const recordKindSchema = z.enum([
  "preference",
  "goal",
  "decision",
  "constraint",
  "open_loop",
  "episode",
]);
export type PersistedRecordKind = z.infer<typeof recordKindSchema>;

export const evidenceClassSchema = z.enum([
  "quoted_user_evidence",
  "observed_result",
  "derived_synthesis",
]);
export type PersistedEvidenceClass = z.infer<typeof evidenceClassSchema>;

export const confirmationSchema = z.enum(["unconfirmed", "user_confirmed"]);
export type PersistedConfirmation = z.infer<typeof confirmationSchema>;

export const recordStatusSchema = z.enum(["active", "retired"]);
export type PersistedRecordStatus = z.infer<typeof recordStatusSchema>;

export const outboxOpSchema = z.enum(["index", "remove"]);
export type PersistedOutboxOp = z.infer<typeof outboxOpSchema>;

export const outboxStatusSchema = z.enum(["pending", "done", "failed"]);
export type PersistedOutboxStatus = z.infer<typeof outboxStatusSchema>;

const ordinal = z.number().int().nonnegative().nullable();

const recordRowSchema = z.object({
  record_id: z.string().min(1),
  revision: z.number().int().positive(),
  owner_key: z.string().min(1),
  owner_kind: z.enum(["global", "space", "workspace"]),
  kind: recordKindSchema,
  model_text: z.string().min(1),
  status: recordStatusSchema,
  evidence_class: evidenceClassSchema,
  confirmation: confirmationSchema,
  content_hash: z.string().min(1),
  generation,
  created_at: epochMs,
  updated_at: epochMs,
  effective_at: epochMs,
}).strict();

const recordSourceRowSchema = z.object({
  source_id: z.string().min(1),
  record_id: z.string().min(1),
  revision: z.number().int().positive(),
  conversation_id: z.string().min(1),
  run_id: z.string().nullable(),
  turn_id: z.string().nullable(),
  from_ordinal: ordinal,
  to_ordinal: ordinal,
  source_revision: z.number().int().nonnegative(),
}).strict();

const captureCursorRowSchema = z.object({
  conversation_id: z.string().min(1),
  owner_key: z.string().min(1),
  covered_through_ordinal: z.number().int().nonnegative(),
  source_fingerprint: z.string().min(1),
  updated_at: epochMs,
}).strict();

const indexOutboxRowSchema = z.object({
  outbox_id: z.string().min(1),
  record_id: z.string().min(1),
  revision: z.number().int().positive(),
  op: outboxOpSchema,
  status: outboxStatusSchema,
  attempts: generation,
  created_at: epochMs,
  updated_at: epochMs,
}).strict();

export type MemoryRecordRow = {
  readonly recordId: string;
  readonly revision: number;
  readonly ownerKey: string;
  readonly ownerKind: "global" | "space" | "workspace";
  readonly kind: PersistedRecordKind;
  readonly modelText: string;
  readonly status: PersistedRecordStatus;
  readonly evidenceClass: PersistedEvidenceClass;
  readonly confirmation: PersistedConfirmation;
  readonly contentHash: string;
  readonly generation: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly effectiveAt: number;
};

export type MemoryRecordSourceRow = {
  readonly sourceId: string;
  readonly recordId: string;
  readonly revision: number;
  readonly conversationId: string;
  readonly runId: string | null;
  readonly turnId: string | null;
  readonly fromOrdinal: number | null;
  readonly toOrdinal: number | null;
  readonly sourceRevision: number;
};

export type MemoryCaptureCursorRow = {
  readonly conversationId: string;
  readonly ownerKey: string;
  readonly coveredThroughOrdinal: number;
  readonly sourceFingerprint: string;
  readonly updatedAt: number;
};

export type MemoryIndexOutboxRow = {
  readonly outboxId: string;
  readonly recordId: string;
  readonly revision: number;
  readonly op: PersistedOutboxOp;
  readonly status: PersistedOutboxStatus;
  readonly attempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export function parseRecordRow(value: unknown): MemoryRecordRow {
  const row = recordRowSchema.parse(value);
  return {
    recordId: row.record_id,
    revision: row.revision,
    ownerKey: row.owner_key,
    ownerKind: row.owner_kind,
    kind: row.kind,
    modelText: row.model_text,
    status: row.status,
    evidenceClass: row.evidence_class,
    confirmation: row.confirmation,
    contentHash: row.content_hash,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    effectiveAt: row.effective_at,
  };
}

export function parseRecordSourceRow(value: unknown): MemoryRecordSourceRow {
  const row = recordSourceRowSchema.parse(value);
  return {
    sourceId: row.source_id,
    recordId: row.record_id,
    revision: row.revision,
    conversationId: row.conversation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    fromOrdinal: row.from_ordinal,
    toOrdinal: row.to_ordinal,
    sourceRevision: row.source_revision,
  };
}

export function parseCaptureCursorRow(value: unknown): MemoryCaptureCursorRow {
  const row = captureCursorRowSchema.parse(value);
  return {
    conversationId: row.conversation_id,
    ownerKey: row.owner_key,
    coveredThroughOrdinal: row.covered_through_ordinal,
    sourceFingerprint: row.source_fingerprint,
    updatedAt: row.updated_at,
  };
}

export function parseIndexOutboxRow(value: unknown): MemoryIndexOutboxRow {
  const row = indexOutboxRowSchema.parse(value);
  return {
    outboxId: row.outbox_id,
    recordId: row.record_id,
    revision: row.revision,
    op: row.op,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
