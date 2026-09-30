import type { SqliteRuntimeDatabase } from "../../adapters/runtime-storage/index.js";

/**
 * 已退役研究功能的目标结构。ADR 0006 将开发期 research/1..4 收敛为一个完整
 * version 1，不兼容旧开发 ledger；本切片保留最终表、列、约束和索引。
 * 仅供存储启动施加 schema，不提供研究表读写入口。
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
      published_at TEXT,
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
        'model_content', 'tool_call', 'tool_result', 'tool_trajectory', 'ledger_change',
        'resource_state_change', 'source_fetch', 'checkpoint_summary'
      )),
      question_refs_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX research_action_event_task_idx ON research_action_event(task_id, created_at, id);

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
}] as const;

/**
 * 仅施加目标结构，不返回研究表读写对象。
 */
export function migrateResearchSchema(database: SqliteRuntimeDatabase): void {
  database.migrate("research", MIGRATIONS);
}
