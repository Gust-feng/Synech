import type { SQLInputValue } from "node:sqlite";

import { createHash } from "node:crypto";

import type { SqliteRuntimeDatabase } from "../../../adapters/runtime-storage/index.js";
import { createId, type IdFactory } from "../../../kernel/id.js";
import { MemoryError } from "../contracts.js";
import { lexicalProjection } from "../recall/lexical-projection.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import { MEMORY_MIGRATIONS } from "./control-repository.js";
import { memoryOwnerFromKey } from "./owner-keys.js";
import {
  parseCaptureProgressRow,
  parseDocSourceRow,
  parseLifecycleRow,
  parsePolicyRow,
  parseSpaceDocRow,
  parseSummaryRow,
  parseTranscriptCoverageRow,
  type MemoryCaptureProgressRow,
  type MemoryDocSourceRow,
  type MemoryLifecycleRow,
  type MemoryPolicyRow,
  type MemorySpaceDocRow,
  type MemorySummaryRow,
  type MemoryTranscriptCoverageRow,
} from "./persistence-schema.js";

/**
 * Memory 文档产物仓储（0.6.0）：拥有 Space 长期文档 revision、会话累计总结
 * revision、文档级来源依赖、processed/excluded 进度、transcript 索引投影与
 * 摘要 FTS 投影。控制状态（policy/lifecycle/job）归 MemoryControlRepository。
 *
 * 不变量（受核心测试保护）：
 * - 一次整理批次的「总结 revision + 可选 memory revision + 来源复制 + 进度推进 +
 *   job 收敛」共享同一 SQLite 事务；policy/generation/claim/expected revision 任一
 *   不符即整批废弃，不留半态（正式设计 §8.1）；
 * - expectedSummaryRevisionId / expectedMemoryHeadRevisionId 是发布 CAS：后台整理
 *   与用户直接编辑（writeSpaceMemory）互相使在途结果失效；
 * - 来源依赖保守继承：新 revision 复制前一 revision 的全部来源行并追加本批范围；
 *   删除失效按 conversation_id 直查，引用被删来源的版本（含已绑定版本）整体失效；
 * - processed 游标只进不退；excluded 高水位只进不退，提炼范围不得与排除区间重叠；
 * - transcript/summary FTS 是派生投影：检索结果一律回表复核 owner/validity，
 *   跨 scope 泄漏恒为 0。
 */

export type TranscriptIndexEntry = {
  readonly ordinal: number;
  readonly text: string;
  readonly sourceRevision: number;
};

export type CommitMaintenanceBatchInput = {
  readonly jobId: string;
  readonly claimToken: string;
  readonly conversationId: string;
  readonly ownerKey: string;
  /** job 领取时捕获的权威 admission；提交时锁内重读并比对。 */
  readonly expectedPolicyRevision: string;
  readonly expectedGeneration: number;
  /** 批次读取的会话总结 revision（null = 该会话尚无有效总结）；发布 CAS。 */
  readonly expectedSummaryRevisionId: string | null;
  /** 批次读取的 Space 记忆 head revision（null = 尚无有效文档）；发布 CAS。 */
  readonly expectedMemoryHeadRevisionId: string | null;
  readonly summary: {
    readonly markdown: string;
    readonly coveredThroughOrdinal: number;
  };
  readonly longTermUpdate: { readonly markdown: string } | null;
  /** 本批实际送入模型的连续证据范围（来源依赖与 transcript 索引的依据）。 */
  readonly batchRange: {
    readonly fromOrdinal: number;
    readonly toOrdinal: number;
    readonly sourceRevision: number;
  };
  readonly advanceProgressTo: {
    /** 最后一个「完整消费」的 ordinal；进度只推进到完整轮次（R01）。 */
    readonly ordinal: number;
    readonly sourceFingerprint: string;
    /**
     * 片段级进度（N04）：单轮超过请求容量时按片段消费——该 ordinal 未读完，
     * end 记录其字符流中已消费的终点；轮次读完后必须为 null。ordinal 必须
     * 大于上方完整推进边界。
     */
    readonly fragment?: { readonly ordinal: number; readonly end: number } | null;
  };
};

export type CommitMaintenanceBatchResult =
  | {
      readonly status: "committed";
      readonly summaryRevisionId: string;
      readonly memoryRevisionId: string | null;
      /** done：目标边界已收敛；queued：存在剩余范围或运行期间边界被扩大。 */
      readonly jobStatus: "done" | "queued";
    }
  | {
      readonly status: "discarded";
      /** 结构原因码：admission_off / admission_changed / claim_stale / summary_superseded / memory_head_superseded / range_excluded / progress_regressed。 */
      readonly reason: string;
    };

export type RecordUserEditInput = {
  readonly ownerKey: string;
  readonly markdown: string;
  readonly requestId: string;
  /** 用户编辑所基于的当前 head revision（null = 期望当前没有有效文档）；发布 CAS。 */
  readonly expectedRevisionId: string | null;
  readonly now: number;
};

