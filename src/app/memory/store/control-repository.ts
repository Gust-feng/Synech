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
 * Memory 控制状态仓储：拥有 policy 分账、lifecycle fence/generation 和
 * 每会话空闲调度 job 边界；文档产物（Space 记忆 / 会话总结 / 来源 / 进度 /
 * transcript 索引）由 MemoryDocumentRepository 拥有。
 *
 * 不变量：
 * - policy 写入走 CAS（expectedRevision），冲突即 memory_policy_revision_stale；
 * - lifecycle.generation 只单调递增，清除/删除靠它立 fence；
 * - 每个会话至多一个活跃（queued/running）job（partial unique）；
 * - 领取（claim）CAS 冻结 targetThrough 并发放 claimToken；提交/放弃必须携带
 *   同一 claimToken，失去 claim 的旧结果不得写回；
 * - 进程重启后 running 必须 recoverInterruptedJobs 回到 queued（durable 边界不丢）。
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
}, {
  version: 4,
  sql: `
    CREATE TABLE memory_policy_v4 (
      policy_key TEXT PRIMARY KEY,
      policy_kind TEXT NOT NULL CHECK(policy_kind IN ('global_consent', 'rollout', 'space_participation')),
      scope_owner_key TEXT,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      revision INTEGER NOT NULL CHECK(revision > 0),
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO memory_policy_v4(policy_key, policy_kind, scope_owner_key, enabled, revision, updated_at)
      SELECT
        policy_key,
        CASE WHEN policy_kind = 'scope_participation' THEN 'space_participation' ELSE policy_kind END,
        scope_owner_key,
        enabled,
        revision,
        updated_at
      FROM memory_policy
      WHERE policy_kind IN ('global_consent', 'rollout')
        OR (policy_kind = 'scope_participation' AND scope_owner_key GLOB 'space:*');
    DROP TABLE memory_policy;
    ALTER TABLE memory_policy_v4 RENAME TO memory_policy;
  `,
}, {
  // v5（0.6.0 文档产物重构）：删除记录时代的表，创建目标文档 schema。旧开发库由
  // PRODUCT_DATA_FORMAT_ID 升级在迁移前拒绝（显式 reset 处理），本迁移只为全新
  // 数据库从 v4 状态确定性地构造目标 schema：
  // - memory_space_doc / memory_conversation_summary：不可变 revision 文档产物；
  // - memory_doc_source：文档级保守依赖（revision 间复制继承）；
  // - memory_capture_progress：processed / excluded 两种进度分离（取代旧 cursor）；
  // - memory_job：重建为每会话空闲调度边界（eligible_at/claim_token/target_through）；
  // - memory_summary_fts / memory_transcript_fts + memory_transcript_coverage：
  //   摘要与原文的 FTS5 派生投影（中文 bigram/拉丁词 lexical projection）。
  version: 5,
  sql: `
    DROP TABLE IF EXISTS memory_record_fts;
    DROP TABLE IF EXISTS memory_index_outbox;
    DROP TABLE IF EXISTS memory_record_source;
    DROP TABLE IF EXISTS memory_record;
    DROP TABLE IF EXISTS memory_capture_cursor;
    DROP TABLE IF EXISTS memory_job;

    CREATE TABLE memory_space_doc (
      revision_id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      origin TEXT NOT NULL CHECK(origin IN ('model', 'user_edit')),
      markdown TEXT NOT NULL,
      validity TEXT NOT NULL CHECK(validity IN ('valid', 'invalidated')),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      content_hash TEXT NOT NULL CHECK(length(content_hash) > 0),
      updated_at INTEGER NOT NULL,
      UNIQUE(owner_key, revision)
    ) STRICT;
    CREATE INDEX memory_space_doc_owner_idx ON memory_space_doc(owner_key, validity, revision);

    CREATE TABLE memory_conversation_summary (
      revision_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      markdown TEXT NOT NULL CHECK(length(markdown) > 0),
      validity TEXT NOT NULL CHECK(validity IN ('valid', 'invalidated')),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      content_hash TEXT NOT NULL CHECK(length(content_hash) > 0),
      covered_through_ordinal INTEGER NOT NULL CHECK(covered_through_ordinal >= 0),
      updated_at INTEGER NOT NULL,
      UNIQUE(conversation_id, revision)
    ) STRICT;
    CREATE INDEX memory_conversation_summary_owner_idx
      ON memory_conversation_summary(owner_key, validity);
    CREATE INDEX memory_conversation_summary_conversation_idx
      ON memory_conversation_summary(conversation_id, validity, revision);

    CREATE TABLE memory_doc_source (
      source_id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL,
      dep_kind TEXT NOT NULL CHECK(dep_kind IN ('conversation_range', 'user_edit')),
      conversation_id TEXT,
      from_ordinal INTEGER CHECK(from_ordinal IS NULL OR from_ordinal >= 0),
      to_ordinal INTEGER CHECK(to_ordinal IS NULL OR to_ordinal >= 0),
      source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
      request_id TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX memory_doc_source_revision_idx ON memory_doc_source(revision_id);
    CREATE INDEX memory_doc_source_conversation_idx ON memory_doc_source(conversation_id);

    CREATE TABLE memory_capture_progress (
      conversation_id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      processed_through_ordinal INTEGER NOT NULL CHECK(processed_through_ordinal >= 0),
      excluded_through_ordinal INTEGER NOT NULL CHECK(excluded_through_ordinal >= 0),
      source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint) > 0),
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX memory_capture_progress_owner_idx ON memory_capture_progress(owner_key);

    CREATE TABLE memory_job (
      job_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'failed')),
      requested_through_ordinal INTEGER NOT NULL CHECK(requested_through_ordinal >= 0),
      target_through_ordinal INTEGER NOT NULL CHECK(target_through_ordinal >= 0),
      eligible_at INTEGER NOT NULL,
      ready_queued_at INTEGER NOT NULL,
      next_attempt_at INTEGER,
      claim_token TEXT,
      attempt INTEGER NOT NULL CHECK(attempt >= 0),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      policy_revision TEXT NOT NULL,
      last_failure TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX memory_job_active_unique_idx ON memory_job(conversation_id)
      WHERE status IN ('queued', 'running');
    CREATE INDEX memory_job_due_idx ON memory_job(status, eligible_at);

    CREATE VIRTUAL TABLE memory_summary_fts USING fts5(
      terms,
      revision_id UNINDEXED,
      conversation_id UNINDEXED,
      owner_key UNINDEXED,
      validity UNINDEXED,
      tokenize = 'unicode61'
    );

    CREATE VIRTUAL TABLE memory_transcript_fts USING fts5(
      terms,
      conversation_id UNINDEXED,
      ordinal UNINDEXED,
      owner_key UNINDEXED,
      tokenize = 'unicode61'
    );

    CREATE TABLE memory_transcript_coverage (
      conversation_id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      indexed_through_ordinal INTEGER NOT NULL CHECK(indexed_through_ordinal >= 0),
      source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
      updated_at INTEGER NOT NULL
    ) STRICT;
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

export type AcceptConversationSignalInput = {
  readonly conversationId: string;
  readonly ownerKey: string;
  /** 本次稳定信号覆盖到的 ordinal（requestedThrough 的候选值）。 */
  readonly stableThroughOrdinal: number;
  readonly sourceFingerprint: string;
  /** eligibleAt = stableAt + 空闲时长，由调用方计算后传入。 */
  readonly eligibleAt: number;
  readonly now: number;
  readonly generation: number;
  readonly policyRevision: string;
};

export type ClaimJobInput = {
  readonly jobId: string;
  readonly claimToken: string;
  readonly now: number;
};

export type FinishJobInput = {
  readonly jobId: string;
  readonly claimToken: string;
  /** done：批次已收敛目标边界；queued：重排（重试/剩余范围）；failed：终态。 */
  readonly status: "done" | "queued" | "failed";
  readonly now: number;
  /** queued 时的下次尝试时间（退避）；undefined 表示立即可领取。 */
  readonly nextAttemptAt?: number | null;
  readonly lastFailure?: string;
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

  /**
   * 稳定信号接单：存在活跃 job 则只扩大 requestedThrough 并重算 eligibleAt
   * （新输入重置 attempt 预算），否则新建 queued job。无新增证据（边界没有前进）
   * 时不创建任务、原样返回 undefined。
   */
  acceptConversationSignal(input: AcceptConversationSignalInput): Promise<MemoryJobRow | undefined>;
  /** 到期资格过滤（eligible_at/next_attempt_at ≤ now）后的就绪队列，按 ready_queued_at 排序。 */
  listDueJobs(input: { readonly now: number; readonly limit: number }): Promise<readonly MemoryJobRow[]>;
  /** CAS 领取：queued→running、冻结 targetThrough=requestedThrough、发放 claimToken。 */
  claimJob(input: ClaimJobInput): Promise<MemoryJobRow | undefined>;
  /** 携带 claimToken 的收敛：done / 重排（剩余范围或退避重试）/ 终态 failed。 */
  finishJob(input: FinishJobInput): Promise<MemoryJobRow | undefined>;
  listJobsByStatus(status: PersistedJobStatus): Promise<readonly MemoryJobRow[]>;
  /** 启动恢复：把残留 running job 退回 queued 并 attempt+1，返回恢复数量。 */
  recoverInterruptedJobs(): Promise<number>;
}

const POLICY_COLUMNS =
  "policy_key, policy_kind, scope_owner_key, enabled, revision, updated_at";
const LIFECYCLE_COLUMNS =
  "owner_key, generation, capture_after, fence_state, updated_at";
const JOB_COLUMNS =
  "job_id, conversation_id, owner_key, status, requested_through_ordinal, target_through_ordinal, " +
  "eligible_at, ready_queued_at, next_attempt_at, claim_token, attempt, generation, policy_revision, " +
  "last_failure, created_at, updated_at";

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

    async acceptConversationSignal(input) {
      return database.transaction(() => {
        const active = database.connection.prepare(`
          SELECT ${JOB_COLUMNS} FROM memory_job
          WHERE conversation_id = ? AND status IN ('queued', 'running')
          ORDER BY created_at LIMIT 1
        `).get(input.conversationId) as Record<string, SQLInputValue> | undefined;
        const now = input.now;
        if (active !== undefined) {
          if (String(active.owner_key) !== input.ownerKey) {
            throw new MemoryError(
              "memory_invalid_owner",
              `Active memory job for ${input.conversationId} belongs to ${String(active.owner_key)}, not ${input.ownerKey}.`,
            );
          }
          const requested = Number(active.requested_through_ordinal);
          if (input.stableThroughOrdinal <= requested) {
            // 迟到的旧信号不得缩小边界或重置空闲计时。
            const saved = readJob(String(active.job_id));
            return saved;
          }
          database.connection.prepare(`
            UPDATE memory_job SET
              requested_through_ordinal = ?,
              eligible_at = ?,
              attempt = 0,
              next_attempt_at = NULL,
              generation = ?,
              policy_revision = ?,
              updated_at = ?
            WHERE job_id = ?
          `).run(
            input.stableThroughOrdinal,
            input.eligibleAt,
            input.generation,
            input.policyRevision,
            now,
            String(active.job_id),
          );
          const saved = readJob(String(active.job_id));
          if (saved === undefined) throw new MemoryError("memory_store_failure", "Active memory job vanished after extension.");
          return saved;
        }
        // 无活跃 job：只有当边界确实前进（超过排除/处理高水位之下的旧边界）时才新建。
        // 这里只保证不重复为同一边界建 job；processed/excluded 的最终判断由 worker
        // 领取后的证据窗口决定（空窗口直接收敛，不调用模型）。
        const jobId = idFactory("memjob");
        database.connection.prepare(`
          INSERT INTO memory_job(
            job_id, conversation_id, owner_key, status,
            requested_through_ordinal, target_through_ordinal,
            eligible_at, ready_queued_at, next_attempt_at, claim_token,
            attempt, generation, policy_revision, last_failure, created_at, updated_at
          ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, NULL, NULL, 0, ?, ?, NULL, ?, ?)
        `).run(
          jobId,
          input.conversationId,
          input.ownerKey,
          input.stableThroughOrdinal,
          input.stableThroughOrdinal,
          input.eligibleAt,
          input.eligibleAt,
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

    async listDueJobs(input) {
      const rows = database.connection.prepare(`
        SELECT ${JOB_COLUMNS} FROM memory_job
        WHERE status = 'queued'
          AND eligible_at <= ?
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY ready_queued_at, conversation_id
        LIMIT ?
      `).all(input.now, input.now, input.limit) as Record<string, SQLInputValue>[];
      return rows.map(parseJobRow);
    },

    async claimJob(input) {
      return database.transaction(() => {
        // R07：领取时在权威边界重验最新资格（列表快照之后新到达的稳定信号会
        // 重算 eligibleAt/next_attempt_at，过期快照不得跳过新的空闲等待）。
        const updated = database.connection.prepare(`
          UPDATE memory_job SET
            status = 'running',
            target_through_ordinal = requested_through_ordinal,
            claim_token = ?,
            attempt = attempt + 1,
            updated_at = ?
          WHERE job_id = ? AND status = 'queued' AND claim_token IS NULL
            AND eligible_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        `).run(input.claimToken, input.now, input.jobId, input.now, input.now);
        if (Number(updated.changes) !== 1) return undefined;
        const saved = readJob(input.jobId);
        if (saved === undefined) throw new MemoryError("memory_store_failure", "Claimed memory job vanished.");
        return saved;
      });
    },

    async finishJob(input) {
      return database.transaction(() => {
        const updated = database.connection.prepare(`
          UPDATE memory_job SET
            status = ?,
            claim_token = NULL,
            ready_queued_at = ?,
            next_attempt_at = ?,
            last_failure = ?,
            updated_at = ?
          WHERE job_id = ? AND status = 'running' AND claim_token = ?
        `).run(
          input.status,
          input.now,
          input.nextAttemptAt ?? null,
          input.lastFailure ?? null,
          input.now,
          input.jobId,
          input.claimToken,
        );
        if (Number(updated.changes) !== 1) return undefined;
        const saved = readJob(input.jobId);
        if (saved === undefined) throw new MemoryError("memory_store_failure", "Finished memory job vanished.");
        return saved;
      });
    },

    async listJobsByStatus(status) {
      const rows = database.connection
        .prepare(`SELECT ${JOB_COLUMNS} FROM memory_job WHERE status = ? ORDER BY ready_queued_at`)
        .all(status) as Record<string, SQLInputValue>[];
      return rows.map(parseJobRow);
    },

    async recoverInterruptedJobs() {
      return database.transaction(() => {
        const interrupted = database.connection
          .prepare(`SELECT job_id FROM memory_job WHERE status = 'running'`)
          .all() as { readonly job_id: string }[];
        for (const row of interrupted) {
          database.connection.prepare(`
            UPDATE memory_job SET
              status = 'queued',
              claim_token = NULL,
              ready_queued_at = ?,
              next_attempt_at = NULL,
              attempt = attempt + 1,
              updated_at = ?
            WHERE job_id = ? AND status = 'running'
          `).run(Date.now(), Date.now(), row.job_id);
        }
        return interrupted.length;
      });
    },
  };
}
