import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { createResearchApplication } from "../dist/app/application/research-application.js";
import { createResearchFinalization } from "../dist/app/application/research-finalization.js";
import { createResearchFeature, createSqliteResearchRepository } from "../dist/app/research/index.js";
import { ToolRegistry } from "../dist/app/tool-center/tool-registry.js";
import { createResearchLoopTools } from "../dist/app/panel-server/research/research-loop-tools.js";

/**
 * 成稿接线（S5w）授权的唯一新增测试（AGENTS.md 规则 11 / 任务 (c)）：
 * **Gap 与 Conflict 必须进入成稿输入**。
 *
 * 保护的不变量：成稿提示词的输入是「主张图谱 + 证据卡 + 缺口 + 分歧」四类实体，
 * 不是只有 claim/evidence——若 Gap/Conflict 在成稿输入里被丢掉，「分歧与争议」与
 * 「缺口与限制」两节就没有机制支撑，用户会拿到一份隐去不确定性的报告（ADR 0001 §1
 * 的已确认缺陷之一，Phase 1 起「禁止丢弃 Gap/Conflict」）。
 *
 * 用例跑真实链路：真实 SQLite 账本 + 真实研究 loop 工具 + 真实成稿编排
 * （createResearchFinalization）→ 模型端口是脚本化替身（记录提示词、回合法定输出），
 * 不 mock 存储、不 mock 提示词装配。
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

const GAP_DESCRIPTION = "反方口径的每千 token 成本没有公开量化基准";
const VERIFIER_MARKER = "判断下面的报告段落是否被其主张（claim）的证据支撑。";

/** 经工具边界调用一个研究工具（「模型」动作的真实执行路径）。 */
function createToolCaller(boundary) {
  let n = 0;
  return async (toolName, toolInput) => {
    n += 1;
    const request = { providerCallId: `call-${n}`, invocationId: `inv-${n}`, toolName, input: toolInput };
    const result = await boundary.gateway.execute(request, boundary.context, boundary.permission);
    return result.output;
  };
}

