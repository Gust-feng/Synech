import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  createResearchFeature,
  createSqliteResearchRepository,
} from "../dist/app/research/index.js";

/**
 * 研究能力的最小不变量验证（数据、并发、恢复三类，按 AGENTS.md 规则 11）。
 *
 * 只保护长期必须成立的事实，不追踪实现细节：
 * 1. 队列认领是 CAS：同一任务不会被领取两次；
 * 2. 重启只把 running 标记 interrupted，绝不自动重放；
 * 3. 报告与终态同事务写入，且已终态的任务不接受再次写入（幂等保存）；
 * 4. 取消只置标记，不改变终态。
 */

async function withFeature(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-research-"));
  const filePath = path.join(dir, "synech.sqlite3");
  const database = new SqliteRuntimeDatabase(filePath);
  let clock = 1_000;
  let sequence = 0;
  const repository = createSqliteResearchRepository(database);
  const feature = createResearchFeature({
    repository,
    now: () => clock,
    idFactory: (prefix) => `${prefix}-${++sequence}`,
  });
  try {
    await run({
      feature,
      repository,
      filePath,
      advance: (ms) => { clock += ms; },
    });
  } finally {
    await feature.release();
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const usage = (overrides = {}) => ({
  searchRequests: 1,
  fetchRequests: 1,
  modelRequests: 2,
  inputTokens: 100,
  outputTokens: 200,
  elapsedMs: 5_000,
  ...overrides,
});

test("research queue claim is single-assignment and recovery only marks interrupted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-research-recovery-"));
  const filePath = path.join(dir, "synech.sqlite3");
  try {
    const firstDb = new SqliteRuntimeDatabase(filePath);
    const first = createResearchFeature({
      repository: createSqliteResearchRepository(firstDb),
      now: () => 1_000,
      idFactory: (prefix) => `${prefix}-1`,
    });
    const created = await first.commands.createTask({ question: "家用 NAS 的维护负担有多大？" });
    assert.equal(created.status, "queued");

    // 认领是 CAS：第二次领取拿不到同一个任务。
    const claimed = await first.commands.claimNextQueued({ startedAt: 2_000 });
    assert.equal(claimed?.id, created.id);
    assert.equal(claimed?.status, "running");
    const second = await first.commands.claimNextQueued({ startedAt: 3_000 });
    assert.equal(second, undefined);
    await first.release();
    firstDb.close();

    // 重启：running 残留标记为 interrupted，不回到队列、不自动重放。
    const secondDb = new SqliteRuntimeDatabase(filePath);
    const reopened = createResearchFeature({
      repository: createSqliteResearchRepository(secondDb),
      now: () => 4_000,
      idFactory: (prefix) => `${prefix}-2`,
    });
    const recovered = await reopened.ready();
    assert.equal(recovered, 1);
    const detail = await reopened.queries.detail(created.id);
    assert.equal(detail?.task.status, "interrupted");
    assert.equal(detail?.task.errorCode, "research_interrupted");
    assert.equal(detail?.task.endedAt, 4_000);
    // 恢复后队列为空：终态任务不会被再次领取。
    assert.equal(await reopened.commands.claimNextQueued({ startedAt: 5_000 }), undefined);
    await reopened.release();
    secondDb.close();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("research finish writes report and terminal status atomically and never overwrites it", async () => {
  await withFeature(async ({ feature }) => {
    const task = await feature.commands.createTask({ question: "长上下文与 RAG 各自适合什么？" });
    await feature.commands.claimNextQueued({ startedAt: 2_000 });
    await feature.commands.savePlan({
      id: task.id,
      plan: {
        objective: "判断两种方案的适用条件",
        questions: [{ id: "q1", text: "长上下文的成本结构如何？", priority: "high" }],
      },
    });
    await feature.commands.saveCoverage({
      id: task.id,
      coverage: [{ round: 1, answers: [{ questionId: "q1", coverage: "partial", text: "只有部分依据", gaps: ["缺少成本数据"] }] }],
    });

    const sources = await feature.commands.appendSources({
      taskId: task.id,
      drafts: [
        { title: "长上下文成本", url: "https://example.com/a?utm_source=x", snippet: "摘要一" },
        // 同一规范化 URL 只入列一次，编号跨轮稳定。
        { title: "重复项", url: "https://example.com/a", snippet: "摘要二" },
        { title: "非法链接", url: "not-a-url", snippet: "摘要三" },
      ],
      limit: 24,
    });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].ordinal, 1);

    const finished = await feature.commands.finishTask({
      id: task.id,
      status: "completed",
      reportTitle: "研究报告",
      reportMarkdown: "# 报告",
      usage: usage(),
    });
    assert.equal(finished?.status, "completed");
    assert.equal(finished?.stage, null);

    // 重复提交是空操作：已进入终态的任务不被覆盖。
    const replayed = await feature.commands.finishTask({
      id: task.id,
      status: "failed",
      errorCode: "late_write",
      errorMessage: "迟到的写入",
      usage: usage({ modelRequests: 99 }),
    });
    assert.equal(replayed, undefined);
    const detail = await feature.queries.detail(task.id);
    assert.equal(detail?.task.status, "completed");
    assert.equal(detail?.task.reportMarkdown, "# 报告");
    assert.equal(detail?.task.usage.modelRequests, 2);
  });
});

