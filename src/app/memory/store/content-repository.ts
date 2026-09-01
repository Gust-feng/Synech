import type { SQLInputValue } from "node:sqlite";

import type { SqliteRuntimeDatabase } from "../../../adapters/runtime-storage/index.js";
import { createId, type IdFactory } from "../../../kernel/id.js";
import { MemoryError } from "../contracts.js";
import { MEMORY_MIGRATIONS } from "./control-repository.js";
import {
  parseCaptureCursorRow,
  parseIndexOutboxRow,
  parseRecordRow,
  parseRecordSourceRow,
  type MemoryCaptureCursorRow,
  type MemoryIndexOutboxRow,
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
 * - 同一逻辑 record 的 revision 只增，同一 record 至多一个 active 版本（partial unique）。
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
  readonly recordRefs: readonly { readonly id: string; readonly revision: number }[];
  readonly cursor: MemoryCaptureCursorRow;
};

export interface MemoryContentRepository {
  /** 单事务原子提交一次提炼结果并推进连续游标；失败整体回滚。 */
  commitConsolidation(input: CommitConsolidationInput): Promise<CommitConsolidationResult>;
  getCursor(conversationId: string): Promise<MemoryCaptureCursorRow | undefined>;
  listActiveByOwner(ownerKey: string): Promise<readonly MemoryRecordRow[]>;
  listSources(recordId: string, revision: number): Promise<readonly MemoryRecordSourceRow[]>;
  claimPendingOutbox(limit: number): Promise<readonly MemoryIndexOutboxRow[]>;
  markOutbox(outboxId: string, status: PersistedOutboxStatus): Promise<MemoryIndexOutboxRow | undefined>;
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

  return {
    async commitConsolidation(input) {
      return database.transaction(() => {
        const now = Date.now();
        // 1. fence / generation 复核（锁内重读，不信任提炼时的旧读）。
        const lifecycleRow = database.connection
          .prepare("SELECT generation, fence_state FROM memory_lifecycle WHERE owner_key = ?")
          .get(input.ownerKey) as { generation: number; fence_state: string } | undefined;
        const currentGeneration = lifecycleRow?.generation ?? 0;
        if (lifecycleRow !== undefined && (lifecycleRow.fence_state === "fenced" || lifecycleRow.fence_state === "tombstone")) {
          throw new MemoryError(
            "memory_generation_fenced",
            `Owner ${input.ownerKey} is ${lifecycleRow.fence_state}; consolidation must not write.`,
          );
        }
        for (const record of input.records) {
          if (record.generation !== currentGeneration) {
            throw new MemoryError(
              "memory_generation_fenced",
              `Record generation ${record.generation} != current ${currentGeneration} for ${input.ownerKey}.`,
            );
          }
        }

        // 2. 连续游标只进不退。
        const existingCursor = readCursor(input.conversationId);
        if (
          existingCursor !== undefined &&
          existingCursor.coveredThroughOrdinal > input.advanceCursorTo.coveredThroughOrdinal
        ) {
          throw new MemoryError(
            "memory_store_failure",
            `Capture cursor for ${input.conversationId} would regress ` +
              `${existingCursor.coveredThroughOrdinal} -> ${input.advanceCursorTo.coveredThroughOrdinal}.`,
          );
        }

        // 3. 写 record（revision 只增）+ sources + outbox，全部在本事务内。
        const ownerKind = ownerKindOf(input.ownerKey);
        const recordRefs: { id: string; revision: number }[] = [];
        for (const record of input.records) {
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
            // 旧版本退出索引投影。
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
            input.ownerKey,
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
          input.conversationId,
          input.ownerKey,
          input.advanceCursorTo.coveredThroughOrdinal,
          input.advanceCursorTo.sourceFingerprint,
          now,
        );

        const cursor = readCursor(input.conversationId);
        if (cursor === undefined) {
          throw new MemoryError("memory_store_failure", "Capture cursor vanished after commit.");
        }
        return { recordRefs, cursor };
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
  };
}
