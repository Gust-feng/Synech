import type { SQLInputValue } from "node:sqlite";

import { createHash } from "node:crypto";
import { z } from "zod";
import { memoryOwnerKey } from "../../../domain/memory/index.js";
import { createMemoryEntryStoreOperations } from "./entry-store-operations.js";

import type { SqliteRuntimeDatabase } from "../../../adapters/runtime-storage/index.js";
import { createId, type IdFactory } from "../../../kernel/id.js";
import { MemoryError } from "../contracts.js";
import { lexicalProjection } from "../recall/lexical-projection.js";
import { capturePublicationMatches, type CapturePublication } from "../policy/capture-publication.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import { MEMORY_MIGRATIONS } from "./control-repository.js";
import { memoryOwnerFromKey } from "./owner-keys.js";
import {
  parseJobRow,
  parseMemoryTopicRow,
  parseCaptureProgressRow,
  parseDocSourceRow,
  parseLifecycleRow,
  parsePolicyRow,
  parseOwnerDocRow,
  parseSummaryRow,
  parseTranscriptCoverageRow,
  type MemoryCaptureProgressRow,
  type MemoryDocSourceRow,
  type MemoryLifecycleRow,
  type MemoryPolicyRow,
  type MemoryOwnerDocRow,
  type MemorySummaryRow,
  type MemoryTranscriptCoverageRow,
} from "./persistence-schema.js";

/** Single Memory SQLite owner: entries, revisions, provenance, overview and auxiliary publication share one transaction. */

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
  /** 批次读取的 owner 记忆 head revision（null = 尚无有效文档）；发布 CAS。 */
  readonly expectedMemoryHeadRevisionId: string | null;
  readonly summary: {
    readonly markdown: string;
    readonly coveredThroughOrdinal: number;
  };
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

export interface MemoryDocumentRepository {
  hasContent(ownerKey?: string): Promise<boolean>;
  // -- 读取（绑定 / 注入复核 / 工具 / UI） -----------------------------------
  /** owner 长期文档当前 head（validity=valid 的最大 revision）。 */
  getActiveOwnerMemoryHead(ownerKey: string): Promise<MemoryOwnerDocRow | undefined>;
  getOwnerMemoryRevision(revisionId: string): Promise<MemoryOwnerDocRow | undefined>;
  /** 会话最近有效总结（默认查询形态）。 */
  getLatestValidSummary(conversationId: string): Promise<MemorySummaryRow | undefined>;
  getSummaryRevision(revisionId: string): Promise<MemorySummaryRow | undefined>;
  listSummarySources(revisionId: string): Promise<readonly MemoryDocSourceRow[]>;
  listMemoryDocSources(revisionId: string): Promise<readonly MemoryDocSourceRow[]>;
  getProgress(conversationId: string): Promise<MemoryCaptureProgressRow | undefined>;
  getTranscriptCoverage(conversationId: string): Promise<MemoryTranscriptCoverageRow | undefined>;
  /** Memory Center 只读视图统计（有效总结数与最近整理时间）。 */
  getOwnerViewStats(ownerKey: string): Promise<{
    readonly summaryCount: number;
    readonly lastMaintenanceAt: number | null;
  }>;

  // -- 单一发布事务（后台维护批次） ------------------------------------------
  commitMaintenanceBatch(input: CommitMemoryEntriesBatchInput): Promise<CommitMemoryEntriesBatchResult>;

  // -- 用户直接编辑（updateMemory 的仓储边界） ----------------------------
  recordUserMemoryEdit(input: RecordUserEntryEditInput): Promise<UpdateMemoryEntryResult>;

  // -- 排除高水位（clear / 重新启用） ----------------------------------------
  /** excluded 只进不退；提炼起点 = max(processed, excluded) + 1。 */
  setExcludedThrough(input: {
    readonly conversationId: string;
    readonly ownerKey: string;
    readonly excludedThroughOrdinal: number;
    readonly now: number;
  }): Promise<MemoryCaptureProgressRow>;

  /** Transactional return boundary: policy, revision and source fences are read as one snapshot. */
  /** Only ordinals already captured with valid admission are available to history tools. */
  listTranscriptOrdinals(input: { readonly ownerKey: string; readonly conversationId: string; readonly fromOrdinal: number; readonly limit: number }): Promise<readonly number[]>;