test("research cancel records intent without forcing a terminal state", async () => {
  await withFeature(async ({ feature }) => {
    const task = await feature.commands.createTask({ question: "新能源汽车冬季续航的讨论变了什么？" });
    assert.equal(await feature.queries.isCancelRequested(task.id), false);
    await feature.cancel(task.id);
    assert.equal(await feature.queries.isCancelRequested(task.id), true);
    // 置标记不改状态：终止由执行侧在步骤边界收敛。
    const detail = await feature.queries.detail(task.id);
    assert.equal(detail?.task.status, "queued");
  });
});

test("research queries stay unique when two tasks ask the same question", async () => {
  await withFeature(async ({ feature }) => {
    // 两个研究问同一个问题、都在第 1 轮检索：检索记录 id 曾经只拼「轮次-序号-查询词」，
    // 与任务无关，于是第二个任务的整轮记录会撞主键冲突并整批回滚。
    const first = await feature.commands.createTask({ question: "什么是爱情" });
    await feature.commands.claimNextQueued({ startedAt: 1_000 });
    await feature.commands.appendQueries({
      taskId: first.id,
      records: [{ id: `${first.id}:q1`, round: 1, text: "什么是爱情", status: "failed", resultCount: 0, createdAt: 1_000 }],
    });

    const second = await feature.commands.createTask({ question: "什么是爱情" });
    await feature.commands.claimNextQueued({ startedAt: 2_000 });
    await feature.commands.appendQueries({
      taskId: second.id,
      records: [{ id: `${second.id}:q1`, round: 1, text: "什么是爱情", status: "failed", resultCount: 0, createdAt: 2_000 }],
    });

    const firstDetail = await feature.queries.detail(first.id);
    const secondDetail = await feature.queries.detail(second.id);
    assert.equal(firstDetail?.queries.length, 1);
    assert.equal(secondDetail?.queries.length, 1);
    assert.notEqual(firstDetail?.queries[0]?.id, secondDetail?.queries[0]?.id);
  });
});

test("research sources stop at the requested limit", async () => {
  await withFeature(async ({ feature }) => {
    const task = await feature.commands.createTask({ question: "问题" });
    const draft = (n) => ({ title: `标题${n}`, url: `https://example.com/${n}`, snippet: `摘要${n}` });

    const first = await feature.commands.appendSources({
      taskId: task.id,
      drafts: [draft(1), draft(2), draft(3)],
      limit: 3,
    });
    assert.equal(first.length, 3);

    // 已达上限：后续检索结果不再入列（编号也不递增）。
    const second = await feature.commands.appendSources({
      taskId: task.id,
      drafts: [draft(4), draft(5)],
      limit: 3,
    });
    assert.equal(second.length, 0);
    const detail = await feature.queries.detail(task.id);
    assert.equal(detail?.sources.length, 3);
    assert.deepEqual(detail?.sources.map((s) => s.ordinal), [1, 2, 3]);
  });
});

test("research source content status reflects what was actually read", async () => {
  await withFeature(async ({ feature }) => {
    const task = await feature.commands.createTask({ question: "问题" });
    const [source] = await feature.commands.appendSources({
      taskId: task.id,
      drafts: [{ title: "标题", url: "https://example.com/page", snippet: "摘要" }],
      limit: 24,
    });
    assert.equal(source?.contentStatus, "pending");
    assert.equal(source?.contentText, null);

    await feature.commands.markSourceContent({
      taskId: task.id,
      sourceId: source.id,
      status: "ready",
      contentText: "抓到的正文",
    });
    await feature.commands.appendQueries({
      taskId: task.id,
      records: [{ id: "q1", round: 1, text: "检索词", status: "succeeded", resultCount: 3, createdAt: 1_000 }],
    });

    const detail = await feature.queries.detail(task.id);
    assert.equal(detail?.sources[0]?.contentStatus, "ready");
    assert.equal(detail?.sources[0]?.contentText, "抓到的正文");
    assert.equal(detail?.queries.length, 1);
    assert.equal(detail?.queries[0]?.resultCount, 3);
  });
});