test("成稿输入包含 Gap 与 Conflict 实体（不只 claim/evidence）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-research-finalization-"));
  const filePath = path.join(dir, "synech.sqlite3");
  const database = new SqliteRuntimeDatabase(filePath);
  let clock = 10_000;
  let sequence = 0;
  const feature = createResearchFeature({
    repository: createSqliteResearchRepository(database),
    now: () => clock,
    idFactory: (prefix) => `${prefix}-${++sequence}`,
  });

  const registry = new ToolRegistry();
  for (const executor of createResearchLoopTools({ feature })) {
    registry.register({ executor, scopes: ["research"], enabledByDefault: true });
  }
  const toolCenter = registry.createToolCenter("research");
  const allowedTools = toolCenter.list().map((definition) => definition.name);

  // 模型替身：记录成稿/核验两次不同提示词；成稿回复一份过硬门的六节 JSON。
  const writingCalls = [];
  const verifierCalls = [];
  let reportOutput;
  const model = {
    complete: async (request) => {
      if (request.user.includes(VERIFIER_MARKER)) {
        verifierCalls.push(request);
        return { status: "completed", text: "supports", usage: { inputTokens: 1, outputTokens: 1 } };
      }
      writingCalls.push(request);
      return { status: "completed", text: JSON.stringify(reportOutput()), usage: { inputTokens: 10, outputTokens: 20 } };
    },
  };

  const application = createResearchApplication({
    feature,
    turns: {
      openTurn: async ({ taskId, signal }) => ({
        status: "ready",
        tools: {
          definitions: toolCenter.list(),
          gateway: toolCenter,
          context: {
            callerAgentId: "research",
            traceId: taskId,
            goalId: taskId,
            resourceScope: { ownerKind: "research_task", ownerId: taskId },
            abortSignal: signal,
          },
          permission: { callerAgentId: "research", allowedTools },
        },
        loop: {
          execute: async (executeInput) => {
            // 一个 turn 内提交停止评估：真实工具落账后应用层机械判定进入成稿。
            const callTool = createToolCaller(executeInput.tools);
            const outcome = await callTool("research_propose_stop", {
              expectedInformationGain: "low",
              recentSearchYield: "marginal",
              recommendation: "stop",
              reason: "两类证据已足够支撑结论，剩下的分歧按 Conflict 呈现。",
            });
            assert.equal(outcome.status, "recorded");
            return {
              status: "completed",
              finalText: "请求成稿。",
              toolResults: [],
              usage: { requestCount: 1, inputTokens: 10, outputTokens: 20 },
              confirmationRequests: [],
            };
          },
          release: async () => undefined,
        },
      }),
    },
    finalization: createResearchFinalization({ feature, model, describeVerifierModel: async () => "verify-model" }),
    readiness: async () => ({ search: { available: true } }),
    now: () => clock,
  });

  try {
    const taskId = (await application.start(SCOPE_INPUT)).taskId;
    await feature.commands.claimNextQueued({ startedAt: 20_000 });

    // ---- 造一个含 Gap 与 Conflict 的账本（真实命令，不 mock 存储）----
    const [question] = await feature.commands.appendQuestions({
      taskId,
      questions: [{
        text: "长上下文与 RAG 的成本结构差异有沒有量化基准？",
        boundaryNote: "查到双方可比的量化口径为止",
        priority: "critical",
        origin: { kind: "brief", scopeBasis: "批准范围：纳入项「两种方案的推理成本」" },
      }],
    });
    const sources = await feature.commands.appendSourceEntries({
      taskId,
      drafts: [
        { title: "正方来源", url: "https://a.example.com/1", snippet: "摘要一" },
        { title: "反方来源", url: "https://b.example.com/2", snippet: "摘要二" },
      ],
    });
    for (const source of sources) {
      await feature.commands.markSourceAccess({
        taskId,
        sourceId: source.id,
        accessLevel: "fulltext",
        contentHash: `sha256:content-${source.id}`,
      });
    }
    const evidence = await feature.commands.appendEvidenceItems({
      taskId,
      items: sources.flatMap((source) => ([
        {
          sourceId: source.id,
          questionIds: [question.id],
          excerpt: "长上下文改变成本结构，这是来源原文摘录。",
          locator: "第 2 节第 1 段",
          extractedClaim: "长上下文改变成本结构",
          stance: source === sources[0] ? "supports" : "contradicts",
        },
        {
          sourceId: source.id,
          questionIds: [question.id],
          excerpt: "另一段同样口径的原文摘录。",
          locator: "第 3 节第 2 段",
          extractedClaim: "成本结构随上下文长度变化",
          stance: source === sources[0] ? "supports" : "contradicts",
        },
      ])),
    });
    // Conflict 双边各 2 条、各来自 2 个不同来源的 Evidence（ADR §2.1 结构约束）。
    const [claimA, claimB] = await feature.commands.appendClaims({
      taskId,
      claims: [
        { text: "长上下文改变成本结构", type: "sourced", evidenceIds: [evidence[0].id, evidence[2].id] },
        { text: "RAG 的检索开销主导总成本", type: "sourced", evidenceIds: [evidence[1].id, evidence[3].id] },
      ],
    });
    const [gap] = await feature.commands.appendGaps({
      taskId,
      gaps: [{
        questionId: question.id,
        description: GAP_DESCRIPTION,
        importance: "material",
        origin: "insufficient_evidence",
      }],
    });
    const conflict = await feature.commands.createConflict({
      taskId,
      conflict: {
        questionIds: [question.id],
        claimAId: claimA.id,
        claimBId: claimB.id,
        evidenceAIds: [evidence[0].id, evidence[2].id],
        evidenceBIds: [evidence[1].id, evidence[3].id],
        nature: "factual",
      },
    });
    await feature.commands.applyObservations({
      taskId,
      batch: {
        questionUpdates: [
          { questionId: question.id, status: "investigating" },
          { questionId: question.id, status: "covered" },
        ],
      },
    });

    const sourceIds = sources.map((source) => source.id);
    reportOutput = () => ({
      title: "成本结构对比研究",
      spans: ["summary", "background", "analysis", "conclusions", "disagreements", "limitations"].map((section) => ({
        text: section === "summary"
          ? "两类方案的成本主导项不同，结论依预算与延迟约束而变。"
          : `第 ${section} 节的正文，挂靠同一主张与来源。`,
        claim_ids: [claimA.id],
        attribution_type: "source_statement",
        citation_source_ids: sourceIds,
        section,
      })),
      gap_ids: [gap.id],
      conflict_ids: [conflict.id],
    });

    await application.execute(taskId, new AbortController().signal);

    // ---- 断言 1：成稿提示词输入同时含 Gap 与 Conflict 实体，而不是只有 claim/evidence ----
    assert.equal(writingCalls.length, 1);
    const prompt = writingCalls[0].user;
    // 缺口：实体 id 与描述文字都进入输入（描述是模型写「缺口与限制」一节的依据）。
    assert.ok(prompt.includes(GAP_DESCRIPTION), "成稿输入必须包含 Gap 描述");
    assert.ok(prompt.includes(gap.id), "成稿输入必须包含 Gap 实体 id");
    // 分歧：实体 id 与双方主张进入输入。
    assert.ok(prompt.includes(conflict.id), "成稿输入必须包含 Conflict 实体 id");
    assert.ok(prompt.includes(claimB.text), "成稿输入必须包含 Conflict 的乙方主张");
    // 对照：主张与证据同样在输入里——四类实体同级进入，缺一类即回归。
    assert.ok(prompt.includes(claimA.text), "成稿输入必须包含 Claim 文本");
    assert.ok(prompt.includes(evidence[0].excerpt), "成稿输入必须包含 Evidence 摘录");
    // 输入不是全量正文堆砌：不注入过程统计（ADR §2.4 不为过程状态生成说明文字）。
    assert.equal(prompt.includes("检索次数"), false);

    // ---- 断言 2：接线跑通——硬门过后报告与终态同事务写入，抽样核验落账 ----
    const detail = await feature.queries.detail(taskId);
    assert.equal(detail?.task.status, "completed");
    assert.equal(detail?.task.completion, "normal");
    const ledger = await feature.queries.ledger(taskId);
    assert.equal(ledger?.report?.title, "成本结构对比研究");
    assert.equal(ledger?.report?.spans.length, 6);
    assert.equal(ledger?.citationChecks.length, 6);
    for (const check of ledger?.citationChecks ?? []) {
      assert.equal(check.verdict, "supports");
      assert.equal(check.sampled, true);
      assert.equal(check.verifierModel, "verify-model");
      assert.ok((check.verifierInput ?? "").includes(VERIFIER_MARKER));
    }
    // 抽样支撑率进用户可见面（活动流的结构化事件），不进模型上下文。
    const supportRateEvent = (ledger?.actionEvents ?? []).find(
      (event) => event.kind === "ledger_change" && event.payload.change === "citation_support_rate",
    );
    assert.ok(supportRateEvent !== undefined, "抽样支撑率必须落一条结构化事件");
    assert.equal(supportRateEvent.payload.supportRate, 1);
    assert.equal(supportRateEvent.payload.sampled, 6);
    assert.equal(prompt.includes("支撑率"), false);
    assert.equal(verifierCalls.length, 6);
  } finally {
    await feature.release();
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
