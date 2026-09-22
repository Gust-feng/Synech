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
 * 研究队列与终态的最小不变量验证（数据、并发、恢复三类，按 AGENTS.md 规则 11）。
 *
 * 只保护长期必须成立的事实，不追踪实现细节：
 * 1. 队列认领是 CAS：同一任务不会被领取两次；
 * 2. 重启只把 running 标记 interrupted，绝不自动重放；
 * 3. 报告与终态同事务写入，且已终态的任务不接受再次写入（幂等保存）；
 * 4. 取消只置标记，不改变终态。
 *
 * turn 驱动后（ADR 0001 §2.3）执行层不再写固定流水线的中间表：plan/coverage JSON 列、
 * research_source、research_query 的写入路径已退役（DDL 冻结保留、只读残留），
 * 旧流水线中间态的测试由 tests/core-research-turn.test.mjs 的 turn 测试取代。
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
    // turn 驱动后阶段列保持 NULL：研究没有对应 stage 语义，不伪造过程阶段。
    assert.equal(claimed?.stage, null);
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

    // 账本段来源入列后，报告 span 才能引用真实 sourceId（引用存在性在事务内校验）。
    const [source] = await feature.commands.appendSourceEntries({
      taskId: task.id,
      drafts: [{ title: "成本对比", url: "https://example.com/a?utm_source=x", snippet: "摘要一" }],
    });

    const finished = await feature.commands.finishTask({
      id: task.id,
      status: "completed",
      usage: usage(),
      completion: "normal",
      report: {
        title: "研究报告",
        spans: [{
          text: "综合判断：两种方案的适用条件不同。",
          claimIds: [],
          attributionType: "synthesis",
          citationSourceIds: [source.id],
        }],
      },
    });
    assert.equal(finished?.status, "completed");
    assert.equal(finished?.stage, null);

    const ledger = await feature.queries.ledger(task.id);
    assert.equal(ledger?.report?.spans.length, 1);
    assert.equal(ledger?.report?.spans[0]?.citationSourceIds[0], source.id);

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

test("research update progress persists usage without a stage", async () => {
  await withFeature(async ({ feature }) => {
    const task = await feature.commands.createTask({ question: "问题" });
    await feature.commands.claimNextQueued({ startedAt: 2_000 });
    await feature.commands.updateProgress({ id: task.id, usage: usage() });
    const detail = await feature.queries.detail(task.id);
    assert.equal(detail?.task.usage.modelRequests, 2);
    // turn 驱动后应用层不写 stage：阶段列保持认领时的 NULL。
    assert.equal(detail?.task.stage, null);
  });
});
