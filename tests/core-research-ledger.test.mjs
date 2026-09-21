import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  ResearchError,
  createResearchFeature,
  createSqliteResearchRepository,
} from "../dist/app/research/index.js";

/**
 * 研究账本（ADR 0001 §2.1 / 设计草案 §6）的最小不变量验证。
 *
 * 按 AGENTS.md 规则 11，只保护长期必须成立的结构事实：
 * 1. Conflict 单边证据必须被拒：双边各绑定 ≥2 个不同来源的 Evidence 才能建成 Conflict，
 *    只有一边有证据的只能记为 Gap(possible_counterevidence)；
 * 2. 重复 finishTask 不覆盖已有终态（报告与 completion 同事务落账）；recoverInterrupted
 *    只把 running 残留标记 interrupted，绝不自动重放；
 * 3. access_level 只能由框架路径写入：证据草稿夹带读取深度一律拒绝，
 *    快照写入时从来源行派生；
 * 4. research_apply_observations（设计草案 §7.2 主批量写入入口）的三个 update 段
 *    必须可用且原子：一次批量是一个状态变更，段内重复更新按刚落库状态校验，
 *    非法迁移（如终态 withdrawn→supported）整批拒绝且不落任何数据。
 *
 * 第 4 条是 reviewer round 1 授权的回归测试：该入口坏着时前三条全绿具有误导性，
 *    批量结果契约（基实体形状，不含读取派生字段）正属于数据不变量。
 */

