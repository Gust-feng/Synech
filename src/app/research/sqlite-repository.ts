import type { SQLInputValue } from "node:sqlite";

import type { SqliteRuntimeDatabase } from "../../adapters/runtime-storage/index.js";
import {
  ResearchError,
  assertConflictSidesBalanced,
  assertQuestionOrigin,
  canTransitionClaimStatus,
  canTransitionQuestionStatus,
  type ResearchRepository,
  type ResearchActionEvent,
  type ResearchActionEventDraft,
  type ResearchBrief,
  type ResearchBriefDraft,
  type ResearchCeilingKind,
  type ResearchCitationCheck,
  type ResearchCitationCheckDraft,
  type ResearchClaim,
  type ResearchClaimDraft,
  type ResearchClaimRead,
  type ResearchClaimUpdate,
  type ResearchCompletion,
  type ResearchConflict,
  type ResearchConflictDraft,
  type ResearchCoverageRound,
  type ResearchEvidenceItem,
  type ResearchEvidenceItemDraft,
  type ResearchEvidenceItemRead,
  type ResearchEvidenceStatus,
  type ResearchGap,
  type ResearchGapDraft,
  type ResearchLedger,
  type ResearchObservationBatch,
  type ResearchObservationResult,
  type ResearchQuestionEdge,
  type ResearchQuestionEdgeDraft,
  type ResearchQuestionNode,
  type ResearchQuestionNodeDraft,
  type ResearchQuestionNodeRead,
  type ResearchQuestionUpdate,
  type ResearchQueryRecord,
  type ResearchReport,
  type ResearchReportSpan,
  type ResearchReportSpanDraft,
  type ResearchScopeApproval,
  type ResearchSourceAccessLevel,
  type ResearchSourceEntry,
  type ResearchSourceEntryDraft,
  type ResearchSourceProvenanceStatus,
  type ResearchSource,
  type ResearchStage,
  type ResearchTask,
  type ResearchTaskStatus,
  type ResearchTaskSummary,
  type ResearchUsage,
} from "./contracts.js";
import {
  parseResearchActionEvent,
  parseResearchActionEventDraft,
  parseResearchBrief,
  parseResearchBriefDraft,
  parseResearchCheckpointSummaryPayload,
  parseResearchCitationCheck,
  parseResearchCitationCheckDraft,
  parseResearchClaim,
  parseResearchClaimDraft,
  parseResearchClaimRead,
  parseResearchConflict,
  parseResearchConflictDraft,
  parseResearchCoverageRound,
  parseResearchEvidenceItem,
  parseResearchEvidenceItemDraft,
  parseResearchEvidenceItemRead,
  parseResearchGap,
  parseResearchGapDraft,
  parseResearchObservationBatch,
  parseResearchObservationResult,
  parseResearchPlan,
  parseResearchQuestionEdge,
  parseResearchQuestionEdgeDraft,
  parseResearchQuestionNode,
  parseResearchQuestionNodeDraft,
  parseResearchQuestionNodeRead,
  parseResearchQuery,
  parseResearchReport,
  parseResearchReportSpan,
  parseResearchReportSpanDraft,
  parseResearchScopeApproval,
  parseResearchSource,
  parseResearchSourceEntry,
  parseResearchSourceEntryDraft,
  parseResearchSourceFetchPayload,
  parseResearchTask,
  parseResearchTaskSummary,
  parseResearchUsage,
} from "./persistence-schema.js";
import { canonicalizeUrl } from "./canonical-url.js";

/**
 * 研究事实的 SQLite 持久化。
 *
 * 六条不变量：
 * 1. 队列状态是唯一事实源——worker 的认领是 CAS（queued→running），
 *    重启后 running 残留只能被标记 interrupted，绝不自动重放。
 * 2. 报告（Report+ReportSpan）与终态同事务写入；已进入终态的任务不接受
 *    再次写入（重复提交是空操作）。
 * 3. 旧流水线来源编号由本层分配：按 canonical_url 去重后从现有最大值递增，跨轮稳定。
 * 4. 账本 ID 由框架分配、单调递增、不回收；模型输入不携带 ID（草稿 strict 校验）。
 * 5. access_level 只能由框架抓取路径（markSourceAccess）写入；证据快照写入时派生。
 * 6. Conflict 必须双边各绑定 ≥2 个不同来源的 Evidence；新增 Question 必须携带 origin。
 *
 * 结构校验规则只有一份实现（contracts.ts 的 assert* / canTransition*）：Feature 在
 * 串行队列内预检，本层在事务内复验，两边调用同一函数。
 */

/**
 * 新建库定义：research owner 的完整目标 schema（ADR 0001 §2.1 / 设计草案 §6）。
 *
 * 开发态纪律（负责人 2026-09-21 指示）：不追加 migration 版本、不写旧数据迁移、
 * 不为旧开发库保留兼容路径——目标 schema 直接作为新建库定义，fresh Product Home
 * 即目标形态。旧开发库与新 schema 不兼容是既定语义：启动不得静默删除重建，
 * 用户显式 reset。
 *
 * 与旧流水线存储的关系：plan/coverage JSON 列与 research_source、research_query 是
 * 已退役固定流水线的存储。DDL 冻结保留（不为退役改 research/1 schema 与基线），但
 * 写入路径已随 turn 驱动移除：新写入只进账本段表，旧表只剩只读残留
 * （detail/DTO 仍读它们，v1.0.1 升级 fixture 仍清空它们）。
 */
const MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE research_task (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled')),
      stage TEXT CHECK(stage IS NULL OR stage IN ('planning', 'searching', 'reading', 'analyzing', 'writing')),
      plan_json TEXT,
      coverage_json TEXT NOT NULL DEFAULT '[]',
      report_title TEXT,
      report_markdown TEXT,
      error_code TEXT,
      error_message TEXT,
      usage_json TEXT NOT NULL,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      completion TEXT CHECK(completion IS NULL OR completion IN ('normal', 'forced', 'incomplete')),
      reason TEXT,
      ceiling_hit TEXT,
      scope_approval_json TEXT,
      brief_id TEXT
    ) STRICT;
    CREATE INDEX research_task_status_created_idx ON research_task(status, created_at DESC, id DESC);

    CREATE TABLE research_source (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal > 0),
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      snippet TEXT NOT NULL,
      content_text TEXT,
      content_status TEXT NOT NULL CHECK(content_status IN ('pending', 'ready', 'failed', 'skipped')),
      published_at TEXT,
      retrieved_at INTEGER NOT NULL,
      UNIQUE(task_id, canonical_url),
      UNIQUE(task_id, ordinal)
    ) STRICT;
    CREATE INDEX research_source_task_idx ON research_source(task_id, ordinal);

    CREATE TABLE research_query (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      round INTEGER NOT NULL CHECK(round > 0),
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed')),
      result_count INTEGER NOT NULL CHECK(result_count >= 0),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX research_query_task_idx ON research_query(task_id, created_at, id);

    CREATE TABLE research_brief (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      objective TEXT NOT NULL,
      inclusions_json TEXT NOT NULL,
      exclusions_json TEXT NOT NULL,
      audience TEXT NOT NULL,
      answer_criteria TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE research_question_node (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      parent_id TEXT,
      text TEXT NOT NULL,
      boundary_note TEXT NOT NULL,
      priority TEXT NOT NULL CHECK(priority IN ('critical', 'normal', 'optional')),
      status TEXT NOT NULL CHECK(status IN ('open', 'investigating', 'covered', 'disputed', 'blocked', 'abandoned')),
      origin_kind TEXT NOT NULL CHECK(origin_kind IN ('brief', 'question', 'evidence')),
      origin_ref_id TEXT,
      origin_scope_basis TEXT NOT NULL,
      reopened_count INTEGER NOT NULL DEFAULT 0 CHECK(reopened_count >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX research_question_node_task_idx ON research_question_node(task_id, created_at, id);

    CREATE TABLE research_question_edge (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      from_question_id TEXT NOT NULL,
      to_question_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('split', 'merge', 'related')),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX research_question_edge_task_idx ON research_question_edge(task_id, created_at, id);

    CREATE TABLE research_source_entry (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      snippet TEXT NOT NULL,
      access_level TEXT NOT NULL CHECK(access_level IN ('snippet', 'partial', 'fulltext', 'unavailable')),
      content_hash TEXT,
      provenance_status TEXT NOT NULL CHECK(provenance_status IN ('unchecked', 'confirmed', 'changed', 'unavailable')),
      created_at INTEGER NOT NULL,
      UNIQUE(task_id, canonical_url)
    ) STRICT;
    CREATE INDEX research_source_entry_task_idx ON research_source_entry(task_id, created_at, id);

    CREATE TABLE research_evidence_item (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      locator TEXT NOT NULL,
      extracted_claim TEXT NOT NULL,
      stance TEXT NOT NULL CHECK(stance IN ('supports', 'contradicts', 'qualifies')),
      access_level_snapshot TEXT NOT NULL CHECK(access_level_snapshot IN ('snippet', 'partial', 'fulltext', 'unavailable')),
      created_by_model_call TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX research_evidence_item_task_idx ON research_evidence_item(task_id, created_at, id);

    CREATE TABLE research_evidence_question_edge (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(task_id, evidence_id, question_id)
    ) STRICT;
    CREATE INDEX research_evidence_question_edge_task_idx
      ON research_evidence_question_edge(task_id, evidence_id, question_id);

    CREATE TABLE research_claim (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      text TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('sourced', 'synthesis', 'inference')),
      status TEXT NOT NULL CHECK(status IN ('provisional', 'supported', 'disputed', 'unsupported', 'withdrawn')),
      scope TEXT,
      qualifier TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX research_claim_task_idx ON research_claim(task_id, created_at, id);

    CREATE TABLE research_claim_evidence_edge (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(task_id, claim_id, evidence_id)
    ) STRICT;
    CREATE INDEX research_claim_evidence_edge_task_idx
      ON research_claim_evidence_edge(task_id, claim_id, evidence_id);

    CREATE TABLE research_gap (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      description TEXT NOT NULL,
      importance TEXT NOT NULL CHECK(importance IN ('critical', 'material', 'minor')),
      origin TEXT NOT NULL CHECK(origin IN (
        'insufficient_evidence', 'conflicting_evidence', 'source_unavailable',
        'search_exhausted', 'unclear_scope', 'possible_counterevidence', 'out_of_scope_lead'
      )),
      attempted_search_ids_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('open', 'mitigated', 'unresolved', 'impossible')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX research_gap_task_idx ON research_gap(task_id, created_at, id);

    CREATE TABLE research_conflict (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      question_ids_json TEXT NOT NULL,
      claim_a_id TEXT NOT NULL,
      claim_b_id TEXT NOT NULL,
      evidence_a_ids_json TEXT NOT NULL,
      evidence_b_ids_json TEXT NOT NULL,
      nature TEXT NOT NULL CHECK(nature IN ('factual', 'definition', 'timeframe', 'methodology', 'interpretation')),
      status TEXT NOT NULL CHECK(status IN ('unresolved', 'reconciled', 'scoped')),
      resolution_note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX research_conflict_task_idx ON research_conflict(task_id, created_at, id);

    CREATE TABLE research_report (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE research_report_span (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      report_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal > 0),
      text TEXT NOT NULL,
      claim_ids_json TEXT NOT NULL,
      attribution_type TEXT NOT NULL CHECK(attribution_type IN ('source_statement', 'synthesis', 'inference')),
      citation_source_ids_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(report_id, ordinal)
    ) STRICT;
    CREATE INDEX research_report_span_task_idx ON research_report_span(task_id, ordinal);

    CREATE TABLE research_citation_check (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      report_span_id TEXT NOT NULL,
      claim_id TEXT,
      verdict TEXT NOT NULL CHECK(verdict IN (
        'supports', 'partially_supports', 'contradicts', 'does_not_support', 'insufficient_context'
      )),
      sampled INTEGER NOT NULL CHECK(sampled IN (0, 1)),
      verifier_input TEXT,
      verifier_output TEXT,
      verifier_model TEXT,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX research_citation_check_task_idx ON research_citation_check(task_id, created_at, id);

    CREATE TABLE research_action_event (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN (
        'model_content', 'tool_call', 'tool_result', 'ledger_change',
        'resource_state_change', 'source_fetch', 'checkpoint_summary'
      )),
      question_refs_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX research_action_event_task_idx ON research_action_event(task_id, created_at, id);
  `,
}] as const;

const TASK_COLUMNS = `id, question, status, stage, plan_json AS planJson, coverage_json AS coverageJson,
  report_title AS reportTitle, report_markdown AS reportMarkdown, error_code AS errorCode,
  error_message AS errorMessage, usage_json AS usageJson, created_at AS createdAt,
  started_at AS startedAt, ended_at AS endedAt, completion, reason, ceiling_hit AS ceilingHit,
  scope_approval_json AS scopeApprovalJson, brief_id AS briefId`;

/** 账本 ID：`${taskId}:<prefix><n>`，n 在任务内按实体单调递增、不回收。 */
function allocateIds(taskId: string, prefix: string, existing: readonly string[], count: number): string[] {
  let max = 0;
  for (const id of existing) {
    const matched = /^\d+$/u.exec(id.slice(taskId.length + prefix.length + 1));
    if (matched !== null) max = Math.max(max, Number(matched[0]));
  }
  return Array.from({ length: count }, (_, index) => `${taskId}:${prefix}${max + index + 1}`);
}

function existingIds(database: SqliteRuntimeDatabase, table: string, taskId: string): string[] {
  const rows = database.connection.prepare(`SELECT id FROM ${table} WHERE task_id = ?`).all(taskId) as Record<string, SQLInputValue>[];
  return rows.map((row) => String(row.id));
}

function parseJsonArray(raw: string, label: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new ResearchError("research_repository_failure", `Stored research ${label} is not a string array.`);
  }
  return parsed as string[];
}

/**
 * 写入草稿的运行时校验：模型输入以 JSON 越界，strict schema 拒绝夹带字段
 * （id、access_level 等框架字段）。校验失败是输入问题（400 语义），
 * 不是存储问题——与读取行的损坏（research_repository_failure）区分开。
 */
function parseDraft<T>(parse: (value: unknown) => T, value: unknown, label: string): T {
  try {
    return parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ResearchError("research_invalid_input", `研究账本输入不合规（${label}）：${detail}`, { cause: error });
  }
}

/**
 * 后置实体（SourceFetch / CheckpointSummary，ADR §2.1）的版本化 JSON 形状：
 * 以动作事件持久化，写入时按 kind 校验负载，不让消费方将来收到垃圾 JSON。
 * 其余 kind 的负载只校验版本信封，专属形状随观察面落地时补充。
 */
const ACTION_EVENT_PAYLOAD_PARSERS: Partial<
  Record<string, (value: unknown) => unknown>
> = {
  source_fetch: parseResearchSourceFetchPayload,
  checkpoint_summary: parseResearchCheckpointSummaryPayload,
};

/**
 * CheckpointSummary 的实体回指必须落在任务内。
 *
 * checkpoint 是模型生成的工作记忆，不是账本的第二事实源：回指断了就再也回不到原
 * 实体，压缩后的上下文会把同一批主张/缺口重新发现一遍。规则与 questionRefs 同一
 * 层（port 边界结构校验），不依赖调用方自觉。
 */
function assertCheckpointBackReferences(
  database: SqliteRuntimeDatabase,
  taskId: string,
  drafts: readonly ResearchActionEventDraft[],
): void {
  const checkpoints = drafts.filter((draft) => draft.kind === "checkpoint_summary");
  if (checkpoints.length === 0) return;
  const knownClaimIds = new Set(existingIds(database, "research_claim", taskId));
  const knownGapIds = new Set(existingIds(database, "research_gap", taskId));
  const knownConflictIds = new Set(existingIds(database, "research_conflict", taskId));
  const knownSourceIds = new Set(existingIds(database, "research_source_entry", taskId));
  const knownCheckpointIds = new Set(
    database.connection.prepare(
      "SELECT id FROM research_action_event WHERE task_id = ? AND kind = 'checkpoint_summary'",
    ).all(taskId).map((row) => String((row as Record<string, SQLInputValue>).id)),
  );
  for (const draft of checkpoints) {
    const payload = parseResearchCheckpointSummaryPayload(draft.payload);
    const references: readonly (readonly [string, ReadonlySet<string>, readonly string[]])[] = [
      ["主张", knownClaimIds, payload.retainedClaimIds],
      ["缺口", knownGapIds, payload.retainedGapIds],
      ["分歧", knownConflictIds, payload.retainedConflictIds],
      ["来源", knownSourceIds, payload.sourceIds],
    ];
    for (const [label, known, values] of references) {
      for (const value of values) {
        if (!known.has(value)) {
          throw new ResearchError(
            "research_invalid_input",
            `检查点回引了不存在的${label} ${value}。`,
          );
        }
      }
    }
    if (payload.supersedesCheckpointId !== null && !knownCheckpointIds.has(payload.supersedesCheckpointId)) {
      throw new ResearchError(
        "research_invalid_input",
        `检查点回引了不存在的上一个检查点 ${payload.supersedesCheckpointId}。`,
      );
    }
  }
}

export function createSqliteResearchRepository(database: SqliteRuntimeDatabase): ResearchRepository {
  database.migrate("research", MIGRATIONS);

  const readTaskRow = (id: string): Record<string, SQLInputValue> | undefined =>
    database.connection.prepare(`SELECT ${TASK_COLUMNS} FROM research_task WHERE id = ?`)
      .get(id) as Record<string, SQLInputValue> | undefined;

  // ---- 事务内助手：读取当前状态供引用校验与一致快照 ----

  const readQuestionIds = (taskId: string): Set<string> =>
    new Set(existingIds(database, "research_question_node", taskId));

  const readClaimIds = (taskId: string): Set<string> =>
    new Set(existingIds(database, "research_claim", taskId));

  /** evidenceId → sourceId：Conflict 双边校验与证据快照派生都用这张映射。 */
  const readEvidenceSourceIds = (taskId: string): Map<string, string> => {
    const rows = database.connection.prepare(
      "SELECT id, source_id AS sourceId FROM research_evidence_item WHERE task_id = ?",
    ).all(taskId) as Record<string, SQLInputValue>[];
    return new Map(rows.map((row) => [String(row.id), String(row.sourceId)]));
  };

  const readSourceAccessLevels = (taskId: string): Map<string, ResearchSourceAccessLevel> => {
    const rows = database.connection.prepare(
      "SELECT id, access_level AS accessLevel FROM research_source_entry WHERE task_id = ?",
    ).all(taskId) as Record<string, SQLInputValue>[];
    return new Map(rows.map((row) => [
      String(row.id),
      String(row.accessLevel) as ResearchSourceAccessLevel,
    ]));
  };

  function readBriefRow(taskId: string): ResearchBrief | undefined {
    const row = database.connection.prepare(`
      SELECT id, task_id AS taskId, objective, inclusions_json AS inclusionsJson,
             exclusions_json AS exclusionsJson, audience, answer_criteria AS answerCriteria,
             created_at AS createdAt
      FROM research_brief WHERE task_id = ?
    `).get(taskId) as Record<string, SQLInputValue> | undefined;
    if (row === undefined) return undefined;
    return parseResearchBrief({
      id: String(row.id),
      taskId: String(row.taskId),
      objective: String(row.objective),
      inclusions: parseJsonArray(String(row.inclusionsJson), "brief inclusions"),
      exclusions: parseJsonArray(String(row.exclusionsJson), "brief exclusions"),
      audience: String(row.audience),
      answerCriteria: String(row.answerCriteria),
      createdAt: Number(row.createdAt),
    });
  }

  function readQuestionRows(taskId: string): ResearchQuestionNodeRead[] {
    const rows = database.connection.prepare(`
      SELECT id, task_id AS taskId, parent_id AS parentId, text, boundary_note AS boundaryNote,
             priority, status, origin_kind AS originKind, origin_ref_id AS originRefId,
             origin_scope_basis AS originScopeBasis, reopened_count AS reopenedCount,
             created_at AS createdAt, updated_at AS updatedAt
      FROM research_question_node WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as Record<string, SQLInputValue>[];
    // evidenceStatus 读取时由来源计数派生：不建存储列，避免第二事实源。
    const counts = database.connection.prepare(`
      SELECT question_id AS questionId, COUNT(DISTINCT evidence_id) AS evidenceCount
      FROM research_evidence_question_edge WHERE task_id = ?
      GROUP BY question_id
    `).all(taskId) as Record<string, SQLInputValue>[];
    const countByQuestion = new Map(
      counts.map((row) => [String(row.questionId), Number(row.evidenceCount)]),
    );
    return rows.map((row) => {
      const evidenceCount = countByQuestion.get(String(row.id)) ?? 0;
      const evidenceStatus: ResearchEvidenceStatus =
        evidenceCount > 0 ? "has_sources" : "no_external_evidence";
      return parseResearchQuestionNodeRead({
        id: String(row.id),
        taskId: String(row.taskId),
        parentId: row.parentId === null ? null : String(row.parentId),
        text: String(row.text),
        boundaryNote: String(row.boundaryNote),
        priority: String(row.priority),
        status: String(row.status),
        origin: questionOriginFromRow(row),
        reopenedCount: Number(row.reopenedCount),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        evidenceCount,
        evidenceStatus,
      });
    });
  }

  /**
   * 批量结果契约要基实体形状：读取模型的派生字段（evidenceCount/evidenceStatus）
   * 只属于 ledger 读取投影，不随 applyObservations 的结果返回。
   */
  function readQuestionBaseNodes(taskId: string): ResearchQuestionNode[] {
    return readQuestionRows(taskId).map((read) => {
      const { evidenceCount: _evidenceCount, evidenceStatus: _evidenceStatus, ...question } = read;
      return question;
    });
  }

  function readQuestionEdgeRows(taskId: string): ResearchQuestionEdge[] {
    const rows = database.connection.prepare(`
      SELECT id, task_id AS taskId, from_question_id AS fromQuestionId,
             to_question_id AS toQuestionId, kind, created_at AS createdAt
      FROM research_question_edge WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as Record<string, SQLInputValue>[];
    return rows.map((row) => parseResearchQuestionEdge({
      id: String(row.id),
      taskId: String(row.taskId),
      fromQuestionId: String(row.fromQuestionId),
      toQuestionId: String(row.toQuestionId),
      kind: String(row.kind),
      createdAt: Number(row.createdAt),
    }));
  }

  function readSourceEntryRows(taskId: string): ResearchSourceEntry[] {
    const rows = database.connection.prepare(`
      SELECT id, task_id AS taskId, canonical_url AS canonicalUrl, title, domain, snippet,
             access_level AS accessLevel, content_hash AS contentHash,
             provenance_status AS provenanceStatus, created_at AS createdAt
      FROM research_source_entry WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as Record<string, SQLInputValue>[];
    return rows.map((row) => parseResearchSourceEntry({
      id: String(row.id),
      taskId: String(row.taskId),
      canonicalUrl: String(row.canonicalUrl),
      title: String(row.title),
      domain: String(row.domain),
      snippet: String(row.snippet),
      accessLevel: String(row.accessLevel),
      contentHash: row.contentHash === null ? null : String(row.contentHash),
      provenanceStatus: String(row.provenanceStatus),
      createdAt: Number(row.createdAt),
    }));
  }

  function readEvidenceRows(taskId: string): ResearchEvidenceItemRead[] {
    const rows = database.connection.prepare(`
      SELECT id, task_id AS taskId, source_id AS sourceId, excerpt, locator,
             extracted_claim AS extractedClaim, stance, access_level_snapshot AS accessLevelSnapshot,
             created_by_model_call AS createdByModelCall, created_at AS createdAt
      FROM research_evidence_item WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as Record<string, SQLInputValue>[];
    const edges = database.connection.prepare(`
      SELECT evidence_id AS evidenceId, question_id AS questionId
      FROM research_evidence_question_edge WHERE task_id = ?
    `).all(taskId) as Record<string, SQLInputValue>[];
    const questionIdsByEvidence = new Map<string, string[]>();
    for (const edge of edges) {
      const list = questionIdsByEvidence.get(String(edge.evidenceId)) ?? [];
      list.push(String(edge.questionId));
      questionIdsByEvidence.set(String(edge.evidenceId), list);
    }
    return rows.map((row) => parseResearchEvidenceItemRead({
      id: String(row.id),
      taskId: String(row.taskId),
      sourceId: String(row.sourceId),
      excerpt: String(row.excerpt),
      locator: String(row.locator),
      extractedClaim: String(row.extractedClaim),
      stance: String(row.stance),
      accessLevelSnapshot: String(row.accessLevelSnapshot),
      createdByModelCall: row.createdByModelCall === null ? null : String(row.createdByModelCall),
      createdAt: Number(row.createdAt),
      questionIds: questionIdsByEvidence.get(String(row.id)) ?? [],
    }));
  }

  function readClaimRows(taskId: string): ResearchClaimRead[] {
    const rows = database.connection.prepare(`
      SELECT id, task_id AS taskId, text, type, status, scope, qualifier,
             created_at AS createdAt, updated_at AS updatedAt
      FROM research_claim WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as Record<string, SQLInputValue>[];
    const edges = database.connection.prepare(`
      SELECT claim_id AS claimId, evidence_id AS evidenceId
      FROM research_claim_evidence_edge WHERE task_id = ?
    `).all(taskId) as Record<string, SQLInputValue>[];
    const evidenceIdsByClaim = new Map<string, string[]>();
    for (const edge of edges) {
      const list = evidenceIdsByClaim.get(String(edge.claimId)) ?? [];
      list.push(String(edge.evidenceId));
      evidenceIdsByClaim.set(String(edge.claimId), list);
    }
    return rows.map((row) => parseResearchClaimRead({
      id: String(row.id),
      taskId: String(row.taskId),
      text: String(row.text),
      type: String(row.type),
      status: String(row.status),
      scope: row.scope === null ? null : String(row.scope),
      qualifier: row.qualifier === null ? null : String(row.qualifier),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      evidenceIds: evidenceIdsByClaim.get(String(row.id)) ?? [],
    }));
  }

  /** 与 readQuestionBaseNodes 同义：剥掉读取投影的 evidenceIds，返回基实体形状。 */
  function readBaseClaims(taskId: string): ResearchClaim[] {
    return readClaimRows(taskId).map((read) => {
      const { evidenceIds: _evidenceIds, ...claim } = read;
      return claim;
    });
  }

  function readGapRows(taskId: string): ResearchGap[] {
    const rows = database.connection.prepare(`
      SELECT id, task_id AS taskId, question_id AS questionId, description, importance, origin,
             attempted_search_ids_json AS attemptedSearchIdsJson, status,
             created_at AS createdAt, updated_at AS updatedAt
      FROM research_gap WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as Record<string, SQLInputValue>[];
    return rows.map((row) => parseResearchGap({
      id: String(row.id),
      taskId: String(row.taskId),
      questionId: String(row.questionId),
      description: String(row.description),
      importance: String(row.importance),
      origin: String(row.origin),
      attemptedSearchIds: parseJsonArray(String(row.attemptedSearchIdsJson), "gap attempted search ids"),
      status: String(row.status),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    }));
  }

  function readConflictRows(taskId: string): ResearchConflict[] {
    const rows = database.connection.prepare(`
      SELECT id, task_id AS taskId, question_ids_json AS questionIdsJson,
             claim_a_id AS claimAId, claim_b_id AS claimBId,
             evidence_a_ids_json AS evidenceAIdsJson, evidence_b_ids_json AS evidenceBIdsJson,
             nature, status, resolution_note AS resolutionNote,
             created_at AS createdAt, updated_at AS updatedAt
      FROM research_conflict WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as Record<string, SQLInputValue>[];
    return rows.map((row) => parseResearchConflict({
      id: String(row.id),
      taskId: String(row.taskId),
      questionIds: parseJsonArray(String(row.questionIdsJson), "conflict question ids"),
      claimAId: String(row.claimAId),
      claimBId: String(row.claimBId),
      evidenceAIds: parseJsonArray(String(row.evidenceAIdsJson), "conflict evidence A ids"),
      evidenceBIds: parseJsonArray(String(row.evidenceBIdsJson), "conflict evidence B ids"),
      nature: String(row.nature),
      status: String(row.status),
      resolutionNote: row.resolutionNote === null ? null : String(row.resolutionNote),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    }));
  }

  function readReportRow(taskId: string): ResearchReport | undefined {
    const row = database.connection.prepare(`
      SELECT id, task_id AS taskId, title, created_at AS createdAt
      FROM research_report WHERE task_id = ?
    `).get(taskId) as Record<string, SQLInputValue> | undefined;
    if (row === undefined) return undefined;
    const spanRows = database.connection.prepare(`
      SELECT id, task_id AS taskId, report_id AS reportId, ordinal, text,
             claim_ids_json AS claimIdsJson, attribution_type AS attributionType,
             citation_source_ids_json AS citationSourceIdsJson, created_at AS createdAt
      FROM research_report_span WHERE task_id = ? ORDER BY ordinal
    `).all(taskId) as Record<string, SQLInputValue>[];
    const spans: ResearchReportSpan[] = spanRows.map((spanRow) => parseResearchReportSpan({
      id: String(spanRow.id),
      taskId: String(spanRow.taskId),
      reportId: String(spanRow.reportId),
      ordinal: Number(spanRow.ordinal),
      text: String(spanRow.text),
      claimIds: parseJsonArray(String(spanRow.claimIdsJson), "report span claim ids"),
      attributionType: String(spanRow.attributionType),
      citationSourceIds: parseJsonArray(String(spanRow.citationSourceIdsJson), "report span citation source ids"),
      createdAt: Number(spanRow.createdAt),
    }));
    return parseResearchReport({
      id: String(row.id),
      taskId: String(row.taskId),
      title: String(row.title),
      spans,
      createdAt: Number(row.createdAt),
    });
  }

  function readCitationCheckRows(taskId: string): ResearchCitationCheck[] {
    const rows = database.connection.prepare(`
      SELECT id, task_id AS taskId, report_span_id AS reportSpanId, claim_id AS claimId,
             verdict, sampled, verifier_input AS verifierInput, verifier_output AS verifierOutput,
             verifier_model AS verifierModel, created_at AS createdAt
      FROM research_citation_check WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as Record<string, SQLInputValue>[];
    return rows.map((row) => parseResearchCitationCheck({
      id: String(row.id),
      taskId: String(row.taskId),
      reportSpanId: String(row.reportSpanId),
      claimId: row.claimId === null ? null : String(row.claimId),
      verdict: String(row.verdict),
      sampled: Number(row.sampled) === 1,
      verifierInput: row.verifierInput === null ? null : String(row.verifierInput),
      verifierOutput: row.verifierOutput === null ? null : String(row.verifierOutput),
      verifierModel: row.verifierModel === null ? null : String(row.verifierModel),
      createdAt: Number(row.createdAt),
    }));
  }

  function readActionEventRows(taskId: string): ResearchActionEvent[] {
    const rows = database.connection.prepare(`
      SELECT id, task_id AS taskId, kind, question_refs_json AS questionRefsJson,
             payload_json AS payloadJson, created_at AS createdAt
      FROM research_action_event WHERE task_id = ? ORDER BY created_at, id
    `).all(taskId) as Record<string, SQLInputValue>[];
    return rows.map((row) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(row.payloadJson));
      } catch (error) {
        throw new ResearchError(
          "research_repository_failure",
          "Stored research action event payload is not valid JSON.",
          { cause: error },
        );
      }
      return parseResearchActionEvent({
        id: String(row.id),
        taskId: String(row.taskId),
        kind: String(row.kind),
        questionRefs: parseJsonArray(String(row.questionRefsJson), "action event question refs"),
        payload,
        createdAt: Number(row.createdAt),
      });
    });
  }

  // ---- 事务内写入助手：校验与写入在同一事务，任一失败整体回滚 ----

  function insertQuestions(
    taskId: string,
    drafts: readonly ResearchQuestionNodeDraft[],
    edges: readonly ResearchQuestionEdgeDraft[] | undefined,
    now: number,
  ): ResearchQuestionNode[] {
    const parsed = drafts.map((draft) => {
      assertQuestionOrigin(draft.origin);
      return parseDraft(parseResearchQuestionNodeDraft, draft, "question");
    });
    const edgeDrafts = (edges ?? []).map((edge) => parseDraft(parseResearchQuestionEdgeDraft, edge, "questionEdge"));
    const knownQuestionIds = readQuestionIds(taskId);
    const knownEvidenceIds = new Set(readEvidenceSourceIds(taskId).keys());
    for (const draft of parsed) {
      if (draft.parentId !== undefined && draft.parentId !== null && !knownQuestionIds.has(draft.parentId)) {
        throw new ResearchError(
          "research_invalid_input",
          `问题的父问题 ${draft.parentId} 不存在于该研究任务。`,
        );
      }
      if (draft.origin.kind === "question" && !knownQuestionIds.has(draft.origin.questionId)) {
        throw new ResearchError(
          "research_invalid_input",
          `问题 origin 引用的既有问题 ${draft.origin.questionId} 不存在。`,
        );
      }
      if (draft.origin.kind === "evidence" && !knownEvidenceIds.has(draft.origin.evidenceId)) {
        throw new ResearchError(
          "research_invalid_input",
          `问题 origin 引用的证据 ${draft.origin.evidenceId} 不存在。`,
        );
      }
    }
    const allocated = new Set(knownQuestionIds);
    const ids = allocateIds(taskId, "q", [...knownQuestionIds], parsed.length);
    for (const id of ids) allocated.add(id);
    const insert = database.connection.prepare(`
      INSERT INTO research_question_node(
        id, task_id, parent_id, text, boundary_note, priority, status,
        origin_kind, origin_ref_id, origin_scope_basis, reopened_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 0, ?, ?)
    `);
    const created: ResearchQuestionNode[] = [];
    parsed.forEach((draft, index) => {
      const id = ids[index] as string;
      const originRefId = draft.origin.kind === "brief"
        ? null
        : draft.origin.kind === "question" ? draft.origin.questionId : draft.origin.evidenceId;
      insert.run(
        id, taskId, draft.parentId ?? null, draft.text, draft.boundaryNote,
        draft.priority, draft.origin.kind, originRefId, draft.origin.scopeBasis, now, now,
      );
      created.push(parseResearchQuestionNode({
        id,
        taskId,
        parentId: draft.parentId ?? null,
        text: draft.text,
        boundaryNote: draft.boundaryNote,
        priority: draft.priority,
        status: "open",
        origin: draft.origin,
        reopenedCount: 0,
        createdAt: now,
        updatedAt: now,
      }));
    });
    if (edgeDrafts.length > 0) {
      const edgeIds = allocateIds(
        taskId, "qe", existingIds(database, "research_question_edge", taskId), edgeDrafts.length,
      );
      const insertEdge = database.connection.prepare(`
        INSERT INTO research_question_edge(id, task_id, from_question_id, to_question_id, kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      edgeDrafts.forEach((edge, index) => {
        if (!allocated.has(edge.fromQuestionId) || !allocated.has(edge.toQuestionId)) {
          throw new ResearchError(
            "research_invalid_input",
            `问题边引用了不存在的问题（${edge.fromQuestionId} → ${edge.toQuestionId}）。`,
          );
        }
        insertEdge.run(edgeIds[index] as string, taskId, edge.fromQuestionId, edge.toQuestionId, edge.kind, now);
      });
    }
    return created;
  }

  function insertSourceEntries(
    taskId: string,
    drafts: readonly ResearchSourceEntryDraft[],
    now: number,
  ): ResearchSourceEntry[] {
    const seen = new Set(database.connection.prepare(
      "SELECT canonical_url AS canonicalUrl FROM research_source_entry WHERE task_id = ?",
    ).all(taskId).map((row) => String((row as Record<string, SQLInputValue>).canonicalUrl)));
    const insert = database.connection.prepare(`
      INSERT INTO research_source_entry(
        id, task_id, canonical_url, title, domain, snippet, access_level,
        content_hash, provenance_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'unchecked', ?)
    `);
    const accepted: ResearchSourceEntry[] = [];
    for (const rawDraft of drafts) {
      const draft = parseDraft(parseResearchSourceEntryDraft, rawDraft, "sourceEntry");
      const canonicalUrl = draft.canonicalUrl ?? canonicalizeUrl(draft.url);
      if (canonicalUrl === undefined || seen.has(canonicalUrl)) continue;
      seen.add(canonicalUrl);
      const domain = draft.domain ?? domainOf(canonicalUrl);
      const accessLevel = draft.accessLevel ?? "snippet";
      const [id] = allocateIds(
        taskId, "src", existingIds(database, "research_source_entry", taskId), 1,
      );
      const sourceId = id as string;
      insert.run(sourceId, taskId, canonicalUrl, draft.title, domain, draft.snippet, accessLevel, now);
      accepted.push(parseResearchSourceEntry({
        id: sourceId,
        taskId,
        canonicalUrl,
        title: draft.title,
        domain,
        snippet: draft.snippet,
        accessLevel,
        contentHash: null,
        provenanceStatus: "unchecked",
        createdAt: now,
      }));
    }
    return accepted;
  }

  function insertEvidenceItems(
    taskId: string,
    drafts: readonly ResearchEvidenceItemDraft[],
    now: number,
  ): ResearchEvidenceItem[] {
    const parsed = drafts.map((draft) => parseDraft(parseResearchEvidenceItemDraft, draft, "evidence"));
    const sourceAccess = readSourceAccessLevels(taskId);
    const knownQuestionIds = readQuestionIds(taskId);
    for (const draft of parsed) {
      if (!sourceAccess.has(draft.sourceId)) {
        throw new ResearchError("research_invalid_input", `证据引用了不存在的来源 ${draft.sourceId}。`);
      }
      for (const questionId of draft.questionIds) {
        if (!knownQuestionIds.has(questionId)) {
          throw new ResearchError("research_invalid_input", `证据绑定了不存在的问题 ${questionId}。`);
        }
      }
    }
    const ids = allocateIds(taskId, "e", existingIds(database, "research_evidence_item", taskId), parsed.length);
    const edgeIds = allocateIds(
      taskId, "eq", existingIds(database, "research_evidence_question_edge", taskId),
      parsed.reduce((sum, draft) => sum + draft.questionIds.length, 0),
    );
    const insert = database.connection.prepare(`
      INSERT INTO research_evidence_item(
        id, task_id, source_id, excerpt, locator, extracted_claim, stance,
        access_level_snapshot, created_by_model_call, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = database.connection.prepare(`
      INSERT INTO research_evidence_question_edge(id, task_id, evidence_id, question_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const created: ResearchEvidenceItem[] = [];
    let edgeCursor = 0;
    parsed.forEach((draft, index) => {
      const id = ids[index] as string;
      // 快照写入时从来源行派生：模型输入无法设定读取深度（草稿无该字段）。
      const accessLevelSnapshot = sourceAccess.get(draft.sourceId) as ResearchSourceAccessLevel;
      insert.run(
        id, taskId, draft.sourceId, draft.excerpt, draft.locator, draft.extractedClaim,
        draft.stance, accessLevelSnapshot, draft.createdByModelCall ?? null, now,
      );
      for (const questionId of draft.questionIds) {
        insertEdge.run(edgeIds[edgeCursor] as string, taskId, id, questionId, now);
        edgeCursor += 1;
      }
      created.push(parseResearchEvidenceItem({
        id,
        taskId,
        sourceId: draft.sourceId,
        excerpt: draft.excerpt,
        locator: draft.locator,
        extractedClaim: draft.extractedClaim,
        stance: draft.stance,
        accessLevelSnapshot,
        createdByModelCall: draft.createdByModelCall ?? null,
        createdAt: now,
      }));
    });
    return created;
  }

  function insertClaims(
    taskId: string,
    drafts: readonly ResearchClaimDraft[],
    now: number,
  ): ResearchClaim[] {
    const parsed = drafts.map((draft) => parseDraft(parseResearchClaimDraft, draft, "claim"));
    const knownEvidenceIds = new Set(readEvidenceSourceIds(taskId).keys());
    for (const draft of parsed) {
      for (const evidenceId of draft.evidenceIds) {
        if (!knownEvidenceIds.has(evidenceId)) {
          throw new ResearchError("research_invalid_input", `主张绑定了不存在的证据 ${evidenceId}。`);
        }
      }
    }
    const ids = allocateIds(taskId, "c", existingIds(database, "research_claim", taskId), parsed.length);
    const edgeIds = allocateIds(
      taskId, "ce", existingIds(database, "research_claim_evidence_edge", taskId),
      parsed.reduce((sum, draft) => sum + draft.evidenceIds.length, 0),
    );
    const insert = database.connection.prepare(`
      INSERT INTO research_claim(
        id, task_id, text, type, status, scope, qualifier, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = database.connection.prepare(`
      INSERT INTO research_claim_evidence_edge(id, task_id, claim_id, evidence_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const created: ResearchClaim[] = [];
    let edgeCursor = 0;
    parsed.forEach((draft, index) => {
      const id = ids[index] as string;
      const status = draft.status ?? "provisional";
      insert.run(
        id, taskId, draft.text, draft.type, status,
        draft.scope ?? null, draft.qualifier ?? null, now, now,
      );
      for (const evidenceId of draft.evidenceIds) {
        insertEdge.run(edgeIds[edgeCursor] as string, taskId, id, evidenceId, now);
        edgeCursor += 1;
      }
      created.push(parseResearchClaim({
        id,
        taskId,
        text: draft.text,
        type: draft.type,
        status,
        scope: draft.scope ?? null,
        qualifier: draft.qualifier ?? null,
        createdAt: now,
        updatedAt: now,
      }));
    });
    return created;
  }

  function insertGaps(taskId: string, drafts: readonly ResearchGapDraft[], now: number): ResearchGap[] {
    const parsed = drafts.map((draft) => parseDraft(parseResearchGapDraft, draft, "gap"));
    const knownQuestionIds = readQuestionIds(taskId);
    for (const draft of parsed) {
      if (!knownQuestionIds.has(draft.questionId)) {
        throw new ResearchError("research_invalid_input", `缺口挂在不存在的问题 ${draft.questionId} 上。`);
      }
    }
    const ids = allocateIds(taskId, "g", existingIds(database, "research_gap", taskId), parsed.length);
    const insert = database.connection.prepare(`
      INSERT INTO research_gap(
        id, task_id, question_id, description, importance, origin,
        attempted_search_ids_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const created: ResearchGap[] = [];
    parsed.forEach((draft, index) => {
      const id = ids[index] as string;
      const status = draft.status ?? "open";
      insert.run(
        id, taskId, draft.questionId, draft.description, draft.importance, draft.origin,
        JSON.stringify(draft.attemptedSearchIds ?? []), status, now, now,
      );
      created.push(parseResearchGap({
        id,
        taskId,
        questionId: draft.questionId,
        description: draft.description,
        importance: draft.importance,
        origin: draft.origin,
        attemptedSearchIds: draft.attemptedSearchIds ?? [],
        status,
        createdAt: now,
        updatedAt: now,
      }));
    });
    return created;
  }

  function insertConflict(taskId: string, draft: ResearchConflictDraft, now: number): ResearchConflict {
    const parsed = parseDraft(parseResearchConflictDraft, draft, "conflict");
    const evidenceSourceIds = readEvidenceSourceIds(taskId);
    // 双边结构：每边各 ≥2 个不同来源的 Evidence；单边一律拒绝。
    assertConflictSidesBalanced({
      evidenceAIds: parsed.evidenceAIds,
      evidenceBIds: parsed.evidenceBIds,
      evidenceSourceIds,
    });
    const knownClaimIds = readClaimIds(taskId);
    const knownQuestionIds = readQuestionIds(taskId);
    if (!knownClaimIds.has(parsed.claimAId) || !knownClaimIds.has(parsed.claimBId)) {
      throw new ResearchError("research_invalid_input", "冲突双边必须引用任务内已存在的主张。");
    }
    for (const questionId of parsed.questionIds) {
      if (!knownQuestionIds.has(questionId)) {
        throw new ResearchError("research_invalid_input", `冲突引用了不存在的问题 ${questionId}。`);
      }
    }
    const [id] = allocateIds(taskId, "x", existingIds(database, "research_conflict", taskId), 1);
    const conflictId = id as string;
    const status = parsed.status ?? "unresolved";
    database.connection.prepare(`
      INSERT INTO research_conflict(
        id, task_id, question_ids_json, claim_a_id, claim_b_id,
        evidence_a_ids_json, evidence_b_ids_json, nature, status, resolution_note,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      conflictId, taskId, JSON.stringify(parsed.questionIds), parsed.claimAId, parsed.claimBId,
      JSON.stringify(parsed.evidenceAIds), JSON.stringify(parsed.evidenceBIds),
      parsed.nature, status, now, now,
    );
    return parseResearchConflict({
      id: conflictId,
      taskId,
      questionIds: parsed.questionIds,
      claimAId: parsed.claimAId,
      claimBId: parsed.claimBId,
      evidenceAIds: parsed.evidenceAIds,
      evidenceBIds: parsed.evidenceBIds,
      nature: parsed.nature,
      status,
      resolutionNote: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  function applyQuestionUpdates(
    taskId: string,
    updates: readonly ResearchQuestionUpdate[],
    now: number,
  ): ResearchQuestionNode[] {
    const known = new Map(readQuestionRows(taskId).map((question) => [question.id, question]));
    const update = database.connection.prepare(`
      UPDATE research_question_node
      SET boundary_note = COALESCE(?, boundary_note),
          priority = COALESCE(?, priority), status = COALESCE(?, status), updated_at = ?
      WHERE id = ? AND task_id = ?
    `);
    for (const item of updates) {
      const current = known.get(item.questionId);
      if (current === undefined) {
        throw new ResearchError("research_invalid_input", `问题 ${item.questionId} 不存在，无法更新。`);
      }
      if (item.status !== undefined && !canTransitionQuestionStatus(current.status, item.status)) {
        throw new ResearchError(
          "research_invalid_input",
          `问题状态不允许从 ${current.status} 迁移到 ${item.status}。`,
        );
      }
      update.run(item.boundaryNote ?? null, item.priority ?? null, item.status ?? null, now, item.questionId, taskId);
      // 同一 batch 内对同一实体的后续更新按刚落库的状态校验，不用段首快照——
      // 否则 [withdrawn, supported] 这类组合会让第二条对照陈旧状态通过。
      const refreshed = readQuestionRows(taskId).find((question) => question.id === item.questionId);
      if (refreshed !== undefined) known.set(item.questionId, refreshed);
    }
    const touched = new Set(updates.map((item) => item.questionId));
    return readQuestionBaseNodes(taskId).filter((question) => touched.has(question.id));
  }

  function reopenQuestions(
    taskId: string,
    questionIds: readonly string[],
    now: number,
  ): ResearchQuestionNode[] {
    const known = new Map(readQuestionRows(taskId).map((question) => [question.id, question]));
    const reopen = database.connection.prepare(`
      UPDATE research_question_node
      SET status = 'investigating', reopened_count = reopened_count + 1, updated_at = ?
      WHERE id = ? AND task_id = ?
    `);
    for (const questionId of questionIds) {
      const current = known.get(questionId);
      if (current === undefined) {
        throw new ResearchError("research_invalid_input", `问题 ${questionId} 不存在，无法重开。`);
      }
      if (!canTransitionQuestionStatus(current.status, "investigating")) {
        throw new ResearchError(
          "research_invalid_input",
          `问题 ${questionId} 当前状态 ${current.status} 不允许重开。`,
        );
      }
      reopen.run(now, questionId, taskId);
      const refreshed = readQuestionRows(taskId).find((question) => question.id === questionId);
      if (refreshed !== undefined) known.set(questionId, refreshed);
    }
    const touched = new Set(questionIds);
    return readQuestionBaseNodes(taskId).filter((question) => touched.has(question.id));
  }

  function applyClaimUpdates(
    taskId: string,
    updates: readonly ResearchClaimUpdate[],
    now: number,
  ): ResearchClaim[] {
    const known = new Map(readClaimRows(taskId).map((claim) => [claim.id, claim]));
    const update = database.connection.prepare(`
      UPDATE research_claim
      SET text = COALESCE(?, text), scope = COALESCE(?, scope), qualifier = COALESCE(?, qualifier),
          status = COALESCE(?, status), updated_at = ?
      WHERE id = ? AND task_id = ?
    `);
    for (const item of updates) {
      const current = known.get(item.claimId);
      if (current === undefined) {
        throw new ResearchError("research_invalid_input", `主张 ${item.claimId} 不存在，无法更新。`);
      }
      if (item.status !== undefined && !canTransitionClaimStatus(current.status, item.status)) {
        throw new ResearchError(
          "research_invalid_input",
          `主张状态不允许从 ${current.status} 迁移到 ${item.status}。`,
        );
      }
      update.run(item.text ?? null, item.scope ?? null, item.qualifier ?? null, item.status ?? null, now, item.claimId, taskId);
      // 同 applyQuestionUpdates：段内重复更新按刚落库状态校验，终态不得被复活。
      const refreshed = readClaimRows(taskId).find((claim) => claim.id === item.claimId);
      if (refreshed !== undefined) known.set(item.claimId, refreshed);
    }
    const touched = new Set(updates.map((item) => item.claimId));
    return readBaseClaims(taskId).filter((claim) => touched.has(claim.id));
  }

  /** finishTask 的事务内报告写入：Report+ReportSpan 与终态同事务。 */
  function writeReport(
    taskId: string,
    report: { readonly title: string; readonly spans: readonly ResearchReportSpanDraft[] },
    createdAt: number,
  ): void {
    const drafts = report.spans.map((span) => parseDraft(parseResearchReportSpanDraft, span, "reportSpan"));
    const claimIds = readClaimIds(taskId);
    const sourceIds = new Set(readSourceEntryRows(taskId).map((entry) => entry.id));
    for (const draft of drafts) {
      for (const claimId of draft.claimIds) {
        if (!claimIds.has(claimId)) {
          throw new ResearchError("research_invalid_input", `报告段落引用了不存在的主张 ${claimId}。`);
        }
      }
      for (const sourceId of draft.citationSourceIds) {
        if (!sourceIds.has(sourceId)) {
          throw new ResearchError("research_invalid_input", `报告段落引用了不存在的来源 ${sourceId}。`);
        }
      }
    }
    const reportId = `${taskId}:r1`;
    database.connection.prepare(`
      INSERT INTO research_report(id, task_id, title, created_at) VALUES (?, ?, ?, ?)
    `).run(reportId, taskId, report.title, createdAt);
    const insertSpan = database.connection.prepare(`
      INSERT INTO research_report_span(
        id, task_id, report_id, ordinal, text, claim_ids_json, attribution_type,
        citation_source_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    drafts.forEach((draft, index) => {
      insertSpan.run(
        `${reportId}:s${index + 1}`, taskId, reportId, index + 1, draft.text,
        JSON.stringify(draft.claimIds), draft.attributionType,
        JSON.stringify(draft.citationSourceIds), createdAt,
      );
    });
  }

  return {
    async insertTask(task: ResearchTask): Promise<void> {
      try {
        database.connection.prepare(`
          INSERT INTO research_task(
            id, question, status, stage, plan_json, coverage_json, report_title, report_markdown,
            error_code, error_message, usage_json, cancel_requested, created_at, started_at, ended_at,
            completion, reason, ceiling_hit, scope_approval_json, brief_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          task.id, task.question, task.status, task.stage,
          task.plan === null ? null : JSON.stringify(task.plan),
          JSON.stringify(task.coverage),
          task.reportTitle, task.reportMarkdown, task.errorCode, task.errorMessage,
          JSON.stringify(task.usage), task.createdAt, task.startedAt, task.endedAt,
          task.completion, task.reason, task.ceilingHit,
          task.scopeApproval === null ? null : JSON.stringify(task.scopeApproval),
          task.briefId,
        );
      } catch (error) {
        throw repositoryError("Could not insert the research task into SQLite.", error);
      }
    },

    async readTask(id: string): Promise<ResearchTask | undefined> {
      try {
        const row = readTaskRow(id);
        return row === undefined ? undefined : taskFromRow(row);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read the research task from SQLite.", error);
      }
    },

    async listTasks(input: { readonly limit: number }): Promise<readonly ResearchTaskSummary[]> {
      try {
        const rows = database.connection.prepare(`
          SELECT t.id AS id, t.question AS question, t.status AS status, t.stage AS stage,
                 t.plan_json AS planJson, t.created_at AS createdAt, t.ended_at AS endedAt,
                 t.error_code AS errorCode,
                 (SELECT COUNT(*) FROM research_source s WHERE s.task_id = t.id) AS sourceCount
          FROM research_task t
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT ?
        `).all(input.limit) as Record<string, SQLInputValue>[];
        return rows.map((row) => parseResearchTaskSummary({
          id: String(row.id),
          question: String(row.question),
          status: String(row.status),
          stage: row.stage === null ? null : String(row.stage),
          sourceCount: Number(row.sourceCount),
          questionCount: countPlanQuestions(row.planJson),
          createdAt: Number(row.createdAt),
          endedAt: row.endedAt === null ? null : Number(row.endedAt),
          errorCode: row.errorCode === null ? null : String(row.errorCode),
        }));
      } catch (error) {
        throw repositoryError("Could not list research tasks from SQLite.", error);
      }
    },

    async claimNextQueued(input: { readonly startedAt: number }): Promise<ResearchTask | undefined> {
      try {
        return database.transaction(() => {
          const candidate = database.connection.prepare(
            "SELECT id FROM research_task WHERE status = 'queued' ORDER BY created_at, id LIMIT 1",
          ).get() as Record<string, SQLInputValue> | undefined;
          if (candidate === undefined) return undefined;
          const taskId = String(candidate.id);
          const claimed = database.connection.prepare(`
            UPDATE research_task SET status = 'running', stage = NULL, started_at = ?
            WHERE id = ? AND status = 'queued'
          `).run(input.startedAt, taskId);
          if (Number(claimed.changes) === 0) return undefined;
          const row = readTaskRow(taskId);
          return row === undefined ? undefined : taskFromRow(row);
        });
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not claim the next queued research task from SQLite.", error);
      }
    },

    async hasQueuedTasks(): Promise<boolean> {
      try {
        return database.connection.prepare("SELECT 1 AS found FROM research_task WHERE status = 'queued' LIMIT 1")
          .get() !== undefined;
      } catch (error) {
        throw repositoryError("Could not inspect the research queue in SQLite.", error);
      }
    },

    async updateProgress(input: {
      readonly id: string;
      readonly stage?: ResearchStage;
      readonly usage: ResearchUsage;
    }): Promise<void> {
      try {
        // turn 驱动后应用层不传 stage：阶段列保持 NULL，不为旧五阶段伪造过程语义。
        if (input.stage === undefined) {
          database.connection.prepare(
            "UPDATE research_task SET usage_json = ? WHERE id = ? AND status = 'running'",
          ).run(JSON.stringify(input.usage), input.id);
          return;
        }
        database.connection.prepare(
          "UPDATE research_task SET stage = ?, usage_json = ? WHERE id = ? AND status = 'running'",
        ).run(input.stage, JSON.stringify(input.usage), input.id);
      } catch (error) {
        throw repositoryError("Could not update the research task progress in SQLite.", error);
      }
    },

    /** 旧流水线来源表的只读残留（DDL 冻结保留；turn 驱动后无写入方）。 */
    async listSources(taskId: string): Promise<readonly ResearchSource[]> {
      try {
        const rows = database.connection.prepare(`
          SELECT id, task_id AS taskId, ordinal, title, url, canonical_url AS canonicalUrl, snippet,
                 content_text AS contentText, content_status AS contentStatus,
                 published_at AS publishedAt, retrieved_at AS retrievedAt
          FROM research_source WHERE task_id = ? ORDER BY ordinal
        `).all(taskId) as Record<string, SQLInputValue>[];
        return rows.map((row) => parseResearchSource({
          id: String(row.id),
          taskId: String(row.taskId),
          ordinal: Number(row.ordinal),
          title: String(row.title),
          url: String(row.url),
          canonicalUrl: String(row.canonicalUrl),
          snippet: String(row.snippet),
          contentText: row.contentText === null ? null : String(row.contentText),
          contentStatus: String(row.contentStatus),
          publishedAt: row.publishedAt === null ? null : String(row.publishedAt),
          retrievedAt: Number(row.retrievedAt),
        }));
      } catch (error) {
        throw repositoryError("Could not read research sources from SQLite.", error);
      }
    },

    /** 旧流水线检索记录表的只读残留（DDL 冻结保留；turn 驱动后无写入方）。 */
    async listQueries(taskId: string): Promise<readonly ResearchQueryRecord[]> {
      try {
        const rows = database.connection.prepare(`
          SELECT id, task_id AS taskId, round, text, status, result_count AS resultCount,
                 created_at AS createdAt
          FROM research_query WHERE task_id = ? ORDER BY created_at, id
        `).all(taskId) as Record<string, SQLInputValue>[];
        return rows.map((row) => parseResearchQuery({
          id: String(row.id),
          taskId: String(row.taskId),
          round: Number(row.round),
          text: String(row.text),
          status: String(row.status),
          resultCount: Number(row.resultCount),
          createdAt: Number(row.createdAt),
        }));
      } catch (error) {
        throw repositoryError("Could not read research queries from SQLite.", error);
      }
    },

    async finishTask(input: {
      readonly id: string;
      readonly status: "completed" | "failed" | "cancelled" | "interrupted";
      readonly reportTitle?: string;
      readonly reportMarkdown?: string;
      readonly errorCode?: string;
      readonly errorMessage?: string;
      readonly usage: ResearchUsage;
      readonly endedAt: number;
      readonly completion?: ResearchCompletion | null;
      readonly reason?: string | null;
      readonly ceilingHit?: ResearchCeilingKind | null;
      readonly report?: {
        readonly title: string;
        readonly spans: readonly ResearchReportSpanDraft[];
      };
    }): Promise<ResearchTask | undefined> {
      try {
        return database.transaction(() => {
          const current = database.connection.prepare(
            "SELECT status FROM research_task WHERE id = ?",
          ).get(input.id) as Record<string, SQLInputValue> | undefined;
          if (current === undefined) return undefined;
          const status = String(current.status) as ResearchTaskStatus;
          // 已进入终态的任务是既成事实：重复提交不覆盖（幂等保存）。
          if (status !== "queued" && status !== "running") return undefined;
          if (input.report !== undefined) {
            // 报告与终态同事务：先写 Report+ReportSpan（引用存在性在事务内校验），
            // 任何一步失败整体回滚，不会留下「终态但没有报告」。
            writeReport(input.id, input.report, input.endedAt);
          }
          database.connection.prepare(`
            UPDATE research_task
            SET status = ?, stage = NULL, report_title = ?, report_markdown = ?,
                error_code = ?, error_message = ?, usage_json = ?, ended_at = ?,
                completion = ?, reason = ?, ceiling_hit = ?
            WHERE id = ?
          `).run(
            input.status,
            input.reportTitle ?? null,
            input.reportMarkdown ?? null,
            input.errorCode ?? null,
            input.errorMessage ?? null,
            JSON.stringify(input.usage),
            input.endedAt,
            input.completion ?? null,
            input.reason ?? null,
            input.ceilingHit ?? null,
            input.id,
          );
          const row = readTaskRow(input.id);
          return row === undefined ? undefined : taskFromRow(row);
        });
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not finish the research task in SQLite.", error);
      }
    },

    async isCancelRequested(id: string): Promise<boolean> {
      try {
        const row = database.connection.prepare(
          "SELECT cancel_requested AS cancelRequested FROM research_task WHERE id = ?",
        ).get(id) as Record<string, SQLInputValue> | undefined;
        return row !== undefined && Number(row.cancelRequested) === 1;
      } catch (error) {
        throw repositoryError("Could not read the research cancellation flag from SQLite.", error);
      }
    },

    async requestCancel(id: string): Promise<void> {
      try {
        database.connection.prepare(
          "UPDATE research_task SET cancel_requested = 1 WHERE id = ? AND status IN ('queued', 'running')",
        ).run(id);
      } catch (error) {
        throw repositoryError("Could not record the research cancellation request in SQLite.", error);
      }
    },

    async recoverInterrupted(input: { readonly endedAt: number }): Promise<number> {
      try {
        const result = database.connection.prepare(`
          UPDATE research_task
          SET status = 'interrupted', stage = NULL, ended_at = ?,
              error_code = 'research_interrupted',
              error_message = '应用在本次研究结束前退出，未完成任务已标记为中断。'
          WHERE status = 'running'
        `).run(input.endedAt);
        return Number(result.changes);
      } catch (error) {
        throw repositoryError("Could not recover interrupted research tasks in SQLite.", error);
      }
    },

    // ---- 账本段 ----

    async approveScope(input: {
      readonly taskId: string;
      readonly approval: ResearchScopeApproval;
      readonly brief: ResearchBriefDraft;
    }): Promise<ResearchBrief> {
      try {
        return database.transaction(() => {
          const row = database.connection.prepare(
            "SELECT brief_id AS briefId FROM research_task WHERE id = ?",
          ).get(input.taskId) as Record<string, SQLInputValue> | undefined;
          if (row === undefined) {
            throw new ResearchError("research_task_not_found", `研究任务 ${input.taskId} 不存在。`);
          }
          if (row.briefId !== null) {
            throw new ResearchError(
              "research_invalid_input",
              "研究范围已批准并落账，不可重复批准或变更（改范围请发起新任务）。",
            );
          }
          const approval = parseDraft(parseResearchScopeApproval, input.approval, "scopeApproval");
          const draft = parseDraft(parseResearchBriefDraft, input.brief, "brief");
          const briefId = `${input.taskId}:brief`;
          database.connection.prepare(`
            INSERT INTO research_brief(
              id, task_id, objective, inclusions_json, exclusions_json, audience, answer_criteria, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            briefId, input.taskId, draft.objective,
            JSON.stringify(draft.inclusions), JSON.stringify(draft.exclusions),
            draft.audience, draft.answerCriteria, approval.approvedAt,
          );
          database.connection.prepare(`
            UPDATE research_task SET scope_approval_json = ?, brief_id = ? WHERE id = ?
          `).run(JSON.stringify(approval), briefId, input.taskId);
          return parseResearchBrief({
            id: briefId,
            taskId: input.taskId,
            objective: draft.objective,
            inclusions: draft.inclusions,
            exclusions: draft.exclusions,
            audience: draft.audience,
            answerCriteria: draft.answerCriteria,
            createdAt: approval.approvedAt,
          });
        });
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not approve the research scope in SQLite.", error);
      }
    },

    async readBrief(taskId: string): Promise<ResearchBrief | undefined> {
      try {
        return readBriefRow(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read the research brief from SQLite.", error);
      }
    },

    async appendQuestions(input: {
      readonly taskId: string;
      readonly questions: readonly ResearchQuestionNodeDraft[];
      readonly edges?: readonly ResearchQuestionEdgeDraft[];
    }): Promise<readonly ResearchQuestionNode[]> {
      try {
        return database.transaction(() =>
          insertQuestions(input.taskId, input.questions, input.edges, Date.now()));
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not append research questions to SQLite.", error);
      }
    },

    async listQuestions(taskId: string): Promise<readonly ResearchQuestionNodeRead[]> {
      try {
        return readQuestionRows(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read research questions from SQLite.", error);
      }
    },

    async listQuestionEdges(taskId: string): Promise<readonly ResearchQuestionEdge[]> {
      try {
        return readQuestionEdgeRows(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read research question edges from SQLite.", error);
      }
    },

    async appendSourceEntries(input: {
      readonly taskId: string;
      readonly drafts: readonly ResearchSourceEntryDraft[];
    }): Promise<readonly ResearchSourceEntry[]> {
      try {
        return database.transaction(() => insertSourceEntries(input.taskId, input.drafts, Date.now()));
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not append research source entries to SQLite.", error);
      }
    },

    async markSourceAccess(input: {
      readonly taskId: string;
      readonly sourceId: string;
      readonly accessLevel: ResearchSourceAccessLevel;
      readonly contentHash: string | null;
    }): Promise<void> {
      try {
        database.connection.prepare(`
          UPDATE research_source_entry SET access_level = ?, content_hash = ?
          WHERE task_id = ? AND id = ?
        `).run(input.accessLevel, input.contentHash, input.taskId, input.sourceId);
      } catch (error) {
        throw repositoryError("Could not record the research source access level in SQLite.", error);
      }
    },

    async markSourceProvenance(input: {
      readonly taskId: string;
      readonly sourceId: string;
      readonly provenanceStatus: ResearchSourceProvenanceStatus;
    }): Promise<void> {
      try {
        database.connection.prepare(`
          UPDATE research_source_entry SET provenance_status = ? WHERE task_id = ? AND id = ?
        `).run(input.provenanceStatus, input.taskId, input.sourceId);
      } catch (error) {
        throw repositoryError("Could not record the research source provenance in SQLite.", error);
      }
    },

    async listSourceEntries(taskId: string): Promise<readonly ResearchSourceEntry[]> {
      try {
        return readSourceEntryRows(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read research source entries from SQLite.", error);
      }
    },

    async appendEvidenceItems(input: {
      readonly taskId: string;
      readonly items: readonly ResearchEvidenceItemDraft[];
    }): Promise<readonly ResearchEvidenceItem[]> {
      try {
        return database.transaction(() => insertEvidenceItems(input.taskId, input.items, Date.now()));
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not append research evidence items to SQLite.", error);
      }
    },

    async listEvidenceItems(taskId: string): Promise<readonly ResearchEvidenceItemRead[]> {
      try {
        return readEvidenceRows(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read research evidence items from SQLite.", error);
      }
    },

    async appendClaims(input: {
      readonly taskId: string;
      readonly claims: readonly ResearchClaimDraft[];
    }): Promise<readonly ResearchClaim[]> {
      try {
        return database.transaction(() => insertClaims(input.taskId, input.claims, Date.now()));
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not append research claims to SQLite.", error);
      }
    },

    async listClaims(taskId: string): Promise<readonly ResearchClaimRead[]> {
      try {
        return readClaimRows(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read research claims from SQLite.", error);
      }
    },

    async appendGaps(input: {
      readonly taskId: string;
      readonly gaps: readonly ResearchGapDraft[];
    }): Promise<readonly ResearchGap[]> {
      try {
        return database.transaction(() => insertGaps(input.taskId, input.gaps, Date.now()));
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not append research gaps to SQLite.", error);
      }
    },

    async listGaps(taskId: string): Promise<readonly ResearchGap[]> {
      try {
        return readGapRows(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read research gaps from SQLite.", error);
      }
    },

    async createConflict(input: {
      readonly taskId: string;
      readonly conflict: ResearchConflictDraft;
    }): Promise<ResearchConflict> {
      try {
        return database.transaction(() => insertConflict(input.taskId, input.conflict, Date.now()));
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not create the research conflict in SQLite.", error);
      }
    },

    async listConflicts(taskId: string): Promise<readonly ResearchConflict[]> {
      try {
        return readConflictRows(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read research conflicts from SQLite.", error);
      }
    },

    async readReport(taskId: string): Promise<ResearchReport | undefined> {
      try {
        return readReportRow(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read the research report from SQLite.", error);
      }
    },

    async appendCitationChecks(input: {
      readonly taskId: string;
      readonly checks: readonly ResearchCitationCheckDraft[];
    }): Promise<readonly ResearchCitationCheck[]> {
      try {
        return database.transaction(() => {
          const drafts = input.checks.map((check) => parseDraft(parseResearchCitationCheckDraft, check, "citationCheck"));
          const report = readReportRow(input.taskId);
          const spanIds = new Set((report?.spans ?? []).map((span) => span.id));
          const claimIds = readClaimIds(input.taskId);
          for (const draft of drafts) {
            if (!spanIds.has(draft.reportSpanId)) {
              throw new ResearchError(
                "research_invalid_input",
                `核验记录指向不存在的报告段落 ${draft.reportSpanId}。`,
              );
            }
            if (draft.claimId !== undefined && draft.claimId !== null && !claimIds.has(draft.claimId)) {
              throw new ResearchError(
                "research_invalid_input",
                `核验记录引用了不存在的主张 ${draft.claimId}。`,
              );
            }
          }
          const now = Date.now();
          const ids = allocateIds(
            input.taskId, "cc", existingIds(database, "research_citation_check", input.taskId), drafts.length,
          );
          const insert = database.connection.prepare(`
            INSERT INTO research_citation_check(
              id, task_id, report_span_id, claim_id, verdict, sampled,
              verifier_input, verifier_output, verifier_model, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const created: ResearchCitationCheck[] = [];
          drafts.forEach((draft, index) => {
            const id = ids[index] as string;
            insert.run(
              id, input.taskId, draft.reportSpanId, draft.claimId ?? null, draft.verdict,
              draft.sampled ? 1 : 0,
              draft.verifierInput ?? null, draft.verifierOutput ?? null,
              draft.verifierModel ?? null, now,
            );
            created.push(parseResearchCitationCheck({
              id,
              taskId: input.taskId,
              reportSpanId: draft.reportSpanId,
              claimId: draft.claimId ?? null,
              verdict: draft.verdict,
              sampled: draft.sampled,
              verifierInput: draft.verifierInput ?? null,
              verifierOutput: draft.verifierOutput ?? null,
              verifierModel: draft.verifierModel ?? null,
              createdAt: now,
            }));
          });
          return created;
        });
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not append research citation checks to SQLite.", error);
      }
    },

    async listCitationChecks(taskId: string): Promise<readonly ResearchCitationCheck[]> {
      try {
        return readCitationCheckRows(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read research citation checks from SQLite.", error);
      }
    },

    async appendActionEvents(input: {
      readonly taskId: string;
      readonly events: readonly ResearchActionEventDraft[];
    }): Promise<readonly ResearchActionEvent[]> {
      try {
        return database.transaction(() => {
          const drafts = input.events.map((event) => parseDraft(parseResearchActionEventDraft, event, "actionEvent"));
          const knownQuestionIds = readQuestionIds(input.taskId);
          for (const draft of drafts) {
            // 后置实体（SourceFetch / CheckpointSummary）的版本化 JSON 按 kind 校验形状。
            const payloadParser = ACTION_EVENT_PAYLOAD_PARSERS[draft.kind];
            if (payloadParser !== undefined) {
              parseDraft(payloadParser, draft.payload, `${draft.kind} payload`);
            }
            for (const questionRef of draft.questionRefs ?? []) {
              if (!knownQuestionIds.has(questionRef)) {
                throw new ResearchError(
                  "research_invalid_input",
                  `动作事件的 questionRef ${questionRef} 不存在于该研究任务。`,
                );
              }
            }
          }
          assertCheckpointBackReferences(database, input.taskId, drafts);
          const now = Date.now();
          const ids = allocateIds(
            input.taskId, "ev", existingIds(database, "research_action_event", input.taskId), drafts.length,
          );
          const insert = database.connection.prepare(`
            INSERT INTO research_action_event(
              id, task_id, kind, question_refs_json, payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `);
          const created: ResearchActionEvent[] = [];
          drafts.forEach((draft, index) => {
            const id = ids[index] as string;
            const questionRefs = draft.questionRefs ?? [];
            insert.run(
              id, input.taskId, draft.kind, JSON.stringify(questionRefs),
              JSON.stringify(draft.payload), now,
            );
            created.push(parseResearchActionEvent({
              id,
              taskId: input.taskId,
              kind: draft.kind,
              questionRefs,
              payload: draft.payload,
              createdAt: now,
            }));
          });
          return created;
        });
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not append research action events to SQLite.", error);
      }
    },

    async listActionEvents(taskId: string): Promise<readonly ResearchActionEvent[]> {
      try {
        return readActionEventRows(taskId);
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read research action events from SQLite.", error);
      }
    },

    async applyObservations(input: {
      readonly taskId: string;
      readonly batch: ResearchObservationBatch;
    }): Promise<ResearchObservationResult> {
      try {
        return database.transaction(() => {
          const batch = parseDraft(parseResearchObservationBatch, input.batch, "observationBatch");
          const now = Date.now();
          const questions: ResearchQuestionNode[] = [];
          const evidenceItems: ResearchEvidenceItem[] = [];
          const claims: ResearchClaim[] = [];
          const gaps: ResearchGap[] = [];
          const conflicts: ResearchConflict[] = [];

          // 1. 问题更新：状态迁移必须过状态机。
          if (batch.questionUpdates !== undefined && batch.questionUpdates.length > 0) {
            questions.push(...applyQuestionUpdates(input.taskId, batch.questionUpdates, now));
          }
          // 2. 重开：covered/disputed/blocked/abandoned → investigating，reopened_count +1。
          if (batch.reopenQuestionIds !== undefined && batch.reopenQuestionIds.length > 0) {
            questions.push(...reopenQuestions(input.taskId, batch.reopenQuestionIds, now));
          }
          // 3. 新问题：origin 必填且引用存在；ID 由框架分配。
          if (batch.newQuestions !== undefined && batch.newQuestions.length > 0) {
            questions.push(...insertQuestions(input.taskId, batch.newQuestions, undefined, now));
          }
          // 4. 证据：来源/问题引用存在；快照由来源行派生。
          if (batch.evidenceItems !== undefined && batch.evidenceItems.length > 0) {
            evidenceItems.push(...insertEvidenceItems(input.taskId, batch.evidenceItems, now));
          }
          // 5. 主张更新：状态迁移必须过状态机。
          if (batch.claimUpdates !== undefined && batch.claimUpdates.length > 0) {
            claims.push(...applyClaimUpdates(input.taskId, batch.claimUpdates, now));
          }
          // 6. 新缺口。
          if (batch.newGaps !== undefined && batch.newGaps.length > 0) {
            gaps.push(...insertGaps(input.taskId, batch.newGaps, now));
          }
          // 7. 新冲突：双边各 ≥2 个不同来源的 Evidence。
          if (batch.newConflicts !== undefined && batch.newConflicts.length > 0) {
            for (const draft of batch.newConflicts) {
              conflicts.push(insertConflict(input.taskId, draft, now));
            }
          }
          return parseResearchObservationResult({ questions, evidenceItems, claims, gaps, conflicts });
        });
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not apply research observations in SQLite.", error);
      }
    },

    async readLedger(taskId: string): Promise<ResearchLedger | undefined> {
      try {
        return database.transaction(() => {
          if (readTaskRow(taskId) === undefined) return undefined;
          return {
            taskId,
            brief: readBriefRow(taskId) ?? null,
            questions: readQuestionRows(taskId),
            questionEdges: readQuestionEdgeRows(taskId),
            sources: readSourceEntryRows(taskId),
            evidence: readEvidenceRows(taskId),
            claims: readClaimRows(taskId),
            gaps: readGapRows(taskId),
            conflicts: readConflictRows(taskId),
            report: readReportRow(taskId) ?? null,
            citationChecks: readCitationCheckRows(taskId),
            actionEvents: readActionEventRows(taskId),
          };
        });
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not read the research ledger from SQLite.", error);
      }
    },
  };
}

function taskFromRow(row: Record<string, SQLInputValue>): ResearchTask {
  const coverageJson = row.coverageJson === null ? "[]" : String(row.coverageJson);
  const planJson = row.planJson === null ? null : String(row.planJson);
  const scopeApprovalJson = row.scopeApprovalJson === null ? null : String(row.scopeApprovalJson);
  return parseResearchTask({
    id: String(row.id),
    question: String(row.question),
    status: String(row.status),
    stage: row.stage === null ? null : String(row.stage),
    plan: planJson === null ? null : parseResearchPlan(JSON.parse(planJson)),
    coverage: parseCoverageList(coverageJson),
    reportTitle: row.reportTitle === null ? null : String(row.reportTitle),
    reportMarkdown: row.reportMarkdown === null ? null : String(row.reportMarkdown),
    errorCode: row.errorCode === null ? null : String(row.errorCode),
    errorMessage: row.errorMessage === null ? null : String(row.errorMessage),
    usage: parseResearchUsage(JSON.parse(String(row.usageJson))),
    createdAt: Number(row.createdAt),
    startedAt: row.startedAt === null ? null : Number(row.startedAt),
    endedAt: row.endedAt === null ? null : Number(row.endedAt),
    completion: row.completion === null ? null : String(row.completion),
    reason: row.reason === null ? null : String(row.reason),
    ceilingHit: row.ceilingHit === null ? null : String(row.ceilingHit),
    scopeApproval: scopeApprovalJson === null ? null : parseResearchScopeApproval(JSON.parse(scopeApprovalJson)),
    briefId: row.briefId === null ? null : String(row.briefId),
  });
}

function questionOriginFromRow(row: Record<string, SQLInputValue>): unknown {
  const kind = String(row.originKind);
  const refId = row.originRefId === null ? null : String(row.originRefId);
  const scopeBasis = String(row.originScopeBasis);
  if (kind === "brief") return { kind, scopeBasis };
  if (kind === "question") return { kind, questionId: refId, scopeBasis };
  return { kind, evidenceId: refId, scopeBasis };
}

function parseCoverageList(raw: string): readonly ResearchCoverageRound[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new ResearchError("research_repository_failure", "Stored research coverage is not an array.");
  }
  return parsed.map((item) => parseResearchCoverageRound(item));
}

function countPlanQuestions(planJson: SQLInputValue | undefined): number {
  if (planJson === null || planJson === undefined) return 0;
  try {
    return parseResearchPlan(JSON.parse(String(planJson))).questions.length;
  } catch {
    // 计划损坏不阻塞列表：数量按 0 报告，详情读取会明确失败。
    return 0;
  }
}

/** 来源域名：只用于展示分组，不参与去重（去重键是 canonical URL）。 */
function domainOf(canonicalUrl: string): string {
  try {
    return new URL(canonicalUrl).hostname;
  } catch {
    return "";
  }
}

/**
 * 仓储错误：把底层原因写进 message。
 *
 * 这些错误最终会作为任务的 errorMessage 展示给用户，也是排查时的唯一线索；
 * 只写「SQLite 失败」而丢掉 cause，等于把「主键冲突」「磁盘锁」这类可定位的
 * 事实一起丢掉了。cause 同时保留在 ErrorOptions 里供程序化读取。
 */
function repositoryError(message: string, cause: unknown): ResearchError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ResearchError("research_repository_failure", `${message} ${detail}`.trim(), { cause });
}
