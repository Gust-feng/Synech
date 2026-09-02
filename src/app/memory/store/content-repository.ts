import type { SQLInputValue } from "node:sqlite";

import type { SqliteRuntimeDatabase } from "../../../adapters/runtime-storage/index.js";
import type { MemoryOwner } from "../../../domain/memory/index.js";
import { createId, type IdFactory } from "../../../kernel/id.js";
import { MemoryError } from "../contracts.js";
import { lexicalProjection } from "../recall/lexical-projection.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import { MEMORY_MIGRATIONS } from "./control-repository.js";
import {
  parseCaptureCursorRow,
  parseIndexOutboxRow,
  parseLifecycleRow,
  parsePolicyRow,
  parseRecordRow,
  parseRecordSourceRow,
  type MemoryCaptureCursorRow,
  type MemoryIndexOutboxRow,
  type MemoryLifecycleRow,
  type MemoryRecordRow,
  type MemoryRecordSourceRow,
  type PersistedConfirmation,
  type PersistedEvidenceClass,
  type PersistedOutboxStatus,
  type PersistedRecordKind,
} from "./persistence-schema.js";

/**
 * Memory 内容仓储（M3）：拥有 MemoryRecord / Source / 连续游标 / 索引 outbox
 * 四类内容状态（《手册》8.2–8.5）。控制状态（policy/lifecycle/job）归
 * MemoryControlRepository，本仓储只在提交边界内读取 lifecycle 做 fence/generation 复核。
 *
 * 不变量（受测试保护）：
 * - 一次提炼的 Record + Source + 游标推进 + Outbox 入队共享同一 SQLite 事务，
 *   任一步失败整体回滚，不留"有 record 无游标/有游标无 outbox"的半态（手册 9.3）；
 * - 连续游标只进不退，回退即 memory_store_failure（禁止 newest-first 截断后跳游标）；
 * - owner 处于 fenced/tombstone，或记录携带的 generation 与当前不一致，一律拒写
 *   memory_generation_fenced（提炼期间被删除/清除的结果不得落库）；
 * - 同一逻辑 record 的 revision 只增，同一 record 至多一个 active 版本（partial unique）；
 * - memory_record_fts（memory/3）是 record 的派生检索投影：与 record 同事务写入/
 *   退休，检索结果必须回表复核 scope/status/generation，跨 scope 泄漏恒为 0。
 */

export type ConsolidationSourceInput = {
  readonly conversationId: string;
  readonly runId?: string | null;
  readonly turnId?: string | null;
  readonly fromOrdinal?: number | null;
  readonly toOrdinal?: number | null;
  readonly sourceRevision: number;
};

export type ConsolidationRecordInput = {
  /** 缺省表示新建逻辑记录，由工厂生成 id；传入表示给既有逻辑记录出新 revision。 */
  readonly recordId?: string;
  readonly kind: PersistedRecordKind;
  readonly modelText: string;
  readonly evidenceClass: PersistedEvidenceClass;
  readonly confirmation: PersistedConfirmation;
  readonly contentHash: string;
  /** Host 在提炼前读到的 owner generation；提交时必须仍与当前一致。 */
  readonly generation: number;
  readonly effectiveAt?: number;
  readonly sources: readonly ConsolidationSourceInput[];
};

export type CommitConsolidationInput = {
  readonly conversationId: string;
  readonly ownerKey: string;
  /** 可为空：本次送入模型但判定无值得沉淀时，仍需推进游标避免重复处理。 */
  readonly records: readonly ConsolidationRecordInput[];
  readonly advanceCursorTo: {
    readonly coveredThroughOrdinal: number;
    readonly sourceFingerprint: string;
  };
};

export type CommitConsolidationResult = {
  readonly recordRefs: readonly { readonly id: string; revision: number }[];
  readonly cursor: MemoryCaptureCursorRow;
};

/**
 * T21 组合提交：在同一个 SQLite 事务内完成「锁内 admission 重读 → Record + Source +
 * Cursor + 退休 + job 置 done」。供 Consolidation 提炼管线在模型调用后调用；
 * 纯内容提交（无 job/admission）仍走 `commitConsolidation`。
 */