async function withFeature(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-research-ledger-"));
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

const brief = {
  objective: "判断两种方案的适用条件",
  inclusions: ["成本结构", "失败模式"],
  exclusions: ["具体采购建议"],
  audience: "技术决策者",
  answerCriteria: "两种方案各自的适用条件都有证据支撑",
};

const approval = {
  payloadHash: "sha256:scope-payload",
  approvedAt: 1_000,
  conversationRef: "conversation-1",
};

const questionDraft = (overrides = {}) => ({
  text: "长上下文的成本结构如何？",
  boundaryNote: "只看推理成本，不看训练成本",
  priority: "critical",
  origin: { kind: "brief", scopeBasis: "批准范围：目标与纳入项" },
  ...overrides,
});

const evidenceDraft = (sourceId, questionId, excerpt = "来源原文摘录") => ({
  sourceId,
  questionIds: [questionId],
  excerpt,
  locator: "第 2 节第 1 段",
  extractedClaim: "摘录支持的论断",
  stance: "supports",
});

const isInvalidInput = (error) =>
  error instanceof ResearchError && error.code === "research_invalid_input";

test("research conflict requires two-sided evidence from distinct sources", async () => {
  await withFeature(async ({ feature }) => {
    const task = await feature.commands.createTask({ question: "长上下文与 RAG 各自适合什么？" });
    await feature.commands.approveScope({ taskId: task.id, approval, brief });

    const [question] = await feature.commands.appendQuestions({
      taskId: task.id,
      questions: [questionDraft()],
    });
    assert.equal(question?.status, "open");

    const sources = await feature.commands.appendSourceEntries({
      taskId: task.id,
      drafts: [
        { title: "来源一", url: "https://a.example.com/1", snippet: "摘要一" },
        { title: "来源二", url: "https://b.example.com/2", snippet: "摘要二" },
        { title: "来源三", url: "https://c.example.com/3", snippet: "摘要三" },
        { title: "来源四", url: "https://d.example.com/4", snippet: "摘要四" },
      ],
    });
    assert.equal(sources.length, 4);

    const evidence = await feature.commands.appendEvidenceItems({
      taskId: task.id,
      items: [
        evidenceDraft(sources[0].id, question.id),
        evidenceDraft(sources[1].id, question.id),
        evidenceDraft(sources[2].id, question.id, "来源三的摘录"),
        evidenceDraft(sources[2].id, question.id, "来源三的另一段摘录"),
        evidenceDraft(sources[3].id, question.id, "来源四的摘录"),
      ],
    });
    assert.equal(evidence.length, 5);
    const [e1, e2, e3, e3b, e4] = evidence.map((item) => item.id);

    const claims = await feature.commands.appendClaims({
      taskId: task.id,
      claims: [
        { text: "长上下文在短上下文任务上更贵", type: "sourced", evidenceIds: [e1] },
        { text: "长上下文在长上下文任务上更省", type: "sourced", evidenceIds: [e3] },
      ],
    });
    const [claimA, claimB] = claims.map((claim) => claim.id);
    const base = {
      questionIds: [question.id],
      claimAId: claimA,
      claimBId: claimB,
      nature: "factual",
    };

    // 单边（B 边没有证据）：一律拒绝，且不落库。
    await assert.rejects(
      () => feature.commands.createConflict({
        taskId: task.id,
        conflict: { ...base, evidenceAIds: [e1, e2], evidenceBIds: [] },
      }),
      isInvalidInput,
    );
    // 单边（B 边只有 1 条证据）：拒绝。
    await assert.rejects(
      () => feature.commands.createConflict({
        taskId: task.id,
        conflict: { ...base, evidenceAIds: [e1, e2], evidenceBIds: [e3] },
      }),
      isInvalidInput,
    );
    // 双边各有 2 条但 B 边来自同一来源：拒绝（必须 ≥2 个不同来源）。
    await assert.rejects(
      () => feature.commands.createConflict({
        taskId: task.id,
        conflict: { ...base, evidenceAIds: [e1, e2], evidenceBIds: [e3, e3b] },
      }),
      isInvalidInput,
    );
    // 引用不存在的证据：拒绝。
    await assert.rejects(
      () => feature.commands.createConflict({
        taskId: task.id,
        conflict: { ...base, evidenceAIds: [e1, `${task.id}:e999`], evidenceBIds: [e3, e4] },
      }),
      isInvalidInput,
    );
    const rejectedLedger = await feature.queries.ledger(task.id);
    assert.equal(rejectedLedger?.conflicts.length, 0);

    // 双边各 ≥2 个不同来源的 Evidence：建成并持久化。
    const conflict = await feature.commands.createConflict({
      taskId: task.id,
      conflict: { ...base, evidenceAIds: [e1, e2], evidenceBIds: [e3, e4] },
    });
    assert.equal(conflict.status, "unresolved");
    const ledger = await feature.queries.ledger(task.id);
    assert.equal(ledger?.conflicts.length, 1);
    assert.deepEqual(ledger?.conflicts[0]?.evidenceAIds, [e1, e2]);
    assert.deepEqual(ledger?.conflicts[0]?.evidenceBIds, [e3, e4]);
  });
});

test("research finish is idempotent and recovery only marks interrupted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-research-ledger-finish-"));
  const filePath = path.join(dir, "synech.sqlite3");
  const database = new SqliteRuntimeDatabase(filePath);
  let sequence = 0;
  const feature = createResearchFeature({
    repository: createSqliteResearchRepository(database),
    now: () => 1_000,
    idFactory: (prefix) => `${prefix}-${++sequence}`,
  });
  try {
    const task = await feature.commands.createTask({ question: "长上下文与 RAG 各自适合什么？" });
    await feature.commands.approveScope({ taskId: task.id, approval, brief });
    await feature.commands.claimNextQueued({ startedAt: 2_000 });

    const [question] = await feature.commands.appendQuestions({
      taskId: task.id,
      questions: [questionDraft()],
    });
    const [source] = await feature.commands.appendSourceEntries({
      taskId: task.id,
      drafts: [{ title: "来源一", url: "https://a.example.com/1", snippet: "摘要一" }],
    });
    const [evidence] = await feature.commands.appendEvidenceItems({
      taskId: task.id,
      items: [evidenceDraft(source.id, question.id)],
    });
    const [claim] = await feature.commands.appendClaims({
      taskId: task.id,
      claims: [{ text: "长上下文改变成本结构", type: "sourced", evidenceIds: [evidence.id] }],
    });

    // 报告（Report+ReportSpan）与终态、completion 同事务落账。
    const finished = await feature.commands.finishTask({
      id: task.id,
      status: "completed",
      reportTitle: "研究报告",
      completion: "normal",
      usage: usage(),
      report: {
        title: "结构化报告",
        spans: [{
          text: "来源显示长上下文改变成本结构。",
          claimIds: [claim.id],
          attributionType: "source_statement",
          citationSourceIds: [source.id],
        }],
      },
    });
    assert.equal(finished?.status, "completed");
    assert.equal(finished?.completion, "normal");

    // 重复提交是空操作：终态、报告与 completion 都不被覆盖。
    const replayed = await feature.commands.finishTask({
      id: task.id,
      status: "failed",
      errorCode: "late_write",
      errorMessage: "迟到的写入",
      completion: "incomplete",
      reason: "provider_unavailable",
      usage: usage({ modelRequests: 99 }),
    });
    assert.equal(replayed, undefined);
    const detail = await feature.queries.detail(task.id);
    assert.equal(detail?.task.status, "completed");
    assert.equal(detail?.task.completion, "normal");
    assert.equal(detail?.task.reason, null);
    assert.equal(detail?.task.reportTitle, "研究报告");
    assert.equal(detail?.task.usage.modelRequests, 2);
    const ledger = await feature.queries.ledger(task.id);
    assert.equal(ledger?.report?.title, "结构化报告");
    assert.equal(ledger?.report?.spans.length, 1);
    assert.deepEqual(ledger?.report?.spans[0]?.claimIds, [claim.id]);
    assert.equal(ledger?.report?.spans[0]?.attributionType, "source_statement");

    // running 残留：重启只标记 interrupted，不自动重放。
    const second = await feature.commands.createTask({ question: "另一个问题" });
    await feature.commands.claimNextQueued({ startedAt: 3_000 });
    await feature.release();
    database.close();

    const reopenedDatabase = new SqliteRuntimeDatabase(filePath);
    let reopenedSequence = 0;
    const reopened = createResearchFeature({
      repository: createSqliteResearchRepository(reopenedDatabase),
      now: () => 4_000,
      idFactory: (prefix) => `${prefix}-reopened-${++reopenedSequence}`,
    });
    try {
      const recovered = await reopened.ready();
      assert.equal(recovered, 1);
      const recoveredDetail = await reopened.queries.detail(second.id);
      assert.equal(recoveredDetail?.task.status, "interrupted");
      assert.equal(recoveredDetail?.task.errorCode, "research_interrupted");
      assert.equal(recoveredDetail?.task.endedAt, 4_000);
      // 恢复后队列为空：终态任务不会被再次领取，中断任务不自动重放。
      assert.equal(await reopened.commands.claimNextQueued({ startedAt: 5_000 }), undefined);
    } finally {
      await reopened.release();
      reopenedDatabase.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("research access level can only be written by the framework fetch path", async () => {
  await withFeature(async ({ feature }) => {
    const task = await feature.commands.createTask({ question: "长上下文与 RAG 各自适合什么？" });
    await feature.commands.approveScope({ taskId: task.id, approval, brief });
    const [question] = await feature.commands.appendQuestions({
      taskId: task.id,
      questions: [questionDraft()],
    });

    // 框架入列来源：读取深度按真实抓取结果给值（检索结果只有摘要 → snippet）。
    const [source] = await feature.commands.appendSourceEntries({
      taskId: task.id,
      drafts: [{ title: "来源一", url: "https://a.example.com/1", snippet: "摘要一" }],
    });
    assert.equal(source?.accessLevel, "snippet");

    // 模型输入无法直接设定 access_level：证据草稿夹带该字段一律拒绝。
    await assert.rejects(
      () => feature.commands.appendEvidenceItems({
        taskId: task.id,
        items: [{ ...evidenceDraft(source.id, question.id), accessLevel: "fulltext" }],
      }),
      isInvalidInput,
    );
    await assert.rejects(
      () => feature.commands.appendEvidenceItems({
        taskId: task.id,
        items: [{ ...evidenceDraft(source.id, question.id), accessLevelSnapshot: "fulltext" }],
      }),
      isInvalidInput,
    );

    // 合法证据的快照写入时从来源行派生，不采信模型输入。
    const [evidence] = await feature.commands.appendEvidenceItems({
      taskId: task.id,
      items: [evidenceDraft(source.id, question.id)],
    });
    assert.equal(evidence?.accessLevelSnapshot, "snippet");

    // 框架抓取路径升级读取深度后，新证据的快照跟随来源行。
    await feature.commands.markSourceAccess({
      taskId: task.id,
      sourceId: source.id,
      accessLevel: "fulltext",
      contentHash: "sha256:content",
    });
    const [later] = await feature.commands.appendEvidenceItems({
      taskId: task.id,
      items: [evidenceDraft(source.id, question.id, "第二段摘录")],
    });
    assert.equal(later?.accessLevelSnapshot, "fulltext");

    const ledger = await feature.queries.ledger(task.id);
    assert.equal(ledger?.sources[0]?.accessLevel, "fulltext");
    assert.equal(ledger?.sources[0]?.contentHash, "sha256:content");
    assert.equal(ledger?.sources[0]?.provenanceStatus, "unchecked");
    // 被拒的夹带字段没有落库：先写的证据快照仍是 snippet。
    assert.equal(ledger?.evidence[0]?.accessLevelSnapshot, "snippet");
    assert.equal(ledger?.evidence[1]?.accessLevelSnapshot, "fulltext");
  });
});

test("research apply observations applies update segments atomically and guards in-batch transitions", async () => {
  await withFeature(async ({ feature }) => {
    const task = await feature.commands.createTask({ question: "长上下文与 RAG 各自适合什么？" });
    await feature.commands.approveScope({ taskId: task.id, approval, brief });

    const questions = await feature.commands.appendQuestions({
      taskId: task.id,
      questions: [
        questionDraft({ text: "长上下文的成本结构如何？" }),
        questionDraft({ text: "检索质量的衰减曲线如何？", priority: "normal" }),
      ],
    });
    const [questionA, questionB] = questions;
    const [source] = await feature.commands.appendSourceEntries({
      taskId: task.id,
      drafts: [{ title: "来源一", url: "https://a.example.com/1", snippet: "摘要一" }],
    });
    const [evidence] = await feature.commands.appendEvidenceItems({
      taskId: task.id,
      items: [evidenceDraft(source.id, questionA.id)],
    });
    const [claim] = await feature.commands.appendClaims({
      taskId: task.id,
      claims: [{ text: "长上下文改变成本结构", type: "sourced", evidenceIds: [evidence.id] }],
    });

    // §7.2 主批量写入入口：questionUpdates / claimUpdates / reopenQuestionIds
    // 三个 update 段一次原子提交（P1 回归：这三段曾对全部输入失败）。
    // 同一实体的多条更新按刚落库状态逐条校验：open→investigating→covered 合法，
    // open→covered 一步跳过不在状态机内。
    const result = await feature.commands.applyObservations({
      taskId: task.id,
      batch: {
        questionUpdates: [
          { questionId: questionA.id, status: "investigating" },
          { questionId: questionA.id, status: "covered" },
          { questionId: questionB.id, status: "investigating" },
          { questionId: questionB.id, status: "blocked", boundaryNote: "缺少可引用来源" },
        ],
        claimUpdates: [{ claimId: claim.id, status: "supported" }],
        reopenQuestionIds: [questionA.id],
      },
    });
    // 批量结果返回基实体形状：读取投影的派生字段不属于结果契约。
    for (const question of result.questions) {
      assert.equal("evidenceCount" in question, false);
      assert.equal("evidenceStatus" in question, false);
    }
    for (const updatedClaim of result.claims) {
      assert.equal("evidenceIds" in updatedClaim, false);
    }
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0]?.status, "supported");

    const ledger = await feature.queries.ledger(task.id);
    const readA = ledger?.questions.find((question) => question.id === questionA.id);
    const readB = ledger?.questions.find((question) => question.id === questionB.id);
    // covered 被 reopen 回 investigating，且计数 +1。
    assert.equal(readA?.status, "investigating");
    assert.equal(readA?.reopenedCount, 1);
    assert.equal(readB?.status, "blocked");
    assert.equal(readB?.boundaryNote, "缺少可引用来源");
    assert.equal(ledger?.claims[0]?.status, "supported");

    // 段内重复 id 的第二次更新按刚落库状态校验：withdrawn 是终态，不得被复活。
    await assert.rejects(
      () => feature.commands.applyObservations({
        taskId: task.id,
        batch: {
          claimUpdates: [
            { claimId: claim.id, status: "withdrawn" },
            { claimId: claim.id, status: "supported" },
          ],
        },
      }),
      isInvalidInput,
    );
    // 同理：abandoned→covered 不在状态机内，一步跳到不可达状态必须被拒。
    await assert.rejects(
      () => feature.commands.applyObservations({
        taskId: task.id,
        batch: {
          questionUpdates: [
            { questionId: questionA.id, status: "abandoned" },
            { questionId: questionA.id, status: "covered" },
          ],
        },
      }),
      isInvalidInput,
    );

    // 整批拒绝不落任何数据：非法批量的第一条合法更新也不得残留。
    const afterRejects = await feature.queries.ledger(task.id);
    assert.equal(afterRejects?.claims[0]?.status, "supported");
    assert.equal(afterRejects?.claims[0]?.status === "withdrawn", false);
    assert.equal(afterRejects?.questions.find((question) => question.id === questionA.id)?.status, "investigating");
    assert.equal(afterRejects?.questions.find((question) => question.id === questionA.id)?.reopenedCount, 1);
  });
});
