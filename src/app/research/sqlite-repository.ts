import type { SQLInputValue } from "node:sqlite";

import type { SqliteRuntimeDatabase } from "../../adapters/runtime-storage/index.js";
import {
  ResearchError,
  type ResearchRepository,
  type ResearchCoverageRound,
  type ResearchPlan,
  type ResearchQueryRecord,
  type ResearchSource,
  type ResearchSourceStatus,
  type ResearchStage,
  type ResearchTask,
  type ResearchTaskStatus,
  type ResearchTaskSummary,
  type ResearchUsage,
} from "./contracts.js";
import {
  parseResearchCoverageRound,
  parseResearchPlan,
  parseResearchQuery,
  parseResearchSource,
  parseResearchTask,
  parseResearchTaskSummary,
  parseResearchUsage,
} from "./persistence-schema.js";

/**
 * 研究事实的 SQLite 持久化。
 *
 * 三条不变量：
 * 1. 队列状态是唯一事实源——worker 的认领是 CAS（queued→running），
 *    重启后 running 残留只能被标记 interrupted，绝不自动重放。
 * 2. 报告与终态同事务写入；已进入终态的任务不接受再次写入（重复提交是空操作）。
 * 3. 来源编号由本层分配：按 canonical_url 去重后从现有最大值递增，跨轮稳定。
 */