export type CommitConsolidationWithAdmissionInput = {
  readonly conversationId: string;
  readonly ownerKey: string;
  /** 本次提炼占用的 durable job；`completeJob` 时同事务内置 done。 */
  readonly jobId: string;
  /** job 在 accept 时捕获的权威 revision/generation；提交时锁内重读并比对，不符即废弃本批。 */
  readonly expectedPolicyRevision: string;
  readonly expectedGeneration: number;
  readonly records: readonly ConsolidationRecordInput[];
  /** retire 操作：把既有逻辑记录的 active 版本置 retired 并退出索引投影。 */
  readonly retireRecordIds: readonly string[];
  readonly advanceCursorTo: {
    readonly coveredThroughOrdinal: number;
    readonly sourceFingerprint: string;
  };
  /** true 表示本批已覆盖 job 边界，job 与内容同事务收敛为 done。 */
  readonly completeJob: boolean;
};

export type CommitConsolidationWithAdmissionResult =
  | { readonly status: "committed"; readonly recordRefs: CommitConsolidationResult["recordRefs"]; readonly cursor: MemoryCaptureCursorRow }
  | {
      readonly status: "discarded";
      /** 结构原因码：admission_off / admission_revision_changed / generation_changed / job_not_running。 */
      readonly reason: string;
    };

/** 由持久化 owner_key 还原 MemoryOwner（admission 复核用）；不认识的结构一律拒绝。 */
export function memoryOwnerFromKey(ownerKey: string): MemoryOwner {
  if (ownerKey === "global") return { kind: "global" };
  const separatorIndex = ownerKey.indexOf(":");
  const kind = separatorIndex === -1 ? "" : ownerKey.slice(0, separatorIndex);
  const id = separatorIndex === -1 ? "" : ownerKey.slice(separatorIndex + 1);
  if ((kind === "space" || kind === "workspace") && id.length > 0) return { kind, id };
  throw new MemoryError("memory_invalid_owner", `Cannot parse memory owner key ${ownerKey}.`);
}

export interface MemoryContentRepository {
  /** 单事务原子提交一次提炼结果并推进连续游标；失败整体回滚。 */
  commitConsolidation(input: CommitConsolidationInput): Promise<CommitConsolidationResult>;
  /**
   * T21 组合原子提交（手册 9.1/9.3、6.1 提交顺序）：同一事务内先锁内重读
   * policy + lifecycle 并重算有效准入（off / revision 或 generation 与 job 捕获值
   * 不符 → 整批废弃、不推进游标、不写任何行），再写入 Record + Source + 投影 +
   * Outbox + 游标，最后按 `completeJob` 把 job 置 done。任何一步失败整体回滚。
   */
  commitConsolidationWithAdmission(
    input: CommitConsolidationWithAdmissionInput,
  ): Promise<CommitConsolidationWithAdmissionResult>;
  getCursor(conversationId: string): Promise<MemoryCaptureCursorRow | undefined>;
  listActiveByOwner(ownerKey: string): Promise<readonly MemoryRecordRow[]>;
  listSources(recordId: string, revision: number): Promise<readonly MemoryRecordSourceRow[]>;
  claimPendingOutbox(limit: number): Promise<readonly MemoryIndexOutboxRow[]>;
  markOutbox(outboxId: string, status: PersistedOutboxStatus): Promise<MemoryIndexOutboxRow | undefined>;
  /**
   * 检索投影查询（memory/3，《手册》8.4/16.2）：FTS5 MATCH + bm25 排序后回表
   * 复核 scope（owner_key + status='active' + generation），跨 scope 泄漏恒为 0
   * （《手册》10.2 fail-closed）。投影行是派生数据：不与 memory_record 成对的
   * 孤儿行一律丢弃。`match` 必须是已构建的 FTS5 MATCH 表达式（recall 侧用
   * lexicalMatchExpression 生成）；空表达式直接返回空（MATCH '' 不是合法查询）。
   */
  searchActiveByProjection(input: {
    readonly ownerKey: string;
    readonly match: string;
    readonly generation: number;
    readonly limit: number;
  }): Promise<readonly MemoryRecordRow[]>;
  /**
   * Memory store 自身修订（按 owner scope 的 active 内容计数 + 最新 updated_at）；
   * 只作诊断快照展示，不是权威 revision。
   */
  storeRevision(ownerKey: string): Promise<string>;
}

