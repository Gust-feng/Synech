import type { SQLInputValue } from "node:sqlite";

import type { SqliteRuntimeDatabase } from "../../../adapters/runtime-storage/index.js";
import { createId, type IdFactory } from "../../../kernel/id.js";
import { MemoryError } from "../contracts.js";
import {
  parseJobRow,
  parseLifecycleRow,
  parsePolicyRow,
  type MemoryJobRow,
  type MemoryLifecycleRow,
  type MemoryPolicyRow,
  type PersistedFenceState,
  type PersistedJobStatus,
  type PersistedPolicyKind,
} from "./persistence-schema.js";

/**
 * Memory 控制状态仓储：拥有 policy 分账、lifecycle fence/generation 和 durable job
 * 边界；Record/Source/游标/索引投影由 MemoryContentRepository 拥有。
 *
 * 不变量：
 * - policy 写入走 CAS（expectedRevision），冲突即 memory_policy_revision_stale；
 * - lifecycle.generation 只单调递增（advanceGeneration），清除/删除靠它立 fence；
 * - 每个 conversation 至多一个活跃 job（queued/running），进程重启后 running 必须
 *   能被 recoverInterruptedJobs 枚举并回到 queued（durable 边界不丢）。
 */

export const MEMORY_MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE memory_policy (
      policy_key TEXT PRIMARY KEY,
      policy_kind TEXT NOT NULL CHECK(policy_kind IN ('global_consent', 'rollout', 'scope_participation', 'conversation_exclusion')),
      scope_owner_key TEXT,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      revision INTEGER NOT NULL CHECK(revision > 0),
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE memory_lifecycle (
      owner_key TEXT PRIMARY KEY,
      generation INTEGER NOT NULL CHECK(generation >= 0),
      capture_after INTEGER,
      fence_state TEXT NOT NULL CHECK(fence_state IN ('none', 'preparing', 'fenced', 'tombstone')),
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE memory_job (
      job_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      covered_through_turn_id TEXT,
      covered_through_ordinal INTEGER NOT NULL CHECK(covered_through_ordinal >= 0),
      source_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'failed')),
      attempt INTEGER NOT NULL CHECK(attempt >= 0),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      policy_revision TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX memory_job_status_idx ON memory_job(status, created_at);
    CREATE INDEX memory_job_conversation_idx ON memory_job(conversation_id);
    CREATE UNIQUE INDEX memory_job_active_unique_idx ON memory_job(conversation_id)
      WHERE status IN ('queued', 'running');
  `,
}, {
  version: 2,
  sql: `
    CREATE TABLE memory_record (
      record_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      owner_key TEXT NOT NULL,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('global', 'space', 'workspace')),
      kind TEXT NOT NULL CHECK(kind IN ('preference', 'goal', 'decision', 'constraint', 'open_loop', 'episode')),
      model_text TEXT NOT NULL CHECK(length(model_text) > 0),
      status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
      evidence_class TEXT NOT NULL CHECK(evidence_class IN ('quoted_user_evidence', 'observed_result', 'derived_synthesis')),
      confirmation TEXT NOT NULL CHECK(confirmation IN ('unconfirmed', 'user_confirmed')),
      content_hash TEXT NOT NULL CHECK(length(content_hash) > 0),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      effective_at INTEGER NOT NULL,
      PRIMARY KEY(record_id, revision)
    ) STRICT;
    CREATE INDEX memory_record_owner_idx ON memory_record(owner_key, status);
    CREATE UNIQUE INDEX memory_record_active_unique_idx ON memory_record(record_id)
      WHERE status = 'active';

    CREATE TABLE memory_record_source (
      source_id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      conversation_id TEXT NOT NULL,
      run_id TEXT,
      turn_id TEXT,
      from_ordinal INTEGER CHECK(from_ordinal IS NULL OR from_ordinal >= 0),
      to_ordinal INTEGER CHECK(to_ordinal IS NULL OR to_ordinal >= 0),
      source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
      FOREIGN KEY(record_id, revision) REFERENCES memory_record(record_id, revision) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX memory_record_source_record_idx ON memory_record_source(record_id, revision);
    CREATE INDEX memory_record_source_conversation_idx ON memory_record_source(conversation_id);

    CREATE TABLE memory_capture_cursor (
      conversation_id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      covered_through_ordinal INTEGER NOT NULL CHECK(covered_through_ordinal >= 0),
      source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint) > 0),
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE memory_index_outbox (
      outbox_id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      op TEXT NOT NULL CHECK(op IN ('index', 'remove')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'done', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX memory_index_outbox_status_idx ON memory_index_outbox(status, created_at);
  `,
}, {
  // migration v3（T22）：memory_record 的 lexical 检索投影（《手册》8.4 Index
  // Projection / 16.2）。terms 存 lexicalProjection(model_text)（汉字 bigram +
  // 拉丁词标准化，见 ../recall/lexical-projection.ts，与 eval 工具链同源）；
  // record_id/revision/owner_key/status/generation 是 UNINDEXED 元数据列，供
  // recall 做 scope 过滤（owner_key + status='active' + generation）后回表复核。
  // 投影是派生数据：由 MemoryContentRepository 在写入/退休事务内同步维护
  // （SQLite 触发器无法调用 JS 投影算法），任何不与 memory_record 成对的
  // 投影行在检索时一律丢弃（fail-closed）。
  version: 3,
  sql: `
    CREATE VIRTUAL TABLE memory_record_fts USING fts5(
      terms,
      record_id UNINDEXED,
      revision UNINDEXED,
      owner_key UNINDEXED,
      status UNINDEXED,
      generation UNINDEXED,
      tokenize = 'unicode61'
    );
  `,
}] as const;

export type SetPolicyInput = {
  readonly key: string;
  readonly kind: PersistedPolicyKind;
  readonly scopeOwnerKey: string | null;
  readonly enabled: boolean;
  /** 调用方读到的当前 revision；行不存在时传 0/undefined 表示新建。 */
  readonly expectedRevision?: number;
};

export type EnqueueJobInput = {
  readonly conversationId: string;
  readonly ownerKey: string;
  readonly coveredThroughTurnId: string | null;
  readonly coveredThroughOrdinal: number;
  readonly sourceFingerprint: string;
  readonly generation: number;
  readonly policyRevision: string;
};

export interface MemoryControlRepository {
  readAllPolicy(): Promise<readonly MemoryPolicyRow[]>;
  setPolicy(input: SetPolicyInput): Promise<MemoryPolicyRow>;
  getLifecycle(ownerKey: string): Promise<MemoryLifecycleRow | undefined>;
  advanceGeneration(ownerKey: string): Promise<MemoryLifecycleRow>;
  setLifecycleFence(
    ownerKey: string,
    fenceState: PersistedFenceState,
    captureAfter?: number | null,
    expectedGeneration?: number,
  ): Promise<MemoryLifecycleRow>;
  /** 删除准备：单事务内 generation+1 并立 fenced（消除 advance 与 fence 之间的交错窗口）。 */
  fenceForRemoval(ownerKey: string): Promise<MemoryLifecycleRow>;
  /** 存在活跃（queued/running）job 时推进其边界，否则新建 queued job。 */
  enqueueOrAdvanceJob(input: EnqueueJobInput): Promise<MemoryJobRow>;
  listJobsByStatus(status: PersistedJobStatus): Promise<readonly MemoryJobRow[]>;
  /** CAS 状态转移（queued→running 等）；状态不符返回 undefined，不静默改写。 */
  transitionJob(
    jobId: string,
    fromStatus: PersistedJobStatus,
    toStatus: PersistedJobStatus,
  ): Promise<MemoryJobRow | undefined>;
  /** 启动恢复：把残留 running job 退回 queued 并 attempt+1，返回恢复数量。 */
  recoverInterruptedJobs(): Promise<number>;
}

const POLICY_COLUMNS =
  "policy_key, policy_kind, scope_owner_key, enabled, revision, updated_at";
const LIFECYCLE_COLUMNS =
  "owner_key, generation, capture_after, fence_state, updated_at";
const JOB_COLUMNS =
  "job_id, conversation_id, owner_key, covered_through_turn_id, covered_through_ordinal, source_fingerprint, status, attempt, generation, policy_revision, created_at, updated_at";

export function createSqliteMemoryControlRepository(
  database: SqliteRuntimeDatabase,
  options: { readonly idFactory?: IdFactory } = {},
): MemoryControlRepository {
  database.migrate("memory", MEMORY_MIGRATIONS);
  const idFactory = options.idFactory ?? createId;

  const readPolicy = (key: string): MemoryPolicyRow | undefined => {
    const row = database.connection
      .prepare(`SELECT ${POLICY_COLUMNS} FROM memory_policy WHERE policy_key = ?`)
      .get(key) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parsePolicyRow(row);
  };

  const readLifecycle = (ownerKey: string): MemoryLifecycleRow | undefined => {
    const row = database.connection
      .prepare(`SELECT ${LIFECYCLE_COLUMNS} FROM memory_lifecycle WHERE owner_key = ?`)
      .get(ownerKey) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseLifecycleRow(row);
  };

  const readJob = (jobId: string): MemoryJobRow | undefined => {
    const row = database.connection
      .prepare(`SELECT ${JOB_COLUMNS} FROM memory_job WHERE job_id = ?`)
      .get(jobId) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseJobRow(row);
  };

  return {
    async readAllPolicy() {
      const rows = database.connection
        .prepare(`SELECT ${POLICY_COLUMNS} FROM memory_policy ORDER BY policy_key`)
        .all() as Record<string, SQLInputValue>[];
      return rows.map(parsePolicyRow);
    },

    async setPolicy(input) {
      return database.transaction(() => {
        const existing = readPolicy(input.key);
        const currentRevision = existing?.revision ?? 0;
        if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
          throw new MemoryError(
            "memory_policy_revision_stale",
            `Memory policy ${input.key} revision ${input.expectedRevision} is stale (current ${currentRevision}).`,
          );
        }
        const nextRevision = currentRevision + 1;
        const now = Date.now();
        database.connection.prepare(`
          INSERT INTO memory_policy(policy_key, policy_kind, scope_owner_key, enabled, revision, updated_at)
          VALUES (@key, @kind, @scopeOwnerKey, @enabled, @revision, @updatedAt)
          ON CONFLICT(policy_key) DO UPDATE SET
            policy_kind = excluded.policy_kind,
            scope_owner_key = excluded.scope_owner_key,
            enabled = excluded.enabled,
            revision = excluded.revision,
            updated_at = excluded.updated_at
        `).run({
          key: input.key,
          kind: input.kind,
          scopeOwnerKey: input.scopeOwnerKey,
          enabled: input.enabled ? 1 : 0,
          revision: nextRevision,
          updatedAt: now,
        });
        const saved = readPolicy(input.key);
        if (saved === undefined) {
          throw new MemoryError("memory_store_failure", `Memory policy ${input.key} vanished after write.`);
        }
        return saved;
      });
    },

    async getLifecycle(ownerKey) {
      return readLifecycle(ownerKey);
    },

    async advanceGeneration(ownerKey) {
      return database.transaction(() => {
        const existing = readLifecycle(ownerKey);
        const now = Date.now();
        const nextGeneration = (existing?.generation ?? 0) + 1;
        database.connection.prepare(`
          INSERT INTO memory_lifecycle(owner_key, generation, capture_after, fence_state, updated_at)
          VALUES (?, ?, NULL, 'none', ?)
          ON CONFLICT(owner_key) DO UPDATE SET
            generation = excluded.generation,
            updated_at = excluded.updated_at
        `).run(ownerKey, nextGeneration, now);
        const saved = readLifecycle(ownerKey);
        if (saved === undefined) {
          throw new MemoryError("memory_store_failure", `Memory lifecycle ${ownerKey} vanished after write.`);
        }
        return saved;
      });
    },

    async setLifecycleFence(ownerKey, fenceState, captureAfter = null, expectedGeneration) {
      return database.transaction(() => {
        const existing = readLifecycle(ownerKey);
        const now = Date.now();
        const generation = existing?.generation ?? 0;
        if (expectedGeneration !== undefined && generation !== expectedGeneration) {
          throw new MemoryError(
            "memory_generation_fenced",
            `Memory lifecycle ${ownerKey} generation ${generation} does not match expected ${expectedGeneration}.`,
          );
        }
        database.connection.prepare(`
          INSERT INTO memory_lifecycle(owner_key, generation, capture_after, fence_state, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(owner_key) DO UPDATE SET
            capture_after = excluded.capture_after,
            fence_state = excluded.fence_state,
            updated_at = excluded.updated_at
        `).run(ownerKey, generation, captureAfter, fenceState, now);
        const saved = readLifecycle(ownerKey);
        if (saved === undefined) {
          throw new MemoryError("memory_store_failure", `Memory lifecycle ${ownerKey} vanished after fence write.`);
        }
        return saved;
      });
    },

    async fenceForRemoval(ownerKey) {
      return database.transaction(() => {
        const existing = readLifecycle(ownerKey);
        const now = Date.now();
        const nextGeneration = (existing?.generation ?? 0) + 1;
        database.connection.prepare(`
          INSERT INTO memory_lifecycle(owner_key, generation, capture_after, fence_state, updated_at)
          VALUES (?, ?, NULL, 'fenced', ?)
          ON CONFLICT(owner_key) DO UPDATE SET
            generation = excluded.generation,
            capture_after = NULL,
            fence_state = 'fenced',
            updated_at = excluded.updated_at
        `).run(ownerKey, nextGeneration, now);
        const saved = readLifecycle(ownerKey);
        if (saved === undefined || saved.generation !== nextGeneration || saved.fenceState !== "fenced") {
          throw new MemoryError("memory_store_failure", `Atomic removal fence for ${ownerKey} did not settle.`);
        }
        return saved;
      });
    },

    async enqueueOrAdvanceJob(input) {
      return database.transaction(() => {
        const active = database.connection.prepare(`
          SELECT ${JOB_COLUMNS} FROM memory_job
          WHERE conversation_id = ? AND status IN ('queued', 'running')
          ORDER BY created_at LIMIT 1
        `).get(input.conversationId) as Record<string, SQLInputValue> | undefined;
        const now = Date.now();
        if (active !== undefined) {
          if (String(active.owner_key) !== input.ownerKey) {
            throw new MemoryError(
              "memory_invalid_owner",
              `Active memory job for ${input.conversationId} belongs to ${String(active.owner_key)}, not ${input.ownerKey}.`,
            );
          }
          database.connection.prepare(`
            UPDATE memory_job SET
              covered_through_turn_id = ?,
              covered_through_ordinal = ?,
              source_fingerprint = ?,
              generation = ?,
              policy_revision = ?,
              updated_at = ?
            WHERE job_id = ?
          `).run(
            input.coveredThroughTurnId,
            input.coveredThroughOrdinal,
            input.sourceFingerprint,
            input.generation,
            input.policyRevision,
            now,
            String(active.job_id),
          );
          const saved = readJob(String(active.job_id));
          if (saved === undefined) throw new MemoryError("memory_store_failure", "Active memory job vanished after advance.");
          return saved;
        }
        const jobId = idFactory("memjob");
        database.connection.prepare(`
          INSERT INTO memory_job(
            job_id, conversation_id, owner_key, covered_through_turn_id, covered_through_ordinal,
            source_fingerprint, status, attempt, generation, policy_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
        `).run(
          jobId,
          input.conversationId,
          input.ownerKey,
          input.coveredThroughTurnId,
          input.coveredThroughOrdinal,
          input.sourceFingerprint,
          input.generation,
          input.policyRevision,
          now,
          now,
        );
        const saved = readJob(jobId);
        if (saved === undefined) throw new MemoryError("memory_store_failure", "New memory job vanished after insert.");
        return saved;
      });
    },

    async listJobsByStatus(status) {
      const rows = database.connection
        .prepare(`SELECT ${JOB_COLUMNS} FROM memory_job WHERE status = ? ORDER BY created_at`)
        .all(status) as Record<string, SQLInputValue>[];
      return rows.map(parseJobRow);
    },

    async transitionJob(jobId, fromStatus, toStatus) {
      return database.transaction(() => {
        const existing = readJob(jobId);
        if (existing === undefined || existing.status !== fromStatus) return undefined;
        database.connection.prepare(`
          UPDATE memory_job SET status = ?, updated_at = ? WHERE job_id = ?
        `).run(toStatus, Date.now(), jobId);
        return readJob(jobId);
      });
    },

    async recoverInterruptedJobs() {
      return database.transaction(() => {
        const interrupted = database.connection
          .prepare(`SELECT job_id FROM memory_job WHERE status = 'running'`)
          .all() as { readonly job_id: string }[];
        for (const row of interrupted) {
          database.connection.prepare(`
            UPDATE memory_job SET status = 'queued', attempt = attempt + 1, updated_at = ?
            WHERE job_id = ? AND status = 'running'
          `).run(Date.now(), row.job_id);
        }
        return interrupted.length;
      });
    },
  };
}