  // -- transcript 索引维护 -----------------------------------------------------
  indexTranscriptRange(input: {
    readonly conversationId: string;
    readonly ownerKey: string;
    readonly entries: readonly TranscriptIndexEntry[];
    readonly publication: CapturePublication;
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
  getEntry(input: { readonly ownerKey: string; readonly entryId: string }): Promise<MemoryEntry | undefined>;
  getEntryRevision(input: { readonly ownerKey: string; readonly entryId: string; readonly revisionId: string }): Promise<MemoryEntryRevisionView | undefined>;
  /** Candidate discovery only; C applies budgets and calls authoritative resolveEntries. */
  searchEntryCandidates(input: {
    readonly ownerKey: string;
    readonly match: string;
    readonly topicId?: string;
    readonly conversationId?: string;
    readonly includeHistory: boolean;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly candidates: readonly MemoryEntryRevisionRef[]; readonly nextCursor: string | null }>;
  listEntries(input: { readonly ownerKey: string; readonly limit: number; readonly cursor?: string }): Promise<{
    readonly entries: readonly MemoryEntryRevisionView[];
    readonly nextCursor: string | null;
  }>;
  listEntryRevisions(input: {
    readonly ownerKey: string; readonly entryId: string; readonly limit: number; readonly cursor?: string;
  }): Promise<{ readonly revisions: readonly MemoryEntryRevisionRef[]; readonly nextCursor: string | null }>;
  listTopics(ownerKey: string): Promise<readonly MemoryTopic[]>;
  /** Atomic final query boundary rechecks policy/generation and all current source states. */
  resolveEntries(input: {
    readonly ownerKey: string;
    readonly expectedPolicyRevision: string;
    readonly expectedGeneration: number;
    readonly entries: readonly MemoryEntryRevisionRef[];
  }): Promise<readonly MemoryEntryRevisionView[] | undefined>;
  listOverviewDependencies(revisionId: string): Promise<MemoryOverviewDependencies>;
  getSupplyableMemoryRevision(input: {
    readonly ownerKey: string; readonly revisionId: string; readonly generation: number;
  }): Promise<(MemoryOwnerDocRow & { readonly sourceStates: readonly MemoryOverviewSourceState[] }) | undefined>;
  /** After conversation fence: retain published entries, mark sources deleted, purge auxiliaries. */
  markConversationSourcesDeleted(conversationId: string): Promise<void>;
  purgeConversationAuxiliaries(conversationId: string, options?: { readonly preserveExclusions?: boolean }): Promise<void>;
  /** Within the branch fence: conservative range retirement, no recognition deletion. */
  supersedeConversationSources(input: SupersedeConversationSourcesInput): Promise<void>;
  purgeOwner(ownerKey: string, options?: { readonly preserveExclusions?: boolean }): Promise<void>;
  purgeAll(options?: { readonly preserveExclusions?: boolean }): Promise<void>;
}

import type {
  MemoryEntry,
  MemoryEntryPublicationMutation,
  MemoryEntryQueryPort,
  MemoryEntryRevisionRef,
  MemoryEntryRevisionView,
  MemoryOverviewDependencies,
  MemoryOverviewSourceState,
  MemorySource,
  MemoryTopic,
  SupersedeConversationSourcesInput,
  UpdateMemoryEntryInput,
  UpdateMemoryEntryResult,
} from "../entry-contracts.js";

/** ADR 0019 target batch; integrated by worker A into the existing single transaction. */
export type CommitMemoryEntriesBatchInput = CommitMaintenanceBatchInput & {
  readonly expectedConversationGeneration: number;
  /** Includes every extra read source, not only the main job conversation. */
  readonly readSet: readonly {
    readonly sourceId: string;
    readonly conversationGeneration: number | null;
  }[];
  /** Immutable selected revision and the current head snapshot observed by its host read. */
  readonly entryReadSet: readonly (MemoryEntryRevisionRef & { readonly expectedHeadRevisionId: string })[];
  readonly mutations: readonly MemoryEntryPublicationMutation[];
  readonly topics: readonly MemoryTopic[];
  readonly sources: readonly MemorySource[];
  /** Host binds proposal entryIds to existing or preallocated new revisionIds before commit. */
  readonly overview: { readonly markdown: string; readonly entries: readonly MemoryEntryRevisionRef[] } | null;
};
export type CommitMemoryEntriesBatchResult =
  | {
      readonly status: "committed";
      readonly summaryRevisionId: string;
      readonly memoryRevisionId: string | null;
      readonly entries: readonly MemoryEntryRevisionRef[];
      readonly jobStatus: "done" | "queued";
    }
  | { readonly status: "discarded"; readonly reason: string };
export type RecordUserEntryEditInput = UpdateMemoryEntryInput & {
  readonly now: number;
  readonly expectedGeneration: number;
};
/** Query port remains a product facade, never an independent persistence adapter. */
export type MemoryEntryRepositoryQueryContract = MemoryEntryQueryPort;

const OWNER_DOC_COLUMNS =
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function contentHashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function createSqliteMemoryDocumentRepository(
  database: SqliteRuntimeDatabase,
  options: { readonly idFactory?: IdFactory } = {},
): MemoryDocumentRepository {
  database.migrate("memory", MEMORY_MIGRATIONS);
  const idFactory = options.idFactory ?? createId;
  const entries = createMemoryEntryStoreOperations(database, idFactory);

  const readOwnerDoc = (revisionId: string): MemoryOwnerDocRow | undefined => {
    const row = database.connection
      .prepare(`SELECT ${OWNER_DOC_COLUMNS} FROM memory_owner_doc WHERE revision_id = ?`)
      .get(revisionId) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseOwnerDocRow(row);
  };

  const readSummary = (revisionId: string): MemorySummaryRow | undefined => {
    const row = database.connection
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM memory_conversation_summary WHERE revision_id = ?`)
      .get(revisionId) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseSummaryRow(row);
  };

  const latestValidOwnerDoc = (ownerKey: string): MemoryOwnerDocRow | undefined => {
    const row = database.connection.prepare(`
      SELECT ${OWNER_DOC_COLUMNS} FROM memory_owner_doc
      WHERE owner_key = ? AND revision = (SELECT MAX(revision) FROM memory_owner_doc WHERE owner_key = ?) AND validity = 'valid'
      ORDER BY revision DESC LIMIT 1
    `).get(ownerKey, ownerKey) as Record<string, SQLInputValue> | undefined;
    return row === undefined ? undefined : parseOwnerDocRow(row);
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

  /** 累计辅助 summary 复制其先前来源；条目和概览不继承整文来源。 */
  const copySummarySources = (fromRevisionId: string, toRevisionId: string, now: number): void => {
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

  const nextOwnerDocRevision = (ownerKey: string): number => {
    const row = database.connection
      .prepare("SELECT MAX(revision) AS max_revision FROM memory_owner_doc WHERE owner_key = ?")
      .get(ownerKey);
    return (z.object({ max_revision: z.number().int().positive().nullable() }).strict().parse(row).max_revision ?? 0) + 1;
  };

  const nextSummaryRevision = (conversationId: string): number => {
    const row = database.connection
      .prepare("SELECT MAX(revision) AS max_revision FROM memory_conversation_summary WHERE conversation_id = ?")
      .get(conversationId);
    return (z.object({ max_revision: z.number().int().positive().nullable() }).strict().parse(row).max_revision ?? 0) + 1;
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
    async hasContent(ownerKey) {
      const scope = ownerKey ?? null;
      const row = database.connection.prepare(`
        SELECT 1 AS present FROM memory_entry WHERE (? IS NULL OR owner_key = ?)
        UNION ALL SELECT 1 AS present FROM memory_conversation_summary WHERE (? IS NULL OR owner_key = ?)
        LIMIT 1
      `).get(scope, scope, scope, scope);
      if (row !== undefined) z.object({ present: z.literal(1) }).strict().parse(row);
      return row !== undefined;
    },

    async getActiveOwnerMemoryHead(ownerKey) {
      return latestValidOwnerDoc(ownerKey);
    },

    async getOwnerMemoryRevision(revisionId) {
      return readOwnerDoc(revisionId);
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

    async listMemoryDocSources(revisionId) {
      const overview = readOwnerDoc(revisionId);
      if (overview === undefined) return [];
      const sources = new Map<string, MemoryDocSourceRow>();
      for (const ref of entries.dependencies(revisionId).entries) {
        const revision = entries.revision(overview.ownerKey, ref);
        if (revision === undefined) throw new MemoryError("memory_store_failure", "Overview dependency is missing.");
        for (const source of entries.sourceViews(overview.ownerKey, revision)) {
          const locator = source.locator;
          sources.set(source.sourceId, { sourceId: source.sourceId, revisionId, depKind: locator.kind,
            conversationId: locator.kind === "conversation_range" ? locator.conversationId : null,
            fromOrdinal: locator.kind === "conversation_range" ? locator.fromOrdinal : null,
            toOrdinal: locator.kind === "conversation_range" ? locator.toOrdinal : null,
            sourceRevision: locator.kind === "conversation_range" ? locator.sourceRevision : 0,
            requestId: locator.kind === "user_edit" ? locator.requestId : null, createdAt: source.createdAt });
        }
      }
      return [...sources.values()];
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

    async getOwnerViewStats(ownerKey) {
      const row = database.connection
        .prepare(`
          SELECT COUNT(*) AS summaryCount, MAX(updated_at) AS lastMaintenanceAt
          FROM memory_conversation_summary WHERE owner_key = ? AND validity = 'valid'
        `)
        .get(ownerKey);
      return z.object({ summaryCount: z.number().int().nonnegative(), lastMaintenanceAt: z.number().int().nonnegative().nullable() }).strict().parse(row);
    },

    async commitMaintenanceBatch(input) {
      try { return database.transaction(() => {
        const globalLifecycle = readLifecycleRow("global");
        if (globalLifecycle !== undefined && globalLifecycle.fenceState !== "none") return { status: "discarded" as const, reason: "admission_off" };
        // 1. job 必须仍处于本批占用的 running 且 claim_token 自洽（BEGIN IMMEDIATE 下无并发写）。
        const rawJob = database.connection.prepare("SELECT * FROM memory_job WHERE job_id = ?").get(input.jobId);
        const jobRow = rawJob === undefined ? undefined : parseJobRow(rawJob);
        if (jobRow === undefined || jobRow.status !== "running" || jobRow.conversationId !== input.conversationId ||
            jobRow.ownerKey !== input.ownerKey || jobRow.claimToken !== input.claimToken) {
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

        if (jobRow.generation !== input.expectedGeneration || jobRow.policyRevision !== input.expectedPolicyRevision ||
            (readLifecycleRow(`conversation:${input.conversationId}`)?.generation ?? 0) !== input.expectedConversationGeneration) {
          return { status: "discarded" as const, reason: "admission_changed" };
        }
        const sourceConflict = entries.validateReads(input, id => {
          const lifecycle = readLifecycleRow(`conversation:${id}`);
          return { generation: lifecycle?.generation ?? 0, fenced: lifecycle !== undefined && lifecycle.fenceState !== "none" };
        }, id => readProgress(id)?.excludedThroughOrdinal ?? 0);
        if (sourceConflict !== undefined) return { status: "discarded" as const, reason: sourceConflict };
        if (input.batchRange.fromOrdinal > input.batchRange.toOrdinal || input.batchRange.toOrdinal > jobRow.targetThroughOrdinal ||
            input.advanceProgressTo.ordinal > input.batchRange.toOrdinal || input.summary.coveredThroughOrdinal > input.batchRange.toOrdinal) {
          return { status: "discarded" as const, reason: "range_invalid" };
        }
        for (const mutation of input.mutations) {
          const current = entries.entry(input.ownerKey, mutation.entryId);
          if ((current?.headRevisionId ?? null) !== mutation.expectedRevisionId) return { status: "discarded" as const, reason: "entry_head_superseded" };
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
        const currentHead = latestValidOwnerDoc(input.ownerKey);
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
          copySummarySources(currentSummary.revisionId, summaryRevisionId, now);
        }
        insertConversationRangeSource({
          revisionId: summaryRevisionId,
          conversationId: input.conversationId,
          fromOrdinal: input.batchRange.fromOrdinal,
          toOrdinal: input.batchRange.toOrdinal,
          sourceRevision: input.batchRange.sourceRevision,
          now,
        });

        // Entry revisions, provenance, overview and auxiliaries share this publication.
        for (const source of input.sources) entries.insertSource(source);
        entries.insertTopics(input.ownerKey, input.topics);
        const publishedEntries = entries.publishMutations(input.ownerKey, admission.generation, input.mutations, "model", now);
        let memoryRevisionId: string | null = null;
        if (input.overview !== null) {
          memoryRevisionId = idFactory("memdoc");
          database.connection.prepare(`INSERT INTO memory_owner_doc(
            revision_id, owner_key, revision, origin, markdown, validity, generation, content_hash, updated_at
          ) VALUES (?, ?, ?, 'model', ?, 'valid', ?, ?, ?)`).run(memoryRevisionId, input.ownerKey,
            nextOwnerDocRevision(input.ownerKey), input.overview.markdown, admission.generation, contentHashOf(input.overview.markdown), now);
          entries.bindOverview(input.ownerKey, memoryRevisionId, input.overview.entries);
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
        const requested = jobRow.requestedThroughOrdinal;
        const target = jobRow.targetThroughOrdinal;
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

        return { status: "committed" as const, summaryRevisionId, memoryRevisionId, entries: publishedEntries, jobStatus };
      }); } catch (error) {
        if (error instanceof MemoryError && ["memory_revision_stale", "memory_entry_not_found", "memory_source_unavailable", "memory_invalid_edit", "memory_invalid_owner"].includes(error.code)) {
          return { status: "discarded", reason: error.code };
        }
        if (error instanceof z.ZodError) return { status: "discarded", reason: "invalid_mutation" };
        throw error;
      }
    },

    async recordUserMemoryEdit(input) {
      return database.transaction(() => {
        const ownerKey = memoryOwnerKey(input.owner);
        const lifecycle = readLifecycleRow(ownerKey);
        const globalLifecycle = readLifecycleRow("global");
        if (globalLifecycle !== undefined && globalLifecycle.fenceState !== "none") throw new MemoryError("memory_generation_fenced", "Global memory is fenced.");
        if ((lifecycle?.generation ?? 0) !== input.expectedGeneration || (lifecycle !== undefined && lifecycle.fenceState !== "none")) {
          throw new MemoryError("memory_generation_fenced", "Owner generation changed or is fenced.");
        }
        const payloadHash = contentHashOf(canonicalJson({ owner: input.owner, requestId: input.requestId, edit: input.edit }));
        const previous = entries.readRequest(ownerKey, input.requestId);
        if (previous !== undefined) {
          if (previous.payload_hash !== payloadHash) throw new MemoryError("memory_request_conflict", "Request ID was reused with a different edit.");
          return entries.parseEditResult(previous.result_json);
        }
        const sourceId = idFactory("memsrc");
        entries.insertSource({ sourceId, owner: input.owner, locator: { kind: "user_edit", requestId: input.requestId }, lifecycle: "present", branch: "selected", createdAt: input.now });
        const mutation = entries.userMutation(input, sourceId);
        entries.publishMutations(ownerKey, input.expectedGeneration, [mutation], "user_edit", input.now);
        const overview = entries.overviewForUser(ownerKey);
        const overviewRevisionId = idFactory("memdoc");
        database.connection.prepare(`INSERT INTO memory_owner_doc(
          revision_id, owner_key, revision, origin, markdown, validity, generation, content_hash, updated_at
        ) VALUES (?, ?, ?, 'user_edit', ?, 'valid', ?, ?, ?)`).run(overviewRevisionId, ownerKey,
          nextOwnerDocRevision(ownerKey), overview.markdown, input.expectedGeneration, contentHashOf(overview.markdown), input.now);
        entries.bindOverview(ownerKey, overviewRevisionId, overview.entries);
        const revision = entries.revision(ownerKey, { entryId: mutation.entryId, revisionId: mutation.revisionId })!;
        const result = { entryId: mutation.entryId, revisionId: mutation.revisionId, revision: revision.revision, overviewRevisionId };
        database.connection.prepare("INSERT INTO memory_edit_request VALUES (?, ?, ?, ?)").run(ownerKey, input.requestId, payloadHash, JSON.stringify(result));
        return result;
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

    async getSupplyableMemoryRevision(input) {
      return database.transaction(() => {
        const globalLifecycle = readLifecycleRow("global");
        if (globalLifecycle !== undefined && globalLifecycle.fenceState !== "none") return undefined;
        const row = readOwnerDoc(input.revisionId);
        const ownerLifecycle = readLifecycleRow(input.ownerKey);
        if (row === undefined || row.ownerKey !== input.ownerKey || row.validity !== "valid" ||
            row.generation !== input.generation || (ownerLifecycle?.generation ?? 0) !== input.generation) return undefined;
        const admission = resolveAdmissionFromPolicy({ owner: memoryOwnerFromKey(input.ownerKey), conversationId: "__memory_background__",
          policyRows: readPolicyRows(), ownerLifecycle, conversationLifecycle: undefined });
        if (admission.effective !== "active") return undefined;
        const sources = new Map<string, MemoryOverviewSourceState>();
        for (const ref of entries.dependencies(row.revisionId).entries) {
          const revision = entries.revision(input.ownerKey, ref);
          if (revision === undefined || !entries.supported(input.ownerKey, revision)) return undefined;
          for (const source of entries.sourceViews(input.ownerKey, revision)) sources.set(source.sourceId, { sourceId: source.sourceId, readback: source.readback });
        }
        return { ...row, sourceStates: [...sources.values()] };
      });
    },

    async getEntry(input) { return entries.entry(input.ownerKey, input.entryId); },
    async getEntryRevision(input) { return database.transaction(() => entries.view(input.ownerKey, input)); },
    async listOverviewDependencies(revisionId) { return entries.dependencies(revisionId); },
    async listTopics(ownerKey) {
      return database.connection.prepare("SELECT * FROM memory_topic WHERE owner_key = ? ORDER BY topic_id").all(ownerKey).map(parseMemoryTopicRow);
    },
    async listEntries(input) {
      return database.transaction(() => {
        const refs = entries.refs(database.connection.prepare("SELECT entry_id, head_revision_id AS revision_id FROM memory_entry WHERE owner_key = ? ORDER BY created_at DESC, entry_id").all(input.ownerKey));
        const values = refs.flatMap(ref => { const value = entries.view(input.ownerKey, ref); return value === undefined ? [] : [value]; });
        const page = entries.page(`entries:${input.ownerKey}`, values, input.limit, input.cursor);
        return { entries: page.items, nextCursor: page.nextCursor };
      });
    },
    async listEntryRevisions(input) {
      const refs = entries.refs(database.connection.prepare("SELECT entry_id, revision_id FROM memory_entry_revision WHERE owner_key = ? AND entry_id = ? ORDER BY revision DESC").all(input.ownerKey, input.entryId));
      const page = entries.page(`revisions:${input.ownerKey}:${input.entryId}`, refs, input.limit, input.cursor);
      return { revisions: page.items, nextCursor: page.nextCursor };
    },
    async searchEntryCandidates(input) {
      if (input.match.trim() === "" || input.limit <= 0) return { candidates: [], nextCursor: null };
      return database.transaction(() => {
        const refs = entries.refs(database.connection.prepare(`
          SELECT r.entry_id, r.revision_id FROM memory_entry_fts f
          JOIN memory_entry_revision r ON r.revision_id = f.revision_id
          JOIN memory_entry e ON e.entry_id = r.entry_id AND e.owner_key = r.owner_key
          WHERE memory_entry_fts MATCH ? AND r.owner_key = ?
            AND (? = 1 OR (r.revision_id = e.head_revision_id AND r.supply_state = 'eligible' AND r.kind <> 'withdrawal'
              AND NOT EXISTS (SELECT 1 FROM memory_entry_revision_source rs JOIN memory_source s ON s.source_id = rs.source_id
                WHERE rs.revision_id = r.revision_id AND s.branch = 'superseded')))
            AND (? IS NULL OR EXISTS (SELECT 1 FROM memory_entry_revision_topic t WHERE t.revision_id = r.revision_id AND t.topic_id = ?))
            AND (? IS NULL OR EXISTS (SELECT 1 FROM memory_entry_revision_source rs JOIN memory_source s ON s.source_id = rs.source_id
              WHERE rs.revision_id = r.revision_id AND json_extract(s.locator_json, '$.conversationId') = ?))
          ORDER BY bm25(memory_entry_fts), r.revision_id
        `).all(input.match, input.ownerKey, input.includeHistory ? 1 : 0, input.topicId ?? null, input.topicId ?? null, input.conversationId ?? null, input.conversationId ?? null));
        const page = entries.page(canonicalJson({ owner: input.ownerKey, match: input.match, topic: input.topicId ?? null,
          conversation: input.conversationId ?? null, history: input.includeHistory }), refs, input.limit, input.cursor);
        return { candidates: page.items, nextCursor: page.nextCursor };
      });
    },
    async resolveEntries(input) {
      return database.transaction(() => {
        const globalLifecycle = readLifecycleRow("global");
        if (globalLifecycle !== undefined && globalLifecycle.fenceState !== "none") return undefined;
        const admission = resolveAdmissionFromPolicy({ owner: memoryOwnerFromKey(input.ownerKey), conversationId: "__memory_query__",
          policyRows: readPolicyRows(), ownerLifecycle: readLifecycleRow(input.ownerKey), conversationLifecycle: undefined });
        if (admission.effective !== "active" || admission.generation !== input.expectedGeneration || admission.policyRevision !== input.expectedPolicyRevision) return undefined;
        return input.entries.flatMap(ref => {
          const value = entries.view(input.ownerKey, ref);
          return value === undefined || value.entry.generation !== input.expectedGeneration ? [] : [value];
        });
      });
    },

    async listTranscriptOrdinals(input) {
      const rows = database.connection.prepare(
        "SELECT DISTINCT ordinal FROM memory_transcript_fts WHERE owner_key = ? AND conversation_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?",
      ).all(input.ownerKey, input.conversationId, input.fromOrdinal, input.limit);
      return rows.map(row => z.object({ ordinal: z.number().int().nonnegative() }).strict().parse(row).ordinal);
    },

    async indexTranscriptRange(input) {
      return database.transaction(() => {
        const globalLifecycle = readLifecycleRow("global");
        if (globalLifecycle !== undefined && globalLifecycle.fenceState !== "none") return undefined;
        const conversationLifecycle = readLifecycleRow(`conversation:${input.conversationId}`);
        const admission = resolveAdmissionFromPolicy({
          owner: memoryOwnerFromKey(input.ownerKey), conversationId: input.conversationId,
          policyRows: readPolicyRows(), ownerLifecycle: readLifecycleRow(input.ownerKey), conversationLifecycle,
        });
        if (!capturePublicationMatches(admission, conversationLifecycle?.generation ?? 0, input.publication)) return undefined;
        const excludedThrough = readProgress(input.conversationId)?.excludedThroughOrdinal ?? 0;
        let maxOrdinal = -1;
        let lastRevision = 0;
        for (const entry of input.entries) {
          if (entry.ordinal <= excludedThrough) continue;
          const oldIdentity = database.connection.prepare("SELECT owner_key, source_revision FROM memory_transcript_identity WHERE conversation_id = ? AND ordinal = ?").get(input.conversationId, entry.ordinal);
          if (oldIdentity !== undefined && z.object({ owner_key: z.string(), source_revision: z.number().int().nonnegative() }).strict().parse(oldIdentity).owner_key !== input.ownerKey) {
            throw new MemoryError("memory_invalid_owner", "Transcript identity owner changed.");
          }
          database.connection.prepare(`INSERT INTO memory_transcript_identity VALUES (?, ?, ?, ?)
            ON CONFLICT(conversation_id, ordinal) DO UPDATE SET source_revision = excluded.source_revision
          `).run(input.conversationId, entry.ordinal, input.ownerKey, entry.sourceRevision);

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
      // R12：会话范围条件在 LIMIT 之前过滤，不能先取全 owner top-k 再展示过滤。
      const hits = database.connection.prepare(`
        SELECT revision_id, bm25(memory_summary_fts) AS bm25_score
        FROM memory_summary_fts
        WHERE memory_summary_fts MATCH ? AND owner_key = ? AND validity = 'valid'
          AND (? IS NULL OR conversation_id = ?)
        ORDER BY bm25(memory_summary_fts)
        LIMIT ?
      `).all(input.match, input.ownerKey, input.conversationId ?? null, input.conversationId ?? null, ftsLimit)
        .map(row => z.object({ revision_id: z.string().min(1), bm25_score: z.number().finite() }).strict().parse(row));
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
      `).all(input.match, input.ownerKey, input.conversationId ?? null, input.conversationId ?? null, input.limit)
        .map(row => z.object({ conversation_id: z.string().min(1), ordinal: z.number().int().nonnegative(), bm25_score: z.number().finite() }).strict().parse(row));
      return hits.map((hit) => ({
        conversationId: String(hit.conversation_id),
        ordinal: Number(hit.ordinal),
        bm25: Number(hit.bm25_score),
      }));
    },

    async markConversationSourcesDeleted(conversationId) {
      database.transaction(() => {
        database.connection.prepare("UPDATE memory_source SET lifecycle = 'deleted' WHERE json_extract(locator_json, '$.conversationId') = ?").run(conversationId);
      });
    },
    async supersedeConversationSources(input) {
      database.transaction(() => {
        database.connection.prepare(`UPDATE memory_source SET branch = 'superseded'
          WHERE owner_key = ? AND json_extract(locator_json, '$.conversationId') = ?
            AND (? IS NULL OR json_extract(locator_json, '$.toOrdinal') > ?)
        `).run(memoryOwnerKey(input.owner), input.conversationId, input.retainedThroughOrdinal, input.retainedThroughOrdinal);
      });
    },
    async purgeConversationAuxiliaries(conversationId, options = {}) {
      database.transaction(() => {
        const summaries = database.connection.prepare("SELECT revision_id FROM memory_conversation_summary WHERE conversation_id = ?").all(conversationId)
          .map(value => z.object({ revision_id: z.string() }).strict().parse(value));
        for (const row of summaries) {
          database.connection.prepare("DELETE FROM memory_summary_fts WHERE revision_id = ?").run(row.revision_id);
          database.connection.prepare("DELETE FROM memory_doc_source WHERE revision_id = ?").run(row.revision_id);
        }
        database.connection.prepare("DELETE FROM memory_conversation_summary WHERE conversation_id = ?").run(conversationId);
        database.connection.prepare("DELETE FROM memory_transcript_fts WHERE conversation_id = ?").run(conversationId);
        database.connection.prepare("DELETE FROM memory_transcript_identity WHERE conversation_id = ?").run(conversationId);
        database.connection.prepare("DELETE FROM memory_transcript_coverage WHERE conversation_id = ?").run(conversationId);
        if (options.preserveExclusions === true) {
          database.connection.prepare("UPDATE memory_capture_progress SET processed_through_ordinal = 0, processed_fragment_ordinal = NULL, processed_fragment_end = NULL, source_fingerprint = 'branch-cleared' WHERE conversation_id = ?").run(conversationId);
        } else {
          database.connection.prepare("DELETE FROM memory_capture_progress WHERE conversation_id = ?").run(conversationId);
        }
        database.connection.prepare("DELETE FROM memory_job WHERE conversation_id = ?").run(conversationId);
      });
    },

    async purgeOwner(ownerKey, options = { preserveExclusions: true }) {
      return database.transaction(() => {
        database.connection.prepare("DELETE FROM memory_entry_fts WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_overview_dependency WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_entry_revision_related WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_entry WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_topic WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_source WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_edit_request WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_transcript_identity WHERE owner_key = ?").run(ownerKey);
        const docs = database.connection
          .prepare("SELECT revision_id FROM memory_owner_doc WHERE owner_key = ?")
          .all(ownerKey).map(row => z.object({ revision_id: z.string().min(1) }).strict().parse(row));
        for (const row of docs) {
          database.connection.prepare("DELETE FROM memory_doc_source WHERE revision_id = ?").run(row.revision_id);
        }
        database.connection.prepare("DELETE FROM memory_owner_doc WHERE owner_key = ?").run(ownerKey);
        const summaries = database.connection
          .prepare("SELECT revision_id FROM memory_conversation_summary WHERE owner_key = ?")
          .all(ownerKey).map(row => z.object({ revision_id: z.string().min(1) }).strict().parse(row));
        for (const row of summaries) {
          database.connection.prepare("DELETE FROM memory_summary_fts WHERE revision_id = ?").run(row.revision_id);
          // R10：总结来源行没有外键级联，必须与总结行同事务清理。
          database.connection.prepare("DELETE FROM memory_doc_source WHERE revision_id = ?").run(row.revision_id);
        }
        database.connection.prepare("DELETE FROM memory_conversation_summary WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_transcript_fts WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_transcript_coverage WHERE owner_key = ?").run(ownerKey);
        database.connection.prepare("DELETE FROM memory_job WHERE owner_key = ?").run(ownerKey);
        if (options.preserveExclusions === true) {
          database.connection.prepare("UPDATE memory_capture_progress SET processed_through_ordinal = 0, processed_fragment_ordinal = NULL, processed_fragment_end = NULL, source_fingerprint = 'cleared' WHERE owner_key = ?").run(ownerKey);
        } else {
          database.connection.prepare("DELETE FROM memory_capture_progress WHERE owner_key = ?").run(ownerKey);
        }
      });
    },

    async purgeAll(options = { preserveExclusions: true }) {
      return database.transaction(() => {
        database.connection.prepare("DELETE FROM memory_entry_fts").run();
        database.connection.prepare("DELETE FROM memory_overview_dependency").run();
        database.connection.prepare("DELETE FROM memory_entry_revision_related").run();
        database.connection.prepare("DELETE FROM memory_entry").run();
        database.connection.prepare("DELETE FROM memory_topic").run();
        database.connection.prepare("DELETE FROM memory_source").run();
        database.connection.prepare("DELETE FROM memory_edit_request").run();
        database.connection.prepare("DELETE FROM memory_transcript_identity").run();
        database.connection.prepare("DELETE FROM memory_summary_fts").run();
        database.connection.prepare("DELETE FROM memory_transcript_fts").run();
        database.connection.prepare("DELETE FROM memory_transcript_coverage").run();
        database.connection.prepare("DELETE FROM memory_doc_source").run();
        database.connection.prepare("DELETE FROM memory_conversation_summary").run();
        database.connection.prepare("DELETE FROM memory_owner_doc").run();
        database.connection.prepare("DELETE FROM memory_job").run();
        if (options.preserveExclusions === true) {
          database.connection.prepare("UPDATE memory_capture_progress SET processed_through_ordinal = 0, processed_fragment_ordinal = NULL, processed_fragment_end = NULL, source_fingerprint = 'cleared'").run();
        } else {
          database.connection.prepare("DELETE FROM memory_capture_progress").run();
        }
      });
    },
  };
}
