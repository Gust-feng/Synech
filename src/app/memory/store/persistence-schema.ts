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
