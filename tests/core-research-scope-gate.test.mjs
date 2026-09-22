import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { createResearchApplication } from "../dist/app/application/research-application.js";
import {
  ResearchScopeGateError,
  createResearchFeature,
  createSqliteResearchRepository,
} from "../dist/app/research/index.js";

/**
 * 范围闸门（ADR 0001 §2.2 / 设计草案 §8.1）的最小不变量验证。
 *
 * 这是产品硬约束，只保护一条长期必须成立的事实：
 * **未经用户在范围卡上批准、且未通过结构校验的范围载荷，不得创建研究任务、
 * 不得入队**。具体到三条可观察断言：
 * 1. 结构校验失败不得入队：缺失字段清单完整（不是只报第一条），任务数为 0；
 * 2. 无 approval 不得创建任务：缺 approval 时同样一个任务都不建；
 * 3. 载荷通过后才按固定顺序落账（brief + scopeApproval 同事务 + 初始问题树），
 *    且 payload_hash 由框架落账（客户端自述的哈希不构成可审计事实）。
 *
 * 语义充分性由用户在范围卡上判定，框架不判：本测试因此只断言「结构不齐被拒」，
 * 不断言任何「写得好不好」。
 */

const VALUE_BRIEF = {
  objective: "判断长上下文与 RAG 在成本结构上的适用条件",
  inclusions: ["两种方案的推理成本", "各自的失败模式"],
  exclusions: ["具体厂商定价"],
  audience: "需要做技术选型的工程负责人",
  answerCriteria: "能说清在什么预算与延迟约束下各自更划算",
};

const VALUE_QUESTIONS = [
  { text: "长上下文的推理成本如何随上下文长度变化？", priority: "critical", boundaryNote: "查到可量化的每千 token 成本为止" },
  { text: "RAG 的检索与重排开销有多大？", priority: "normal", boundaryNote: "查到公开基准的检索延迟为止" },
  { text: "两者在失败模式上有什么差别？", priority: "normal", boundaryNote: "查到可复现的失败案例为止" },
];

const VALUE_APPROVAL = {
  approvedAt: 1_700_000_000_000,
  conversationRef: "conversation-1",
};

async function withApplication(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-research-scope-"));
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
  const application = createResearchApplication({
    feature,
    turns: { openTurn: async () => ({ status: "unavailable", reason: "not_configured" }) },
    finalization: {
      finalize: async () => ({ status: "unavailable", reason: "not_configured" }),
      recordCitationChecks: async () => undefined,
    },
    readiness: async () => ({ search: { available: true } }),
    now: () => clock,
  });
  try {
    await run({ application, feature, advance: (ms) => { clock += ms; } });
  } finally {
    await feature.release();
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** 收集一次 reject 的结构化缺失字段清单（field 路径集合）。 */
async function missingFieldsOf(application, payload) {
  try {
    await application.start(payload);
  } catch (error) {
    assert.ok(error instanceof ResearchScopeGateError, `期望范围门拒绝，得到 ${String(error)}`);
    return new Set(error.failures.map((failure) => failure.field));
  }
  throw new Error("期望 start 被范围门拒绝");
}

test("research scope gate reports every missing field and creates no task", async () => {
  await withApplication(async ({ application, feature }) => {
    // 目标非平凡（空）+ 问题数越界（2 个）+ 其中一个问题缺 boundary_note
    //   + 排除项为空 + answer_criteria 缺失 → 五条独立缺失都必须出现。
    const missing = await missingFieldsOf(application, {
      brief: { ...VALUE_BRIEF, objective: "   ", exclusions: [], answerCriteria: "" },
      questions: [
        { text: "第一个问题", priority: "critical", boundaryNote: "边界一" },
        { text: "第二个问题", priority: "normal", boundaryNote: "" },
      ],
      approval: VALUE_APPROVAL,
    });
    assert.deepEqual([...missing].sort(), [
      "brief.answerCriteria",
      "brief.exclusions",
      "brief.objective",
      "questions",
      "questions[1].boundaryNote",
    ]);

    // 拒绝即未入队：队列里一个任务都没有（不是「建了再失败」）。
    const tasks = await feature.queries.summaryList({ limit: 50 });
    assert.equal(tasks.length, 0);
  });
});

test("research scope gate refuses to create a task without an approval", async () => {
  await withApplication(async ({ application, feature }) => {
    // 结构完全合规、唯独没有 approval：范围卡是唯一启动路径，不存在免确认入口。
    const missing = await missingFieldsOf(application, {
      brief: VALUE_BRIEF,
      questions: VALUE_QUESTIONS,
    });
    assert.deepEqual([...missing].sort(), ["approval"]);

    const tasks = await feature.queries.summaryList({ limit: 50 });
    assert.equal(tasks.length, 0);
  });
});

test("research start lands brief, scope approval and the initial question tree in order", async () => {
  await withApplication(async ({ application, feature }) => {
    const started = await application.start({
      brief: VALUE_BRIEF,
      questions: VALUE_QUESTIONS,
      approval: VALUE_APPROVAL,
    });
    const detail = await feature.queries.detail(started.taskId);
    assert.equal(detail?.task.status, "queued");
    assert.equal(detail?.task.briefId, `${started.taskId}:brief`);

    const ledger = await feature.queries.ledger(started.taskId);
    assert.equal(ledger?.brief?.objective, VALUE_BRIEF.objective);
    // scopeApproval 是可审计事实：哈希由框架计算，时间与会话引用来自用户点击。
    const approval = detail?.task.scopeApproval;
    assert.equal(approval?.conversationRef, "conversation-1");
    assert.equal(approval?.approvedAt, VALUE_APPROVAL.approvedAt);
    assert.match(approval?.payloadHash ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(ledger?.questions.length, VALUE_QUESTIONS.length);
    for (const question of ledger?.questions ?? []) {
      assert.equal(question.origin.kind, "brief");
      assert.equal(question.status, "open");
      assert.ok(question.boundaryNote.length > 0);
    }

    // 调用方自述的哈希必须与框架计算值一致，否则拒绝（客户端自述不构成审计事实）。
    const wrong = await missingFieldsOf(application, {
      brief: VALUE_BRIEF,
      questions: VALUE_QUESTIONS,
      approval: { ...VALUE_APPROVAL, payloadHash: "0".repeat(64) },
    });
    assert.deepEqual([...wrong], ["approval.payloadHash"]);
  });
});
