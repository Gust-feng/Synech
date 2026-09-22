import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { createResearchApplication } from "../dist/app/application/research-application.js";
import {
  RESEARCH_CONTEXT_SLOTS,
  RESEARCH_PROJECTOR_VERSION,
  projectResearchContext,
} from "../dist/app/application/research-context-projector.js";
import { createResearchFeature, createSqliteResearchRepository } from "../dist/app/research/index.js";

/**
 * ResearchContextProjector 的最小不变量验证（ADR 0001 §2.3 / D6，按 AGENTS.md 规则 11）。
 *
 * 投影器是模型可见内容的唯一 owner，两类失败都是长期的：
 * 1. **确定性**：同一账本状态两次投影逐字节相同——装配点不稳定会让「模型看到什么」
 *    变成不可复现的暗变量；
 * 2. **永不进入清单**：预算数字、usage 总量、其他任务数据、压缩前 transcript、
 *    检索排名作为权威信号、UI 展示字符串不得出现在投影输出中——泄漏即架构越界。
 *
 * 附带保护可复现性：投影记录投影器版本与输入实体 ID（同版本同实体可重放同一投影）。
 */

const SCOPE_INPUT = {
  brief: {
    objective: "判断长上下文与 RAG 在成本结构上的适用条件",
    inclusions: ["两种方案的推理成本", "各自的失败模式"],
    exclusions: ["具体厂商定价"],
    audience: "需要做技术选型的工程负责人",
    answerCriteria: "能说清在什么预算与延迟约束下各自更划算",
  },
  questions: [
    { text: "长上下文的推理成本如何随上下文长度变化？", priority: "critical", boundaryNote: "查到可量化的每千 token 成本为止" },
    { text: "RAG 的检索与重排开销有多大？", priority: "normal", boundaryNote: "查到公开基准的检索延迟为止" },
    { text: "两者在失败模式上有什么差别？", priority: "normal", boundaryNote: "查到可复现的失败案例为止" },
  ],
  approval: { approvedAt: 1_700_000_000_000, conversationRef: "conversation-1" },
};

const OTHER_TASK_MARK = "只属于另一个研究任务的独特文本标记";