const RECORD_COLUMNS =
  "record_id, revision, owner_key, owner_kind, kind, model_text, status, evidence_class, confirmation, content_hash, generation, created_at, updated_at, effective_at";
const SOURCE_COLUMNS =
  "source_id, record_id, revision, conversation_id, run_id, turn_id, from_ordinal, to_ordinal, source_revision";
const CURSOR_COLUMNS =
  "conversation_id, owner_key, covered_through_ordinal, source_fingerprint, updated_at";
const OUTBOX_COLUMNS = "outbox_id, record_id, revision, op, status, attempts, created_at, updated_at";

function ownerKindOf(ownerKey: string): "global" | "space" | "workspace" {
  if (ownerKey === "global") return "global";
  if (ownerKey.startsWith("space:")) return "space";
  if (ownerKey.startsWith("workspace:")) return "workspace";
  throw new MemoryError("memory_invalid_owner", `Cannot derive owner kind from key ${ownerKey}.`);
}

export function createSqliteMemoryContentRepository(
  database: SqliteRuntimeDatabase,
  options: { readonly idFactory?: IdFactory } = {},
): MemoryContentRepository {
  database.migrate("memory", MEMORY_MIGRATIONS);
  const idFactory = options.idFactory ?? createId;

  const readCursor = (conversationId: string): MemoryCaptureCursorRow | undefined => {
    const row = database.connection
      .prepare(`SELECT ${CURSOR_COLUMNS} FROM memory_capture_cursor WHERE conversation_id = ?`)
      .get(conversationId) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseCaptureCursorRow(row);
  };

  const readOutbox = (outboxId: string): MemoryIndexOutboxRow | undefined => {
    const row = database.connection
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM memory_index_outbox WHERE outbox_id = ?`)
      .get(outboxId) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseIndexOutboxRow(row);
  };

  // 提炼内容的唯一写入路径：fence/generation 复核 → 游标单调校验 → record/source/
  // 检索投影/outbox/retire → 游标推进。commitConsolidation 与 commitConsolidationWithAdmission
  // 共享同一段实现，保证两条提交边界的写入不变量完全一致（事务由调用方开启）。
  const writeConsolidationContentLocked = (write: {
    readonly conversationId: string;
    readonly ownerKey: string;
    readonly records: readonly ConsolidationRecordInput[];
    readonly retireRecordIds: readonly string[];
    readonly advanceCursorTo: {
      readonly coveredThroughOrdinal: number;
      readonly sourceFingerprint: string;
    };
  }): CommitConsolidationResult => {
    const now = Date.now();
    // 1. fence / generation 复核（锁内重读，不信任提炼时的旧读）。
    const lifecycleRow = database.connection
      .prepare("SELECT generation, fence_state FROM memory_lifecycle WHERE owner_key = ?")
      .get(write.ownerKey) as { generation: number; fence_state: string } | undefined;
    const currentGeneration = lifecycleRow?.generation ?? 0;
    if (lifecycleRow !== undefined && (lifecycleRow.fence_state === "fenced" || lifecycleRow.fence_state === "tombstone")) {
      throw new MemoryError(
        "memory_generation_fenced",
        `Owner ${write.ownerKey} is ${lifecycleRow.fence_state}; consolidation must not write.`,
      );
    }
    for (const record of write.records) {
      if (record.generation !== currentGeneration) {
        throw new MemoryError(
          "memory_generation_fenced",
          `Record generation ${record.generation} != current ${currentGeneration} for ${write.ownerKey}.`,
        );
      }
    }

    // 2. 连续游标只进不退。
    const existingCursor = readCursor(write.conversationId);
    if (
      existingCursor !== undefined &&
      existingCursor.coveredThroughOrdinal > write.advanceCursorTo.coveredThroughOrdinal
    ) {
      throw new MemoryError(
        "memory_store_failure",
        `Capture cursor for ${write.conversationId} would regress ` +
          `${existingCursor.coveredThroughOrdinal} -> ${write.advanceCursorTo.coveredThroughOrdinal}.`,
      );
    }

    // 3. 写 record（revision 只增）+ sources + outbox，全部在本事务内。
    const ownerKind = ownerKindOf(write.ownerKey);
    const recordRefs: { id: string; revision: number }[] = [];
    for (const record of write.records) {
      const recordId = record.recordId ?? idFactory("memrec");
      const maxRevisionRow = database.connection
        .prepare("SELECT MAX(revision) AS max_revision FROM memory_record WHERE record_id = ?")
        .get(recordId) as { max_revision: number | null };
      const nextRevision = (maxRevisionRow.max_revision ?? 0) + 1;
      const effectiveAt = record.effectiveAt ?? now;
      // 同一逻辑记录出新版本：先在本事务内 retire 旧 active 版本，
      // 保证 partial unique index（每 record 至多一个 active）成立。
      if (nextRevision > 1) {
        database.connection.prepare(`
          UPDATE memory_record SET status = 'retired', updated_at = ?
          WHERE record_id = ? AND status = 'active'
        `).run(now, recordId);
        // 旧版本退出索引投影：FTS 状态同事务内翻转，旧文本立即停止召回。
        database.connection.prepare(`
          UPDATE memory_record_fts SET status = 'retired'
          WHERE record_id = ? AND revision = ?
        `).run(recordId, nextRevision - 1);
        // outbox remove 入队保留：memory_index_outbox 是通用索引工作队列，
        // FTS 投影已同事务内直接翻转，后续索引消费端（如向量索引）仍走 outbox。
        database.connection.prepare(`
          INSERT INTO memory_index_outbox(outbox_id, record_id, revision, op, status, attempts, created_at, updated_at)
          VALUES (?, ?, ?, 'remove', 'pending', 0, ?, ?)
        `).run(idFactory("memout"), recordId, nextRevision - 1, now, now);
      }
      database.connection.prepare(`
        INSERT INTO memory_record(
          record_id, revision, owner_key, owner_kind, kind, model_text, status,
          evidence_class, confirmation, content_hash, generation,
          created_at, updated_at, effective_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        nextRevision,
        write.ownerKey,
        ownerKind,
        record.kind,
        record.modelText,
        record.evidenceClass,
        record.confirmation,
        record.contentHash,
        record.generation,
        now,
        now,
        effectiveAt,
      );
      // 同事务写入 lexical 检索投影（《手册》8.4）：FTS 行与 record 行同生共死，
      // 事务回滚时两者一起消失，不存在"有 record 无投影/有投影无 record"的半态。
      database.connection.prepare(`
        INSERT INTO memory_record_fts(record_id, revision, owner_key, status, generation, terms)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(
        recordId,
        nextRevision,
        write.ownerKey,
        record.generation,
        lexicalProjection(record.modelText).join(" "),
      );

      for (const source of record.sources) {
        database.connection.prepare(`
          INSERT INTO memory_record_source(
            source_id, record_id, revision, conversation_id, run_id, turn_id,
            from_ordinal, to_ordinal, source_revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          idFactory("memsrc"),
          recordId,
          nextRevision,
          source.conversationId,
          source.runId ?? null,
          source.turnId ?? null,
          source.fromOrdinal ?? null,
          source.toOrdinal ?? null,
          source.sourceRevision,
        );
      }

      database.connection.prepare(`
        INSERT INTO memory_index_outbox(outbox_id, record_id, revision, op, status, attempts, created_at, updated_at)
        VALUES (?, ?, ?, 'index', 'pending', 0, ?, ?)
      `).run(idFactory("memout"), recordId, nextRevision, now, now);

      recordRefs.push({ id: recordId, revision: nextRevision });
    }

    // 3b. retire 操作：active 版本置 retired 并同事务退出索引投影；
    // 记录已不活跃（并发 retire / 重复 op）时幂等跳过。
    for (const recordId of write.retireRecordIds) {
      const activeRow = database.connection
        .prepare("SELECT revision FROM memory_record WHERE record_id = ? AND status = 'active'")
        .get(recordId) as { revision: number } | undefined;
      if (activeRow === undefined) continue;
      database.connection.prepare(`
        UPDATE memory_record SET status = 'retired', updated_at = ?
        WHERE record_id = ? AND revision = ? AND status = 'active'
      `).run(now, recordId, Number(activeRow.revision));
      database.connection.prepare(`
        INSERT INTO memory_index_outbox(outbox_id, record_id, revision, op, status, attempts, created_at, updated_at)
        VALUES (?, ?, ?, 'remove', 'pending', 0, ?, ?)
      `).run(idFactory("memout"), recordId, Number(activeRow.revision), now, now);
      database.connection.prepare(`
        UPDATE memory_record_fts SET status = 'retired'
        WHERE record_id = ? AND revision = ?
      `).run(recordId, Number(activeRow.revision));
    }

    // 4. 推进连续游标（即使无新 record 也推进，避免重复送入模型）。
    database.connection.prepare(`
      INSERT INTO memory_capture_cursor(
        conversation_id, owner_key, covered_through_ordinal, source_fingerprint, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        owner_key = excluded.owner_key,
        covered_through_ordinal = excluded.covered_through_ordinal,
        source_fingerprint = excluded.source_fingerprint,
        updated_at = excluded.updated_at
    `).run(
      write.conversationId,
      write.ownerKey,
      write.advanceCursorTo.coveredThroughOrdinal,
      write.advanceCursorTo.sourceFingerprint,
      now,
    );

    const cursor = readCursor(write.conversationId);
    if (cursor === undefined) {
      throw new MemoryError("memory_store_failure", "Capture cursor vanished after commit.");
    }
    return { recordRefs, cursor };
  };

  return {
    async commitConsolidation(input) {
      return database.transaction(() =>
        writeConsolidationContentLocked({ ...input, retireRecordIds: [] })
      );
    },

    async commitConsolidationWithAdmission(input) {
      return database.transaction(() => {
        // 1. 锁内重读 policy + lifecycle 并重算有效准入（《手册》7.1：提交边界当次
        // 重算，不信任 accept/提炼时的旧结论）。off 一律废弃本批。
        const policyRows = (
          database.connection
            .prepare(`
              SELECT policy_key, policy_kind, scope_owner_key, enabled, revision, updated_at
              FROM memory_policy ORDER BY policy_key
            `)
            .all() as Record<string, SQLInputValue>[]
        ).map(parsePolicyRow);
        const readLifecycleRow = (ownerKey: string): MemoryLifecycleRow | undefined => {
          const row = database.connection
            .prepare(`
              SELECT owner_key, generation, capture_after, fence_state, updated_at
              FROM memory_lifecycle WHERE owner_key = ?
            `)
            .get(ownerKey) as Record<string, SQLInputValue> | undefined;
          return row === undefined ? undefined : parseLifecycleRow(row);
        };
        const admission = resolveAdmissionFromPolicy({
          owner: memoryOwnerFromKey(input.ownerKey),
          conversationId: input.conversationId,
          turnOverrideOff: false,
          policyRows,
          ownerLifecycle: readLifecycleRow(input.ownerKey),
          conversationLifecycle: readLifecycleRow(`conversation:${input.conversationId}`),
        });
        if (admission.effective === "off") {
          return { status: "discarded" as const, reason: "admission_off" };
        }
        // 2. 权威 revision/generation 与 job 捕获值不符（含模型调用期间发生的变化）
        // 即废弃本批（《手册》12.3：在途旧任务提交时因 revision 不匹配失效）。
        if (admission.policyRevision !== input.expectedPolicyRevision) {
          return { status: "discarded" as const, reason: "admission_revision_changed" };
        }
        if (admission.generation !== input.expectedGeneration) {
          return { status: "discarded" as const, reason: "generation_changed" };
        }
        // 3. job 必须仍处于本批占用的 running 且捕获值自洽（BEGIN IMMEDIATE 下无并发写）。
        const jobRow = database.connection
          .prepare("SELECT status, conversation_id, policy_revision, generation FROM memory_job WHERE job_id = ?")
          .get(input.jobId) as
            | { status: SQLInputValue; conversation_id: SQLInputValue; policy_revision: SQLInputValue; generation: SQLInputValue }
            | undefined;
        if (
          jobRow === undefined ||
          String(jobRow.status) !== "running" ||
          String(jobRow.conversation_id) !== input.conversationId ||
          String(jobRow.policy_revision) !== input.expectedPolicyRevision ||
          Number(jobRow.generation) !== input.expectedGeneration
        ) {
          return { status: "discarded" as const, reason: "job_not_running" };
        }

        // 4. 共享写入路径（fence/generation/游标单调在此再次成立）。
        const written = writeConsolidationContentLocked({
          conversationId: input.conversationId,
          ownerKey: input.ownerKey,
          records: input.records,
          retireRecordIds: input.retireRecordIds,
          advanceCursorTo: input.advanceCursorTo,
        });

        // 5. Record+Source+Cursor+job 状态在同一事务原子提交（《手册》9.1）。
        if (input.completeJob) {
          const updated = database.connection
            .prepare(`
              UPDATE memory_job SET status = 'done', updated_at = ?
              WHERE job_id = ? AND status = 'running'
            `)
            .run(Date.now(), input.jobId);
          if (Number(updated.changes) !== 1) {
            throw new MemoryError(
              "memory_store_failure",
              `Memory job ${input.jobId} was not running when completing consolidation.`,
            );
          }
        }
        return { status: "committed" as const, recordRefs: written.recordRefs, cursor: written.cursor };
      });
    },

    async getCursor(conversationId) {
      return readCursor(conversationId);
    },

    async listActiveByOwner(ownerKey) {
      const rows = database.connection
        .prepare(`SELECT ${RECORD_COLUMNS} FROM memory_record WHERE owner_key = ? AND status = 'active' ORDER BY updated_at`)
        .all(ownerKey) as Record<string, SQLInputValue>[];
      return rows.map(parseRecordRow);
    },

    async listSources(recordId, revision) {
      const rows = database.connection
        .prepare(`SELECT ${SOURCE_COLUMNS} FROM memory_record_source WHERE record_id = ? AND revision = ?`)
        .all(recordId, revision) as Record<string, SQLInputValue>[];
      return rows.map(parseRecordSourceRow);
    },

    async claimPendingOutbox(limit) {
      const rows = database.connection
        .prepare(`SELECT ${OUTBOX_COLUMNS} FROM memory_index_outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?`)
        .all(limit) as Record<string, SQLInputValue>[];
      return rows.map(parseIndexOutboxRow);
    },

    async markOutbox(outboxId, status) {
      return database.transaction(() => {
        const existing = readOutbox(outboxId);
        if (existing === undefined) return undefined;
        database.connection.prepare(`
          UPDATE memory_index_outbox SET status = ?, attempts = attempts + 1, updated_at = ? WHERE outbox_id = ?
        `).run(status, Date.now(), outboxId);
        return readOutbox(outboxId);
      });
    },

    async searchActiveByProjection(input) {
      // 空 MATCH 表达式不是合法查询（投影为空 = 查询文本无可用 token）；
      // 直接返回空候选，语义等同 no-hit 而非 degraded。
      if (input.match.trim() === "" || input.limit <= 0) return [];
      // FTS5 行级过滤（UNINDEXED 列）先于回表；多取一截以对冲孤儿/失效投影行，
      // 避免回表复核后有效候选不足 limit。
      const ftsLimit = Math.max(input.limit * 4, 16);
      const hits = database.connection.prepare(`
        SELECT record_id, revision FROM memory_record_fts
        WHERE memory_record_fts MATCH ? AND owner_key = ? AND status = 'active' AND generation = ?
        ORDER BY bm25(memory_record_fts)
        LIMIT ?
      `).all(input.match, input.ownerKey, input.generation, ftsLimit) as {
        readonly record_id: SQLInputValue;
        readonly revision: SQLInputValue;
      }[];
      const results: MemoryRecordRow[] = [];
      for (const hit of hits) {
        // 回表复核：scope/状态/generation 以 memory_record 为准，投影行只是加速结构。
        const row = database.connection
          .prepare(`SELECT ${RECORD_COLUMNS} FROM memory_record WHERE record_id = ? AND revision = ?`)
          .get(String(hit.record_id), Number(hit.revision)) as Record<string, SQLInputValue> | undefined;
        if (row === undefined) continue;
        const record = parseRecordRow(row);
        if (
          record.ownerKey !== input.ownerKey ||
          record.status !== "active" ||
          record.generation !== input.generation
        ) {
          continue;
        }
        results.push(record);
        if (results.length >= input.limit) break;
      }
      return results;
    },

    async storeRevision(ownerKey) {
      const row = database.connection
        .prepare(`
          SELECT COUNT(*) AS activeCount, COALESCE(MAX(updated_at), 0) AS lastUpdate
          FROM memory_record WHERE owner_key = ? AND status = 'active'
        `)
        .get(ownerKey) as { readonly activeCount: SQLInputValue; readonly lastUpdate: SQLInputValue };
      return `v${Number(row.activeCount)}:${Number(row.lastUpdate)}`;
    },
  };
}
