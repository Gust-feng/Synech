import type { SqliteRuntimeDatabase } from "../../adapters/runtime-storage/index.js";

/**
 * `synech/v1` 冻结目标 schema 的化石：深度研究功能已于 2026-09-27 移除（ADR 0006），
 * research owner 的建表 migration 逐字保留在这里。
 *
 * 为什么保留：fresh Product Home 的 schema fingerprint 必须保持与
 * `docs/architecture/data-baseline.json` 一致，既有产品库的 migration ledger 校验
 * （checksum）也必须继续通过。删除这些 DDL 会改变数据基线与已有库的 migrate 结果，
 * 因此「表在、写入方没了」是 REMOVED 语义下唯一安全的状态。
 *
 * 纪律：本文件只被存储启动路径调用一次以施加冻结 schema；**不得扩展、不得写入**，
 * 不得再有任何研究读取/写入代码引用这些表。
 */

/**
 * 新建库定义：research owner 的完整目标 schema（ADR 0001 §2.1 / 设计草案 §6）。
 *
 * 与旧开发库的关系：plan/coverage JSON 列与 research_source、research_query 是
 * 已退役固定流水线的存储。DDL 冻结保留（不为退役改 research/1 schema 与基线），但
 * 写入路径已随 turn 驱动移除：新写入只进账本段表，旧表只剩只读残留
 * （detail/DTO 仍读它们，v1.0.1 升级 fixture 仍清空它们）。
 *
 * schema 演进纪律（开发维护规则 §7）：`synech/v1` 已冻结，只能为 owner **追加**
 * 单调递增的 migration 版本；已应用的 SQL 与 checksum 不可改（`research/1` 一字
 * 不动），新版本按标准「建新表 → 复制 → 删旧表 → 重命名 → 重建索引」施加，
 * 既有行与索引名全部保留。未发布前同样不为旧开发库写额外兼容路径。
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
}, {
  /**
   * research/2：`action_event.kind` 的 CHECK 追加 `tool_trajectory`。
   *
   * 工具调用轨迹（开发期插桩，ADR 0001 §8 / 设计文档 §3.4）是**要长期单独研究的
   * 动作事件**：它有自己的 payload 契约与自己的版本序列（version 1 起，与业务
   * attempt 的 version 1 完全隔离），因此必须有自己的 kind——不与业务 attempt 挤在
   * `tool_call` / `tool_result` 里靠 payload version 猜，业务事件的形状将来怎么变
   * 都不影响轨迹记录的形状与可读性。
   *
   * SQLite 无法 ALTER CHECK，标准做法是重建表：建新表（同样 STRICT、列与原表一致、
   * CHECK 多一个 kind）→ 整表复制既有行 → 删旧表 → 重命名 → 重建同名索引。
   * `research/1` 的 SQL 与 checksum 冻结，不得只改旧版本（checksum 历史检查强制）。
   */
  version: 2,
  sql: `
    CREATE TABLE research_action_event_v2 (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN (
        'model_content', 'tool_call', 'tool_result', 'tool_trajectory', 'ledger_change',
        'resource_state_change', 'source_fetch', 'checkpoint_summary'
      )),
      question_refs_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO research_action_event_v2(id, task_id, kind, question_refs_json, payload_json, created_at)
      SELECT id, task_id, kind, question_refs_json, payload_json, created_at FROM research_action_event;
    DROP TABLE research_action_event;
    ALTER TABLE research_action_event_v2 RENAME TO research_action_event;
    CREATE INDEX research_action_event_task_idx ON research_action_event(task_id, created_at, id);
  `,
}, {
  /**
   * research/3：新增 `research_source_content`——框架保存的来源正文。
   *
   * 抓取流程此前「算 hash → 全文丢弃」，`research_source_entry` 只有 content_hash、
   * 没有正文列，引用硬门因此只能拿「模型自己写的摘录」比对（架构笔记 §16.1 核实的
   * 循环论证洞）。本表让正文与来源行同事务落库，硬门的权威判据（quote 落在框架保存
   * 的正文上）才有比对对象；§16.3 判定为零基线变更（仍在 Product Home 库内），但
   * 按 schema 演进纪律追加 migration 并重生成 data-baseline。
   *
   * 纯追加：只建新表与索引，不动任何既有表（SQLite 无需为 CREATE TABLE 重建），
   * `research/1` 与 `research/2` 的 SQL 与 checksum 一字未改。
   */
  version: 3,
  sql: `
    CREATE TABLE research_source_content (
      source_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      text TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1))
    ) STRICT;
    CREATE INDEX research_source_content_task_idx ON research_source_content(task_id);
  `,
}, {
  /**
   * research/4：`research_source_entry` 追加 `published_at`——检索端口给出的发布时间。
   *
   * 架构笔记 §16.2 缺口 3：`ResearchSearchPort` 的返回一直带 `publishedAt`，
   * web-search 适配器也已从多家 provider 提取，但研究侧既不落账也不露出，时效性
   * 事实对模型不可见。本列让它随来源行持久化，sourceCard / research_get_source
   * 因此能如实露出日期。
   *
   * 纯追加：ADD COLUMN 可空、无默认值（检索端口没给就是 NULL，不写空串或编造值），
   * 既有行自动为 NULL；`research/1`–`research/3` 的 SQL 与 checksum 一字未改。
   */
  version: 4,
  sql: `
    ALTER TABLE research_source_entry ADD COLUMN published_at TEXT;
  `,
}] as const;

/**
 * 施加 research owner 的冻结 schema（唯一允许的入口，供存储启动调用）。
 * 与历史上的 `createSqliteResearchRepository(database)` 行为一致：只 migrate，
 * 不返回任何可读写研究表的对象。
 */
export function migrateResearchSchema(database: SqliteRuntimeDatabase): void {
  database.migrate("research", MIGRATIONS);
}