// Frozen v1 initializes the target schema; future changes append migrations.
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
      ended_at INTEGER
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
  `,
}] as const;

const TASK_COLUMNS = `id, question, status, stage, plan_json AS planJson, coverage_json AS coverageJson,
  report_title AS reportTitle, report_markdown AS reportMarkdown, error_code AS errorCode,
  error_message AS errorMessage, usage_json AS usageJson, created_at AS createdAt,
  started_at AS startedAt, ended_at AS endedAt`;

export function createSqliteResearchRepository(database: SqliteRuntimeDatabase): ResearchRepository {
  database.migrate("research", MIGRATIONS);

  const readTaskRow = (id: string): Record<string, SQLInputValue> | undefined =>
    database.connection.prepare(`SELECT ${TASK_COLUMNS} FROM research_task WHERE id = ?`)
      .get(id) as Record<string, SQLInputValue> | undefined;

  return {
    async insertTask(task: ResearchTask): Promise<void> {
      try {
        database.connection.prepare(`
          INSERT INTO research_task(
            id, question, status, stage, plan_json, coverage_json, report_title, report_markdown,
            error_code, error_message, usage_json, cancel_requested, created_at, started_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `).run(
          task.id, task.question, task.status, task.stage,
          task.plan === null ? null : JSON.stringify(task.plan),
          JSON.stringify(task.coverage),
          task.reportTitle, task.reportMarkdown, task.errorCode, task.errorMessage,
          JSON.stringify(task.usage), task.createdAt, task.startedAt, task.endedAt,
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
            UPDATE research_task SET status = 'running', stage = 'planning', started_at = ?
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
      readonly stage: ResearchStage;
      readonly usage: ResearchUsage;
    }): Promise<void> {
      try {
        database.connection.prepare(
          "UPDATE research_task SET stage = ?, usage_json = ? WHERE id = ? AND status = 'running'",
        ).run(input.stage, JSON.stringify(input.usage), input.id);
      } catch (error) {
        throw repositoryError("Could not update the research task progress in SQLite.", error);
      }
    },

    async savePlan(input: { readonly id: string; readonly plan: ResearchPlan }): Promise<void> {
      try {
        database.connection.prepare(
          "UPDATE research_task SET plan_json = ? WHERE id = ? AND status = 'running'",
        ).run(JSON.stringify(input.plan), input.id);
      } catch (error) {
        throw repositoryError("Could not save the research plan to SQLite.", error);
      }
    },

    async saveCoverage(input: {
      readonly id: string;
      readonly coverage: readonly ResearchCoverageRound[];
    }): Promise<void> {
      try {
        database.connection.prepare(
          "UPDATE research_task SET coverage_json = ? WHERE id = ? AND status = 'running'",
        ).run(JSON.stringify(input.coverage), input.id);
      } catch (error) {
        throw repositoryError("Could not save the research coverage to SQLite.", error);
      }
    },

    async appendSources(input: {
      readonly taskId: string;
      readonly drafts: readonly {
        readonly title: string;
        readonly url: string;
        readonly snippet: string;
        readonly publishedAt?: string;
      }[];
      readonly retrievedAt: number;
      /** 任务允许的来源条数上限；达到后不再入列。由调用方给值（策略归应用层）。 */
      readonly limit: number;
    }): Promise<readonly ResearchSource[]> {
      try {
        return database.transaction(() => {
          const existing = database.connection.prepare(
            "SELECT canonical_url AS canonicalUrl, ordinal FROM research_source WHERE task_id = ?",
          ).all(input.taskId) as Record<string, SQLInputValue>[];
          const seen = new Set(existing.map((row) => String(row.canonicalUrl)));
          let ordinal = existing.reduce((max, row) => Math.max(max, Number(row.ordinal)), 0);
          const insert = database.connection.prepare(`
            INSERT INTO research_source(
              id, task_id, ordinal, title, url, canonical_url, snippet, content_text,
              content_status, published_at, retrieved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?)
          `);
          const accepted: ResearchSource[] = [];
          for (const draft of input.drafts) {
            if (accepted.length + existing.length >= input.limit) break;
            const canonicalUrl = canonicalizeUrl(draft.url);
            if (canonicalUrl === undefined || seen.has(canonicalUrl)) continue;
            seen.add(canonicalUrl);
            ordinal += 1;
            const source: ResearchSource = parseResearchSource({
              id: `${input.taskId}:s${ordinal}`,
              taskId: input.taskId,
              ordinal,
              title: draft.title,
              url: draft.url,
              canonicalUrl,
              snippet: draft.snippet,
              contentText: null,
              contentStatus: "pending",
              publishedAt: draft.publishedAt ?? null,
              retrievedAt: input.retrievedAt,
            });
            insert.run(
              source.id, source.taskId, source.ordinal, source.title, source.url, source.canonicalUrl,
              source.snippet, source.publishedAt, source.retrievedAt,
            );
            accepted.push(source);
          }
          return accepted;
        });
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        throw repositoryError("Could not append research sources to SQLite.", error);
      }
    },

    async markSourceContent(input: {
      readonly taskId: string;
      readonly sourceId: string;
      readonly status: ResearchSourceStatus;
      readonly contentText: string | null;
    }): Promise<void> {
      try {
        database.connection.prepare(
          "UPDATE research_source SET content_status = ?, content_text = ? WHERE task_id = ? AND id = ?",
        ).run(input.status, input.contentText, input.taskId, input.sourceId);
      } catch (error) {
        throw repositoryError("Could not update the research source content in SQLite.", error);
      }
    },

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

    async appendQueries(input: {
      readonly taskId: string;
      readonly records: readonly Omit<ResearchQueryRecord, "taskId">[];
    }): Promise<void> {
      try {
        database.transaction(() => {
          const insert = database.connection.prepare(`
            INSERT INTO research_query(id, task_id, round, text, status, result_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          for (const record of input.records) {
            insert.run(
              record.id, input.taskId, record.round, record.text, record.status,
              record.resultCount, record.createdAt,
            );
          }
        });
      } catch (error) {
        throw repositoryError("Could not append research queries to SQLite.", error);
      }
    },

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
          database.connection.prepare(`
            UPDATE research_task
            SET status = ?, stage = NULL, report_title = ?, report_markdown = ?,
                error_code = ?, error_message = ?, usage_json = ?, ended_at = ?
            WHERE id = ?
          `).run(
            input.status,
            input.reportTitle ?? null,
            input.reportMarkdown ?? null,
            input.errorCode ?? null,
            input.errorMessage ?? null,
            JSON.stringify(input.usage),
            input.endedAt,
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
  };
}

function taskFromRow(row: Record<string, SQLInputValue>): ResearchTask {
  const coverageJson = row.coverageJson === null ? "[]" : String(row.coverageJson);
  const planJson = row.planJson === null ? null : String(row.planJson);
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
  });
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

/** 去重键：忽略协议/主机大小写、hash 与 utm 参数；无法解析的 URL 不入列。 */
function canonicalizeUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
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