async function withLedger(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-research-projector-"));
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
    turns: { openTurn: async () => ({ status: "unavailable", reason: "unused" }) },
    finalization: {
      finalize: async () => ({ status: "unavailable", reason: "unused" }),
      recordCitationChecks: async () => undefined,
    },
    readiness: async () => ({ search: { available: true } }),
    now: () => clock,
  });
  try {
    await run({ application, feature, repository, advance: (ms) => { clock += ms; } });
  } finally {
    await feature.release();
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** 构造一份有内容的账本：brief + 问题树 + 来源 + 证据 + 主张 + 缺口 + 检查点 + 停止评估。 */
async function buildLedger(feature) {
  const started = await feature.commands.createTask({ question: SCOPE_INPUT.brief.objective });
  const taskId = started.id;
  await feature.commands.approveScope({
    taskId,
    approval: {
      payloadHash: "sha256:scope-payload",
      approvedAt: 1_000,
      conversationRef: "conversation-1",
    },
    brief: SCOPE_INPUT.brief,
  });
  const questions = await feature.commands.appendQuestions({
    taskId,
    questions: SCOPE_INPUT.questions.map((question) => ({
      text: question.text,
      priority: question.priority,
      boundaryNote: question.boundaryNote,
      origin: { kind: "brief", scopeBasis: "批准范围：目标与纳入项" },
    })),
  });
  const sources = await feature.commands.appendSourceEntries({
    taskId,
    drafts: [
      { title: "长上下文成本分析", url: "https://example.com/cost", snippet: "推理成本随上下文长度显著上升" },
      { title: "RAG 基准测试", url: "https://example.com/rag-bench", snippet: "检索与重排开销有公开基准" },
    ],
  });
  const applied = await feature.commands.applyObservations({
    taskId,
    batch: {
      questionUpdates: [{ questionId: questions[0].id, status: "investigating" }],
      evidenceItems: [
        {
          sourceId: sources[0].id,
          questionIds: [questions[0].id],
          excerpt: "每千 token 成本随长度上升约一个数量级",
          locator: "第 3 节第 2 段",
          extractedClaim: "长上下文推理成本随长度显著上升",
          stance: "supports",
        },
        {
          sourceId: sources[1].id,
          questionIds: [questions[1].id],
          excerpt: "公开基准给出检索延迟中位数",
          locator: "基准表第 1 行",
          extractedClaim: "RAG 检索开销有公开基准可查",
          stance: "qualifies",
        },
      ],
      newGaps: [{
        questionId: questions[2].id,
        description: "缺少可复现的失败案例对比",
        importance: "material",
        origin: "insufficient_evidence",
      }],
    },
  });
  const claims = await feature.commands.appendClaims({
    taskId,
    claims: [{
      text: "两种方案的成本结构差异主要来自上下文长度与检索频次",
      type: "synthesis",
      status: "provisional",
      evidenceIds: applied.evidenceItems.map((item) => item.id),
    }],
  });
  await feature.commands.appendActionEvents({
    taskId,
    events: [
      {
        kind: "checkpoint_summary",
        payload: {
          version: 1,
          text: "已确认成本结构差异的两个来源，失败模式待补。",
          retainedClaimIds: claims.map((claim) => claim.id),
          retainedGapIds: [],
          retainedConflictIds: [],
          sourceIds: sources.map((source) => source.id),
          supersedesCheckpointId: null,
        },
      },
      {
        kind: "tool_result",
        payload: {
          version: 1,
          tool: "research_propose_stop",
          assessment: {
            unresolvedCriticalQuestionIds: [questions[0].id],
            unresolvedGapIds: [],
            unresolvedConflictIds: [],
            strongestConclusionAtRisk: "成本结构差异可能被基准条件抵消",
            nextBestAction: null,
            expectedInformationGain: "low",
            recentSearchYield: "marginal",
            recommendation: "continue",
            reason: "失败模式还缺一个可复现案例。",
          },
          recordedAt: 5_000,
        },
      },
    ],
  });
  return { taskId, questions, sources, evidence: applied.evidenceItems, claims };
}

test("同一账本状态两次投影逐字节相同，且记录投影器版本与输入实体 ID", async () => {
  await withLedger(async ({ feature }) => {
    const built = await buildLedger(feature);
    const ledger = await feature.queries.ledger(built.taskId);
    assert.ok(ledger !== undefined);

    const first = projectResearchContext({ ledger, resourceState: "normal" });
    const second = projectResearchContext({ ledger, resourceState: "normal" });

    // 确定性：同状态两次投影逐字节相同（含 instructions 与槽位表）。
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.stateMessage, second.stateMessage);
    assert.equal(JSON.stringify(first.slots), JSON.stringify(second.slots));

    // 可复现：版本 + 输入实体 ID 齐全，且与账本一致。
    assert.equal(first.projectorVersion, RESEARCH_PROJECTOR_VERSION);
    assert.deepEqual(first.inputEntityIds.questionIds, built.questions.map((question) => question.id));
    assert.deepEqual(first.inputEntityIds.evidenceIds, built.evidence.map((item) => item.id));
    assert.deepEqual(first.inputEntityIds.claimIds, built.claims.map((claim) => claim.id));
    assert.deepEqual(first.inputEntityIds.sourceIds, built.sources.map((source) => source.id));
    assert.notEqual(first.inputEntityIds.checkpointEventId, null);
    assert.notEqual(first.inputEntityIds.stopAssessmentEventId, null);

    // 槽位覆盖：brief / 问题树 / 缺口 / 资源状态 / 检查点 / 停止评估都装配了。
    const included = new Set(first.slots.filter((slot) => slot.included).map((slot) => slot.id));
    for (const id of [
      "brief",
      "question_topology",
      "resource_state",
      "latest_checkpoint",
      "current_stop_assessment",
      "active_question_claims",
      "active_question_evidence_cards",
    ]) {
      assert.ok(included.has(id), `槽位 ${id} 应出现在投影中`);
    }
    // 状态消息包含关键注册槽位内容。
    assert.match(first.stateMessage, /研究范围（用户已批准，不可变更）/u);
    assert.match(first.stateMessage, /答够标准/u);
    assert.match(first.stateMessage, /【问题树（未决）】/u);
    assert.match(first.stateMessage, /【未解决的缺口】/u);
    assert.match(first.stateMessage, /【资源状态】/u);
    assert.match(first.stateMessage, /normal：外部调查可按语义需要继续。/u);
  });
});