export interface MemoryDocumentRepository {
  // -- 读取（绑定 / 注入复核 / 工具 / UI） -----------------------------------
  /** Space 长期文档当前 head（validity=valid 的最大 revision）。 */
  getActiveSpaceMemoryHead(ownerKey: string): Promise<MemorySpaceDocRow | undefined>;
  getSpaceMemoryRevision(revisionId: string): Promise<MemorySpaceDocRow | undefined>;
  /** 会话最近有效总结（默认查询形态）。 */
  getLatestValidSummary(conversationId: string): Promise<MemorySummaryRow | undefined>;
  getSummaryRevision(revisionId: string): Promise<MemorySummaryRow | undefined>;
  listSummarySources(revisionId: string): Promise<readonly MemoryDocSourceRow[]>;
  listSpaceDocSources(revisionId: string): Promise<readonly MemoryDocSourceRow[]>;
  getProgress(conversationId: string): Promise<MemoryCaptureProgressRow | undefined>;
  getTranscriptCoverage(conversationId: string): Promise<MemoryTranscriptCoverageRow | undefined>;
  /** Memory Center 只读视图统计（有效总结数与最近整理时间）。 */
  getSpaceViewStats(ownerKey: string): Promise<{
    readonly summaryCount: number;
    readonly lastMaintenanceAt: number | null;
  }>;

  // -- 单一发布事务（后台整理批次） ------------------------------------------
  commitMaintenanceBatch(input: CommitMaintenanceBatchInput): Promise<CommitMaintenanceBatchResult>;

  // -- 用户直接编辑（writeSpaceMemory 的仓储边界） ----------------------------
  recordUserSpaceMemoryEdit(input: RecordUserEditInput): Promise<MemorySpaceDocRow>;

  // -- 排除高水位（clear / 重新启用） ----------------------------------------
  /** excluded 只进不退；提炼起点 = max(processed, excluded) + 1。 */
  setExcludedThrough(input: {
    readonly conversationId: string;
    readonly ownerKey: string;
    readonly excludedThroughOrdinal: number;
    readonly now: number;
  }): Promise<MemoryCaptureProgressRow>;

  // -- transcript 索引维护 -----------------------------------------------------
  indexTranscriptRange(input: {
    readonly conversationId: string;
    readonly ownerKey: string;
    readonly entries: readonly TranscriptIndexEntry[];
    readonly now: number;
  }): Promise<MemoryTranscriptCoverageRow | undefined>;

  // -- 检索（FTS 投影 + 回表复核） ---------------------------------------------
  searchSummaries(input: {
    readonly ownerKey: string;
    readonly match: string;
    readonly conversationId?: string;
    readonly limit: number;
  }): Promise<readonly { readonly summary: MemorySummaryRow; readonly bm25: number }[]>;
  searchTranscript(input: {
    readonly ownerKey: string;
    readonly match: string;
    readonly conversationId?: string;
    readonly limit: number;
  }): Promise<readonly { readonly conversationId: string; readonly ordinal: number; readonly bm25: number }[]>;

  // -- 生命周期清理 -------------------------------------------------------------
  /**
   * 删除准备（fence 后调用）：引用该会话来源的全部文档/总结 revision 立即失效并
   * 退出摘要投影（含已被会话绑定的版本，不只检查 head）；幂等。
   */
  invalidateDependentRevisions(conversationId: string): Promise<void>;
  /** 删除收敛：物理清理该会话的总结、依赖它的文档 revision、进度、transcript 索引与任务。 */
  purgeConversation(conversationId: string): Promise<void>;
  purgeOwner(ownerKey: string, options?: { readonly preserveExclusions?: boolean }): Promise<void>;
  purgeAll(options?: { readonly preserveExclusions?: boolean }): Promise<void>;
}

const SPACE_DOC_COLUMNS =
  "revision_id, owner_key, revision, origin, markdown, validity, generation, content_hash, updated_at";
const SUMMARY_COLUMNS =
  "revision_id, conversation_id, owner_key, revision, markdown, validity, generation, content_hash, covered_through_ordinal, updated_at";
const SOURCE_COLUMNS =
  "source_id, revision_id, dep_kind, conversation_id, from_ordinal, to_ordinal, source_revision, request_id, created_at";
const PROGRESS_COLUMNS =
  "conversation_id, owner_key, processed_through_ordinal, excluded_through_ordinal, " +
  "processed_fragment_ordinal, processed_fragment_end, source_fingerprint, updated_at";

export type FtsSummaryHit = { readonly summary: MemorySummaryRow; readonly bm25: number };
export type FtsTranscriptHit = { readonly conversationId: string; readonly ordinal: number; readonly bm25: number };

export function contentHashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function createSqliteMemoryDocumentRepository(
  database: SqliteRuntimeDatabase,
  options: { readonly idFactory?: IdFactory } = {},
): MemoryDocumentRepository {
  database.migrate("memory", MEMORY_MIGRATIONS);
  const idFactory = options.idFactory ?? createId;

  const readSpaceDoc = (revisionId: string): MemorySpaceDocRow | undefined => {
    const row = database.connection
      .prepare(`SELECT ${SPACE_DOC_COLUMNS} FROM memory_space_doc WHERE revision_id = ?`)
      .get(revisionId) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseSpaceDocRow(row);
  };

  const readSummary = (revisionId: string): MemorySummaryRow | undefined => {
    const row = database.connection
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM memory_conversation_summary WHERE revision_id = ?`)
      .get(revisionId) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseSummaryRow(row);
  };

  const latestValidSpaceDoc = (ownerKey: string): MemorySpaceDocRow | undefined => {
    const row = database.connection.prepare(`
      SELECT ${SPACE_DOC_COLUMNS} FROM memory_space_doc
      WHERE owner_key = ? AND validity = 'valid'
      ORDER BY revision DESC LIMIT 1
    `).get(ownerKey) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseSpaceDocRow(row);
  };

  const latestValidSummary = (conversationId: string): MemorySummaryRow | undefined => {
    const row = database.connection.prepare(`
      SELECT ${SUMMARY_COLUMNS} FROM memory_conversation_summary
      WHERE conversation_id = ? AND validity = 'valid'
      ORDER BY revision DESC LIMIT 1
    `).get(conversationId) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseSummaryRow(row);
  };

  const readProgress = (conversationId: string): MemoryCaptureProgressRow | undefined => {
    const row = database.connection
      .prepare(`SELECT ${PROGRESS_COLUMNS} FROM memory_capture_progress WHERE conversation_id = ?`)
      .get(conversationId) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseCaptureProgressRow(row);
  };

  const readLifecycleRow = (ownerKey: string): MemoryLifecycleRow | undefined => {
    const row = database.connection
      .prepare("SELECT owner_key, generation, capture_after, fence_state, updated_at FROM memory_lifecycle WHERE owner_key = ?")
      .get(ownerKey) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseLifecycleRow(row);
  };

  const readPolicyRows = (): readonly MemoryPolicyRow[] => (
    database.connection
      .prepare("SELECT policy_key, policy_kind, scope_owner_key, enabled, revision, updated_at FROM memory_policy ORDER BY policy_key")
      .all() as Record<string, SQLInputValue>[]
  ).map(parsePolicyRow);

  /** 复制一个 revision 的全部来源行到新 revision（文档级保守继承）。 */
  const copySources = (fromRevisionId: string, toRevisionId: string, now: number): void => {
    const rows = database.connection
      .prepare(`SELECT ${SOURCE_COLUMNS} FROM memory_doc_source WHERE revision_id = ?`)
      .all(fromRevisionId) as Record<string, SQLInputValue>[];
    for (const row of rows) {
      const source = parseDocSourceRow(row);
      database.connection.prepare(`
        INSERT INTO memory_doc_source(
          source_id, revision_id, dep_kind, conversation_id, from_ordinal, to_ordinal,
          source_revision, request_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        idFactory("memsrc"),
        toRevisionId,
        source.depKind,
        source.conversationId,
        source.fromOrdinal,
        source.toOrdinal,
        source.sourceRevision,
        source.requestId,
        now,
      );
    }
  };

  const insertConversationRangeSource = (input: {
    readonly revisionId: string;
    readonly conversationId: string;
    readonly fromOrdinal: number;
    readonly toOrdinal: number;
    readonly sourceRevision: number;
    readonly now: number;
  }): void => {
    database.connection.prepare(`
      INSERT INTO memory_doc_source(
        source_id, revision_id, dep_kind, conversation_id, from_ordinal, to_ordinal,
        source_revision, request_id, created_at
      ) VALUES (?, ?, 'conversation_range', ?, ?, ?, ?, NULL, ?)
    `).run(
      idFactory("memsrc"),
      input.revisionId,
      input.conversationId,
      input.fromOrdinal,
      input.toOrdinal,
      input.sourceRevision,
      input.now,
    );
  };

  const nextSpaceDocRevision = (ownerKey: string): number => {
    const row = database.connection
      .prepare("SELECT MAX(revision) AS max_revision FROM memory_space_doc WHERE owner_key = ?")
      .get(ownerKey) as { max_revision: number | null };
    return (row.max_revision ?? 0) + 1;
  };

  const nextSummaryRevision = (conversationId: string): number => {
    const row = database.connection
      .prepare("SELECT MAX(revision) AS max_revision FROM memory_conversation_summary WHERE conversation_id = ?")
      .get(conversationId) as { max_revision: number | null };
    return (row.max_revision ?? 0) + 1;
  };

  /** 摘要 FTS 投影行与摘要行同生共死（事务内成对维护）。 */
  const insertSummaryFts = (summary: MemorySummaryRow): void => {
    database.connection.prepare(`
      INSERT INTO memory_summary_fts(revision_id, conversation_id, owner_key, validity, terms)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      summary.revisionId,
      summary.conversationId,
      summary.ownerKey,
      summary.validity,
      lexicalProjection(summary.markdown).join(" "),
    );
  };

  return {
    async getActiveSpaceMemoryHead(ownerKey) {
      return latestValidSpaceDoc(ownerKey);
    },

    async getSpaceMemoryRevision(revisionId) {
      return readSpaceDoc(revisionId);
    },

    async getLatestValidSummary(conversationId) {
      return latestValidSummary(conversationId);
    },

    async getSummaryRevision(revisionId) {
      return readSummary(revisionId);
    },

    async listSummarySources(revisionId) {
      const rows = database.connection
        .prepare(`SELECT ${SOURCE_COLUMNS} FROM memory_doc_source WHERE revision_id = ? AND dep_kind = 'conversation_range'`)
        .all(revisionId) as Record<string, SQLInputValue>[];
      return rows.map(parseDocSourceRow);
    },

    async listSpaceDocSources(revisionId) {
      const rows = database.connection
        .prepare(`SELECT ${SOURCE_COLUMNS} FROM memory_doc_source WHERE revision_id = ?`)
        .all(revisionId) as Record<string, SQLInputValue>[];
      return rows.map(parseDocSourceRow);
    },

    async getProgress(conversationId) {
      return readProgress(conversationId);
    },

    async getTranscriptCoverage(conversationId) {
      const row = database.connection
        .prepare("SELECT conversation_id, owner_key, indexed_through_ordinal, source_revision, updated_at FROM memory_transcript_coverage WHERE conversation_id = ?")
        .get(conversationId) as Record<string, SQLInputValue> | undefined;
      return row === undefined ? undefined : parseTranscriptCoverageRow(row);
    },

    async getSpaceViewStats(ownerKey) {
      const row = database.connection
        .prepare(`
          SELECT COUNT(*) AS summaryCount, MAX(updated_at) AS lastMaintenanceAt
          FROM memory_conversation_summary WHERE owner_key = ? AND validity = 'valid'
        `)
        .get(ownerKey) as { readonly summaryCount: SQLInputValue; readonly lastMaintenanceAt: SQLInputValue };
      return {
        summaryCount: Number(row.summaryCount),
        lastMaintenanceAt: row.lastMaintenanceAt === null || row.lastMaintenanceAt === undefined
          ? null
          : Number(row.lastMaintenanceAt),
      };
    },

    async commitMaintenanceBatch(input) {
      return database.transaction(() => {
        // 1. job 必须仍处于本批占用的 running 且 claim_token 自洽（BEGIN IMMEDIATE 下无并发写）。
        const jobRow = database.connection
          .prepare("SELECT job_id, conversation_id, owner_key, status, requested_through_ordinal, target_through_ordinal, claim_token, generation, policy_revision FROM memory_job WHERE job_id = ?")
          .get(input.jobId) as
            | {
                conversation_id: SQLInputValue;
                owner_key: SQLInputValue;
                status: SQLInputValue;
                requested_through_ordinal: SQLInputValue;
                target_through_ordinal: SQLInputValue;
                claim_token: SQLInputValue;
                generation: SQLInputValue;
                policy_revision: SQLInputValue;
              }
            | undefined;
        if (
          jobRow === undefined ||
          String(jobRow.status) !== "running" ||
          String(jobRow.conversation_id) !== input.conversationId ||
          String(jobRow.owner_key) !== input.ownerKey ||
          String(jobRow.claim_token) !== input.claimToken
        ) {
          return { status: "discarded" as const, reason: "claim_stale" };
        }

        // 2. 锁内重读 policy + lifecycle 并重算有效准入（提交边界当次重算）。
        const admission = resolveAdmissionFromPolicy({
          owner: memoryOwnerFromKey(input.ownerKey),
          conversationId: input.conversationId,
          policyRows: readPolicyRows(),
          ownerLifecycle: readLifecycleRow(input.ownerKey),
          conversationLifecycle: readLifecycleRow(`conversation:${input.conversationId}`),
        });
        if (admission.effective === "off") {
          return { status: "discarded" as const, reason: "admission_off" };
        }
        if (admission.policyRevision !== input.expectedPolicyRevision || admission.generation !== input.expectedGeneration) {
          return { status: "discarded" as const, reason: "admission_changed" };
        }

        // 3. 排除高水位不得与批次范围重叠（整理中途发生 clear/关闭）。
        const existingProgress = readProgress(input.conversationId);
        if (existingProgress !== undefined) {
          if (existingProgress.ownerKey !== input.ownerKey) {
            throw new MemoryError(
              "memory_invalid_owner",
              `Capture progress for ${input.conversationId} belongs to ${existingProgress.ownerKey}, not ${input.ownerKey}.`,
            );
          }
          if (existingProgress.excludedThroughOrdinal >= input.batchRange.fromOrdinal) {
            return { status: "discarded" as const, reason: "range_excluded" };
          }
          if (existingProgress.processedThroughOrdinal > input.advanceProgressTo.ordinal) {
            return { status: "discarded" as const, reason: "progress_regressed" };
          }
          if (existingProgress.processedThroughOrdinal === input.advanceProgressTo.ordinal &&
              existingProgress.processedFragmentOrdinal === input.advanceProgressTo.fragment?.ordinal &&
              (existingProgress.processedFragmentEnd ?? 0) > (input.advanceProgressTo.fragment?.end ?? 0)) {
            return { status: "discarded" as const, reason: "progress_regressed" };
          }
        }

        // 4. 发布 CAS：批次读取的总结/记忆 head 必须仍是当前有效版本（用户编辑或
        //    并发整理使 head 变化即废弃本批，绝不在被替换的理解之上继续改写）。
        const currentSummary = latestValidSummary(input.conversationId);
        if ((currentSummary?.revisionId ?? null) !== input.expectedSummaryRevisionId) {
          return { status: "discarded" as const, reason: "summary_superseded" };
        }
        const currentHead = latestValidSpaceDoc(input.ownerKey);
        if ((currentHead?.revisionId ?? null) !== input.expectedMemoryHeadRevisionId) {
          return { status: "discarded" as const, reason: "memory_head_superseded" };
        }

        const now = Date.now();

        // 5. 会话总结 revision（必需产物）。
        const summaryRevisionId = idFactory("memsum");
        const summaryRow: MemorySummaryRow = {
          revisionId: summaryRevisionId,
          conversationId: input.conversationId,
          ownerKey: input.ownerKey,
          revision: nextSummaryRevision(input.conversationId),
          markdown: input.summary.markdown,
          validity: "valid",
          generation: admission.generation,
          contentHash: contentHashOf(input.summary.markdown),
          coveredThroughOrdinal: input.summary.coveredThroughOrdinal,
          updatedAt: now,
        };
        database.connection.prepare(`
          INSERT INTO memory_conversation_summary(
            revision_id, conversation_id, owner_key, revision, markdown, validity,
            generation, content_hash, covered_through_ordinal, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'valid', ?, ?, ?, ?)
        `).run(
          summaryRow.revisionId,
          summaryRow.conversationId,
          summaryRow.ownerKey,
          summaryRow.revision,
          summaryRow.markdown,
          summaryRow.generation,
          summaryRow.contentHash,
          summaryRow.coveredThroughOrdinal,
          summaryRow.updatedAt,
        );
        insertSummaryFts(summaryRow);
        // 来源保守继承：前版总结的全部来源 + 本批范围。
        if (currentSummary !== undefined) {
          copySources(currentSummary.revisionId, summaryRevisionId, now);
        }
        insertConversationRangeSource({
          revisionId: summaryRevisionId,
          conversationId: input.conversationId,
          fromOrdinal: input.batchRange.fromOrdinal,
          toOrdinal: input.batchRange.toOrdinal,
          sourceRevision: input.batchRange.sourceRevision,
          now,
        });

        // 6. 可选 Space 记忆修订（整文替换）。
        let memoryRevisionId: string | null = null;
        if (input.longTermUpdate !== null) {
          memoryRevisionId = idFactory("memdoc");
          const docRow: MemorySpaceDocRow = {
            revisionId: memoryRevisionId,
            ownerKey: input.ownerKey,
            revision: nextSpaceDocRevision(input.ownerKey),
            origin: "model",
            markdown: input.longTermUpdate.markdown,
            validity: "valid",
            generation: admission.generation,
            contentHash: contentHashOf(input.longTermUpdate.markdown),
            updatedAt: now,
          };
          database.connection.prepare(`
            INSERT INTO memory_space_doc(
              revision_id, owner_key, revision, origin, markdown, validity,
              generation, content_hash, updated_at
            ) VALUES (?, ?, ?, 'model', ?, 'valid', ?, ?, ?)
          `).run(
            docRow.revisionId,
            docRow.ownerKey,
            docRow.revision,
            docRow.markdown,
            docRow.generation,
            docRow.contentHash,
            docRow.updatedAt,
          );
          // 保守继承当前 head 的全部来源 + 本批范围（普通发布不撤销旧版供给）。
          if (currentHead !== undefined) {
            copySources(currentHead.revisionId, memoryRevisionId, now);
          }
          insertConversationRangeSource({
            revisionId: memoryRevisionId,
            conversationId: input.conversationId,
            fromOrdinal: input.batchRange.fromOrdinal,
            toOrdinal: input.batchRange.toOrdinal,
            sourceRevision: input.batchRange.sourceRevision,
            now,
          });
        }

        // 7. 推进 processed 游标（只进不退）：完整轮次边界 + 可选片段偏移（N04）。
        const fragment = input.advanceProgressTo.fragment ?? null;
        if (fragment !== null && fragment.ordinal <= input.advanceProgressTo.ordinal) {
          throw new MemoryError(
            "memory_store_failure",
            `Fragment ordinal ${fragment.ordinal} must be beyond the complete boundary ${input.advanceProgressTo.ordinal}.`,
          );
        }
        database.connection.prepare(`
          INSERT INTO memory_capture_progress(
            conversation_id, owner_key, processed_through_ordinal, excluded_through_ordinal,
            processed_fragment_ordinal, processed_fragment_end, source_fingerprint, updated_at
          ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET
            processed_through_ordinal = excluded.processed_through_ordinal,
            processed_fragment_ordinal = excluded.processed_fragment_ordinal,
            processed_fragment_end = excluded.processed_fragment_end,
            source_fingerprint = excluded.source_fingerprint,
            updated_at = excluded.updated_at
        `).run(
          input.conversationId,
          input.ownerKey,
          input.advanceProgressTo.ordinal,
          fragment?.ordinal ?? null,
          fragment?.end ?? null,
          input.advanceProgressTo.sourceFingerprint,
          now,
        );

        // 8. job 收敛：目标边界到达且无扩展 → done；否则 queued 排到就绪队列尾。
        const requested = Number(jobRow.requested_through_ordinal);
        const target = Number(jobRow.target_through_ordinal);
        const jobStatus: "done" | "queued" =
          input.advanceProgressTo.ordinal >= target && requested <= target ? "done" : "queued";
        const updated = database.connection.prepare(`
          UPDATE memory_job SET
            status = ?,
            claim_token = NULL,
            ready_queued_at = ?,
            updated_at = ?
          WHERE job_id = ? AND status = 'running' AND claim_token = ?
        `).run(jobStatus, now, now, input.jobId, input.claimToken);
        if (Number(updated.changes) !== 1) {
          throw new MemoryError("memory_store_failure", `Memory job ${input.jobId} did not converge after commit.`);
        }

        return { status: "committed" as const, summaryRevisionId, memoryRevisionId, jobStatus };
      });
    },

    async recordUserSpaceMemoryEdit(input) {
      return database.transaction(() => {
        const lifecycleRow = readLifecycleRow(input.ownerKey);
        if (lifecycleRow !== undefined && (lifecycleRow.fenceState === "fenced" || lifecycleRow.fenceState === "tombstone")) {
          throw new MemoryError(
            "memory_generation_fenced",
            `Owner ${input.ownerKey} is ${lifecycleRow.fenceState}; user memory edit is rejected.`,
          );
        }
        const currentHead = latestValidSpaceDoc(input.ownerKey);
        if ((currentHead?.revisionId ?? null) !== input.expectedRevisionId) {
          throw new MemoryError(
            "memory_revision_stale",
            `Space memory head for ${input.ownerKey} is ${currentHead?.revisionId ?? "absent"}, expected ${input.expectedRevisionId ?? "absent"}.`,
          );
        }
        const now = input.now;
        const revisionId = idFactory("memdoc");
        const docRow: MemorySpaceDocRow = {
          revisionId,
          ownerKey: input.ownerKey,
          revision: nextSpaceDocRevision(input.ownerKey),
          origin: "user_edit",
          markdown: input.markdown,
          validity: "valid",
          generation: lifecycleRow?.generation ?? 0,
          contentHash: contentHashOf(input.markdown),
          updatedAt: now,
        };
        // 用户编辑是显式纠正：被此次编辑替换的全部旧有效版本（不只是被覆盖的
        // head）都停止供给——更早版本里同样存在被纠正前的错误事实，绑定它们的
        // 会话必须立即停止注入（R04）。保守来源继承到新版本，使权限/删除追踪
        // 连续；不自动换绑。（先撤销旧版再插入新版，避免误伤自身。）
        database.connection.prepare(`
          UPDATE memory_space_doc SET validity = 'invalidated'
          WHERE owner_key = ? AND validity = 'valid'
        `).run(input.ownerKey);
        database.connection.prepare(`
          INSERT INTO memory_space_doc(
            revision_id, owner_key, revision, origin, markdown, validity,
            generation, content_hash, updated_at
          ) VALUES (?, ?, ?, 'user_edit', ?, 'valid', ?, ?, ?)
        `).run(
          docRow.revisionId,
          docRow.ownerKey,
          docRow.revision,
          docRow.markdown,
          docRow.generation,
          docRow.contentHash,
          docRow.updatedAt,
        );
        if (currentHead !== undefined) {
          copySources(currentHead.revisionId, revisionId, now);
        }
        database.connection.prepare(`
          INSERT INTO memory_doc_source(
            source_id, revision_id, dep_kind, conversation_id, from_ordinal, to_ordinal,
            source_revision, request_id, created_at
          ) VALUES (?, ?, 'user_edit', NULL, NULL, NULL, 0, ?, ?)
        `).run(idFactory("memsrc"), revisionId, input.requestId, now);
        return docRow;
      });
    },

    async setExcludedThrough(input) {
      return database.transaction(() => {
        const existing = readProgress(input.conversationId);
        if (existing !== undefined && existing.ownerKey !== input.ownerKey) {
          throw new MemoryError(
            "memory_invalid_owner",
            `Capture progress for ${input.conversationId} belongs to ${existing.ownerKey}, not ${input.ownerKey}.`,
          );
        }
        const nextExcluded = Math.max(existing?.excludedThroughOrdinal ?? 0, input.excludedThroughOrdinal);
        const now = input.now;
        database.connection.prepare(`
          INSERT INTO memory_capture_progress(
            conversation_id, owner_key, processed_through_ordinal, excluded_through_ordinal,
            source_fingerprint, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET
            excluded_through_ordinal = excluded.excluded_through_ordinal,
            updated_at = excluded.updated_at
        `).run(
          input.conversationId,
          input.ownerKey,
          existing?.processedThroughOrdinal ?? 0,
          nextExcluded,
          existing?.sourceFingerprint ?? `excluded:${nextExcluded}`,
          now,
        );
        const saved = readProgress(input.conversationId);
        if (saved === undefined) throw new MemoryError("memory_store_failure", "Capture progress vanished after exclusion write.");
        return saved;
      });
    },

    async indexTranscriptRange(input) {
      return database.transaction(() => {
        let maxOrdinal = -1;
        let lastRevision = 0;
        for (const entry of input.entries) {
          database.connection.prepare(
            "DELETE FROM memory_transcript_fts WHERE conversation_id = ? AND ordinal = ?",
          ).run(input.conversationId, entry.ordinal);
          database.connection.prepare(`
            INSERT INTO memory_transcript_fts(conversation_id, ordinal, owner_key, terms)
            VALUES (?, ?, ?, ?)
          `).run(
            input.conversationId,
            entry.ordinal,
            input.ownerKey,
            lexicalProjection(entry.text).join(" "),
          );
          if (entry.ordinal > maxOrdinal) {
            maxOrdinal = entry.ordinal;
            lastRevision = entry.sourceRevision;
          }
        }
        if (maxOrdinal < 0) return undefined;
        const existing = database.connection
          .prepare("SELECT conversation_id, owner_key, indexed_through_ordinal, source_revision, updated_at FROM memory_transcript_coverage WHERE conversation_id = ?")
          .get(input.conversationId) as Record<string, SQLInputValue> | undefined;
        const current = existing === undefined ? undefined : parseTranscriptCoverageRow(existing);
        const nextThrough = Math.max(current?.indexedThroughOrdinal ?? 0, maxOrdinal);
        const now = input.now;
        database.connection.prepare(`
          INSERT INTO memory_transcript_coverage(
            conversation_id, owner_key, indexed_through_ordinal, source_revision, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET
            indexed_through_ordinal = excluded.indexed_through_ordinal,
            source_revision = excluded.source_revision,
            updated_at = excluded.updated_at
        `).run(input.conversationId, input.ownerKey, nextThrough, lastRevision, now);
        const saved = database.connection
          .prepare("SELECT conversation_id, owner_key, indexed_through_ordinal, source_revision, updated_at FROM memory_transcript_coverage WHERE conversation_id = ?")
          .get(input.conversationId) as Record<string, SQLInputValue>;
        return parseTranscriptCoverageRow(saved);
      });
    },

    async searchSummaries(input) {
      if (input.match.trim() === "" || input.limit <= 0) return [];
      const ftsLimit = Math.max(input.limit * 4, 16);
      // R12：会话范围条件在 LIMIT 之前过滤，不能先取全 Space top-k 再展示过滤。
      const hits = database.connection.prepare(`
        SELECT revision_id, bm25(memory_summary_fts) AS bm25_score
        FROM memory_summary_fts
        WHERE memory_summary_fts MATCH ? AND owner_key = ? AND validity = 'valid'
          AND (? IS NULL OR conversation_id = ?)
        ORDER BY bm25(memory_summary_fts)
        LIMIT ?
      `).all(input.match, input.ownerKey, input.conversationId ?? null, input.conversationId ?? null, ftsLimit) as {
        readonly revision_id: SQLInputValue;
        readonly bm25_score: SQLInputValue;
      }[];
      const results: FtsSummaryHit[] = [];
      for (const hit of hits) {
        const row = readSummary(String(hit.revision_id));
        if (row === undefined || row.validity !== "valid" || row.ownerKey !== input.ownerKey) continue;
        results.push({ summary: row, bm25: Number(hit.bm25_score) });
        if (results.length >= input.limit) break;
      }
      return results;
    },

    async searchTranscript(input) {
      if (input.match.trim() === "" || input.limit <= 0) return [];
      const hits = database.connection.prepare(`
        SELECT conversation_id, ordinal, bm25(memory_transcript_fts) AS bm25_score
        FROM memory_transcript_fts
        WHERE memory_transcript_fts MATCH ? AND owner_key = ?
          AND (? IS NULL OR conversation_id = ?)
        ORDER BY bm25(memory_transcript_fts)
        LIMIT ?
      `).all(input.match, input.ownerKey, input.conversationId ?? null, input.conversationId ?? null, input.limit) as {
        readonly conversation_id: SQLInputValue;
        readonly ordinal: SQLInputValue;
        readonly bm25_score: SQLInputValue;
      }[];
      return hits.map((hit) => ({
        conversationId: String(hit.conversation_id),
        ordinal: Number(hit.ordinal),
        bm25: Number(hit.bm25_score),
      }));
    },

    async invalidateDependentRevisions(conversationId) {
      return database.transaction(() => {
        // 该会话自己的总结全部失效（总结只依赖本会话）。
        const ownSummaries = database.connection
          .prepare("SELECT revision_id FROM memory_conversation_summary WHERE conversation_id = ? AND validity = 'valid'")
          .all(conversationId) as { readonly revision_id: string }[];
        // 引用该会话来源的其他产物（Space 文档 revision）失效：文档级保守依赖
        // 包含被删会话自身的范围，删除即整份失效（正式设计 §11.4）。
        const dependent = database.connection
          .prepare(`
            SELECT s.revision_id AS revision_id, d.revision_id AS doc_id
            FROM memory_doc_source s
            LEFT JOIN memory_space_doc d ON d.revision_id = s.revision_id
            WHERE s.conversation_id = ? AND s.dep_kind = 'conversation_range'
              AND d.revision_id IS NOT NULL
          `)
          .all(conversationId) as { readonly revision_id: string; readonly doc_id: SQLInputValue }[];
        const invalidateSummary = database.connection.prepare(
          "UPDATE memory_conversation_summary SET validity = 'invalidated' WHERE revision_id = ? AND validity = 'valid'",
        );
        const invalidateDoc = database.connection.prepare(
          "UPDATE memory_space_doc SET validity = 'invalidated' WHERE revision_id = ? AND validity = 'valid'",
        );
        const removeSummaryFts = database.connection.prepare(
          "DELETE FROM memory_summary_fts WHERE revision_id = ?",
        );
        for (const row of ownSummaries) {
          invalidateSummary.run(row.revision_id);
          removeSummaryFts.run(row.revision_id);
        }
        for (const row of dependent) {
          invalidateDoc.run(String(row.doc_id));
        }
      });
    },

    async purgeConversation(conversationId) {
      return database.transaction(() => {
        // 总结：全部 revision 物理删除（含 FTS 行）。
        const summaries = database.connection
          .prepare("SELECT revision_id FROM memory_conversation_summary WHERE conversation_id = ?")
          .all(conversationId) as { readonly revision_id: string }[];
        for (const row of summaries) {
          database.connection.prepare("DELETE FROM memory_summary_fts WHERE revision_id = ?").run(row.revision_id);
          database.connection.prepare("DELETE FROM memory_doc_source WHERE revision_id = ?").run(row.revision_id);
        }
        database.connection.prepare("DELETE FROM memory_conversation_summary WHERE conversation_id = ?").run(conversationId);
        // 依赖该会话来源的 Space 文档 revision（已在 prepare 失效）物理删除。
        const dependentDocs = database.connection
          .prepare(`
            SELECT DISTINCT s.revision_id AS revision_id FROM memory_doc_source s
            JOIN memory_space_doc d ON d.revision_id = s.revision_id
            WHERE s.conversation_id = ? AND s.dep_kind = 'conversation_range'
          `)
          .all(conversationId) as { readonly revision_id: string }[];
        for (const row of dependentDocs) {
          database.connection.prepare("DELETE FROM memory_space_doc WHERE revision_id = ?").run(row.revision_id);
          database.connection.prepare("DELETE FROM memory_doc_source WHERE revision_id = ?").run(row.revision_id);
        }
        // transcript 索引与进度、任务。
        database.connection.prepare("DELETE FROM memory_transcript_fts WHERE conversation_id = ?").run(conversationId);
        database.connection.prepare("DELETE FROM memory_transcript_coverage WHERE conversation_id = ?").run(conversationId);
        database.connection.prepare("DELETE FROM memory_capture_progress WHERE conversation_id = ?").run(conversationId);
        database.connection.prepare("DELETE FROM memory_job WHERE conversation_id = ?").run(conversationId);
      });
    },

    async purgeOwner(ownerKey, options = {}) {
      return database.transaction(() => {
        const docs = database.connection
          .prepare("SELECT revision_id FROM memory_space_doc WHERE owner_key = ?")
          .all(ownerKey) as { readonly revision_id: string }[];
        for (const row of docs) {
          database.connection.prepare("DELETE FROM memory_doc_source WHERE revision_id = ?").run(row.revision_id);
        }
        database.connection.prepare("DELETE FROM memory_space_doc WHERE owner_key = ?").run(ownerKey);
        const summaries = database.connection
          .prepare("SELECT revision_id FROM memory_conversation_summary WHERE owner_key = ?")
          .all(ownerKey) as { readonly revision_id: string }[];
        for (const row of summaries) {
          database.connection.prepare("DELETE FROM memory_summary_fts WHERE revision_id = ?").run(row.revision_id);
          // R10：总结来源行没有外键级联，必须与总结行同事务清理。
          database.connection.prepare("DELETE FROM memory_doc_source WHERE revision_id = ?").run(row.revision_id);
        }
        database.connection.prepare("DELETE FROM memory_conversation_summary WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_transcript_fts WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_transcript_coverage WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_job WHERE owner_key = ?").run(ownerKey);
        if (options.preserveExclusions !== true) {
          database.connection.prepare("DELETE FROM memory_capture_progress WHERE owner_key = ?").run(ownerKey);
        }
      });
    },

    async purgeAll(options = {}) {
      return database.transaction(() => {
        database.connection.prepare("DELETE FROM memory_summary_fts").run();
        database.connection.prepare("DELETE FROM memory_transcript_fts").run();
        database.connection.prepare("DELETE FROM memory_transcript_coverage").run();
        database.connection.prepare("DELETE FROM memory_doc_source").run();
        database.connection.prepare("DELETE FROM memory_conversation_summary").run();
        database.connection.prepare("DELETE FROM memory_space_doc").run();
        database.connection.prepare("DELETE FROM memory_job").run();
        if (options.preserveExclusions !== true) {
          database.connection.prepare("DELETE FROM memory_capture_progress").run();
        }
      });
    },
  };
}