test("永不进入清单逐条落实：禁止项不出现，且都有注册在案的 never_enter 槽位", async () => {
  await withLedger(async ({ feature }) => {
    const built = await buildLedger(feature);

    // 另一个任务的数据（其他任务数据禁止项的反证材料）。
    const other = await feature.commands.createTask({ question: OTHER_TASK_MARK });
    await feature.commands.appendSourceEntries({
      taskId: other.id,
      drafts: [{ title: OTHER_TASK_MARK, url: `https://example.com/${encodeURIComponent(OTHER_TASK_MARK)}`, snippet: OTHER_TASK_MARK }],
    });

    const ledger = await feature.queries.ledger(built.taskId);
    const projection = projectResearchContext({ ledger, resourceState: "finalization_required" });
    // 模型实际可见面只有 instructions + stateMessage；槽位注册表是可复现审计记录。
    const modelVisible = JSON.stringify({
      instructions: projection.instructions,
      stateMessage: projection.stateMessage,
    });

    // 预算数值与 usage 总量的字段名不得出现（UsageEvent / ResearchUsage / ModelUsage）。
    for (const forbiddenField of [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "requestCount",
      "modelRequests",
      "searchRequests",
      "fetchRequests",
      "elapsedMs",
      "estimatedCostUsd",
    ]) {
      assert.ok(!modelVisible.includes(forbiddenField), `模型可见内容不得包含用量字段 ${forbiddenField}`);
    }
    // 其他任务数据不得出现。
    assert.ok(!modelVisible.includes(OTHER_TASK_MARK), "模型可见内容不得包含其他任务的数据");
    // 检索排名/热度不作为权威信号：来源面只暴露框架事实字段。
    assert.ok(!modelVisible.includes("rank"), "模型可见内容不得包含检索排名字段");
    // 压缩前 transcript 不重放：模型可见内容不含 transcript 形状。
    assert.ok(!modelVisible.includes("transcript"), "模型可见内容不得包含 transcript 内容");

    // 六条禁止项都在槽位注册表里注册在案（never_enter），且本次投影都没有装配。
    const neverEnter = RESEARCH_CONTEXT_SLOTS.filter((slot) => slot.slotClass === "never_enter");
    assert.deepEqual(
      neverEnter.map((slot) => slot.id).sort(),
      [
        "never_enter.exact_budget",
        "never_enter.other_tasks_data",
        "never_enter.pre_compaction_transcript",
        "never_enter.retrieval_rank_as_authority",
        "never_enter.ui_display_strings",
        "never_enter.usage_totals",
      ],
    );
    for (const slot of neverEnter) {
      const projected = projection.slots.find((item) => item.id === slot.id);
      assert.equal(projected?.included, false, `禁止项 ${slot.id} 不得被装配`);
    }
  });
});

test("槽位注册表声明完整：每项都有 id/source/inclusion/purpose/forbidden_uses 与分类", async () => {
  for (const slot of RESEARCH_CONTEXT_SLOTS) {
    assert.ok(slot.id.length > 0);
    assert.ok(slot.source.length > 0);
    assert.ok(["always", "per_active_question", "by_id", "never"].includes(slot.inclusion));
    assert.ok(["model_produced", "framework_structure", "never_enter"].includes(slot.slotClass));
    assert.ok(slot.purpose.length > 0);
    assert.ok(slot.forbiddenUses.length > 0, `槽位 ${slot.id} 必须声明 forbidden_uses`);
  }
  // 槽位 ID 唯一。
  const ids = RESEARCH_CONTEXT_SLOTS.map((slot) => slot.id);
  assert.equal(new Set(ids).size, ids.length);
});
