import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { createResearchApplication } from "../dist/app/application/research-application.js";
import { createResearchFeature, createSqliteResearchRepository } from "../dist/app/research/index.js";
import { RESEARCH_POLICY } from "../dist/app/research/index.js";
import { ToolRegistry } from "../dist/app/tool-center/tool-registry.js";
import { createResearchLoopTools } from "../dist/app/panel-server/research/research-loop-tools.js";

/**
 * turn 驱动执行层（ADR 0001 §2.3 / §2.4）的高风险最小集（按 AGENTS.md 规则 11）。
 *
 * 只保护长期必须成立的事实；每一类失败都会让用户拿到错误的终态或丢账本：
 * 1. 终态收敛——propose_stop 已落账 → 成稿（completion=normal）；
 * 2. 天花板收敛——墙钟 reserve 到线 → FORCED_FINALIZING（completion=forced + ceilingHit）；
 * 3. 取消收敛——用户取消/中止信号 → cancelled（不产出报告）；
 * 4. 配置类模型不可用立即收敛，不烧检索/抓取额度；
 * 5. 启动恢复只标记 interrupted，绝不自动重放（worker/Feature 不变量，随执行层合约保留）。
 *
 * 测试用真实 SQLite 账本 + 真实研究 loop 工具（S3 工具层）+ 脚本化假 loop：
 * 「模型」经工具边界真实调用 research_search / research_propose_stop，执行层的机械判定
 * 因此跑在真实事件与真实账本上，不 mock 存储。
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

async function withHarness(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-research-turn-"));
  const filePath = path.join(dir, "synech.sqlite3");
  const database = new SqliteRuntimeDatabase(filePath);
  let clock = 10_000;
  let sequence = 0;
  const feature = createResearchFeature({
    repository: createSqliteResearchRepository(database),
    now: () => clock,
    idFactory: (prefix) => `${prefix}-${++sequence}`,
  });
  const searchCalls = [];
  const search = {
    search: async ({ query }) => {
      searchCalls.push(query);
      return {
        status: "completed",
        results: [
          { title: `关于 ${query} 的报道`, url: `https://example.com/${encodeURIComponent(query)}`, snippet: `摘要：${query}` },
        ],
      };
    },
  };
  const content = { fetch: async () => ({ status: "failed", code: "unused" }) };

  // 研究自己的工具中心（loop 工具全集，scope=research）——与 composition 同一条装配路径。
  const registry = new ToolRegistry();
  for (const executor of createResearchLoopTools({ feature, search, content })) {
    registry.register({ executor, scopes: ["research"], enabledByDefault: true });
  }
  const toolCenter = registry.createToolCenter("research");
  const allowedTools = toolCenter.list().map((definition) => definition.name);

  const finalizationCalls = [];
  let turnScripts = [];
  let openTurnCount = 0;
  const turns = {
    openTurn: async ({ taskId, signal }) => {
      openTurnCount += 1;
      const script = turnScripts[openTurnCount - 1];
      return {
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
          execute: async (input) => await script({
            input,
            taskId,
            signal,
            callTool: createToolCaller(input.tools),
          }),
          release: async () => undefined,
        },
      };
    },
  };

  const finalization = {
    finalize: async (request) => {
      finalizationCalls.push(request);
      return { status: "completed", title: "研究报告", spans: [] };
    },
  };

  const application = createResearchApplication({
    feature,
    turns,
    finalization,
    readiness: async () => ({ search: { available: true } }),
    now: () => clock,
  });

  const harness = {
    application,
    feature,
    searchCalls,
    finalizationCalls,
    setTurnScripts: (scripts) => { turnScripts = scripts; },
    getOpenTurnCount: () => openTurnCount,
    startTask: async () => (await application.start(SCOPE_INPUT)).taskId,
    advance: (ms) => { clock += ms; },
  };
  try {
    await run(harness);
  } finally {
    await feature.release();
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

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

const completedTurn = (usage = {}) => (async () => ({
  status: "completed",
  finalText: "本轮让出。",
  toolResults: [],
  usage: { requestCount: 1, inputTokens: 10, outputTokens: 20, ...usage },
  confirmationRequests: [],
}));

test("propose_stop 落账后成稿：completion=normal、报告与终态同事务、用量跨 turn 累计", async () => {
  await withHarness(async (harness) => {
    const taskId = await harness.startTask();
    await harness.feature.commands.claimNextQueued({ startedAt: 20_000 });
    const ledger0 = await harness.feature.queries.ledger(taskId);
    const questionId = ledger0.questions[0].id;

    harness.setTurnScripts([
      // 第一轮：真实检索一次（落来源与动作事件），然后让出。
      async ({ callTool }) => {
        const outcome = await callTool("research_search", { query: "长上下文 推理成本", questionRefs: [questionId] });
        assert.equal(outcome.status, "ok");
        return {
          status: "completed",
          finalText: "已检索。",
          toolResults: [],
          usage: { requestCount: 1, inputTokens: 10, outputTokens: 20 },
          confirmationRequests: [],
        };
      },
      // 第二轮：提交停止评估（真实工具落账），然后让出。
      async ({ callTool, input }) => {
        // 模型内容块经 hook 落账（ADR §2.6）：含推理块时 reasoning_available 为真。
        await input.onModelContent?.({ contentIndex: 0, kind: "thinking", phase: "completed", content: "先想一下" });
        await input.onModelContent?.({ contentIndex: 1, kind: "text", phase: "completed", content: "可以收尾了" });
        const outcome = await callTool("research_propose_stop", {
          expectedInformationGain: "low",
          recentSearchYield: "marginal",
          recommendation: "stop",
          reason: "三个问题都已有可用证据，继续检索预期信息量低。",
        });
        assert.equal(outcome.status, "recorded");
        return {
          status: "completed",
          finalText: "请求成稿。",
          toolResults: [],
          usage: { requestCount: 2, inputTokens: 30, outputTokens: 40 },
          confirmationRequests: [],
        };
      },
    ]);

    await harness.application.execute(taskId, new AbortController().signal);

    // 终态收敛：propose_stop 已落账 → 成稿，completion=normal。
    const detail = await harness.feature.queries.detail(taskId);
    assert.equal(detail?.task.status, "completed");
    assert.equal(detail?.task.completion, "normal");
    assert.equal(detail?.task.ceilingHit, null);

    // 成稿经窄 seam 调用；报告与终态同事务（finishTask 的 report 入参）。
    assert.equal(harness.finalizationCalls.length, 1);
    assert.equal(harness.finalizationCalls[0].completion, "normal");
    assert.equal(harness.finalizationCalls[0].ceilingHit, null);
    const ledger = await harness.feature.queries.ledger(taskId);
    assert.equal(ledger?.report?.title, "研究报告");

    // 用量跨 turn 累计：2 次模型请求 + 真实发生的 1 次检索。
    assert.equal(detail?.task.usage.modelRequests, 3);
    assert.equal(detail?.task.usage.searchRequests, 1);
    assert.equal(detail?.task.usage.inputTokens, 40);
    assert.equal(detail?.task.usage.fetchRequests, 0);
    assert.equal(detail?.task.stage, null);

    // 观察面：ResourceState 初始转换与模型内容块落账（reasoning_available）。
    const kinds = ledger.actionEvents.map((event) => event.kind);
    assert.ok(kinds.includes("resource_state_change"));
    assert.ok(kinds.includes("model_content"));
    const modelContent = ledger.actionEvents.find((event) => event.kind === "model_content");
    assert.equal(modelContent.payload.reasoningAvailable, true);
    assert.equal(modelContent.payload.blocks.length, 2);
    const stateChanges = ledger.actionEvents.filter((event) => event.kind === "resource_state_change");
    assert.equal(stateChanges[0].payload.from, null);
    assert.equal(stateChanges[0].payload.to, "normal");
  });
});

test("墙钟 reserve 到线：FORCED_FINALIZING，completion=forced + ceilingHit=wall_clock", async () => {
  await withHarness(async (harness) => {
    const taskId = await harness.startTask();
    await harness.feature.commands.claimNextQueued({ startedAt: 20_000 });
    const ledger0 = await harness.feature.queries.ledger(taskId);
    const questionId = ledger0.questions[0].id;
    const reserveMs = RESEARCH_POLICY.totalBudgetMs * RESEARCH_POLICY.finalizationReserveRatio;

    let midRunModelRequests = null;
    harness.setTurnScripts([
      async ({ callTool }) => {
        await callTool("research_search", { query: "长上下文 推理成本", questionRefs: [questionId] });
        // 时钟推进到 finalization reserve 之内：下一个 turn 边界触发墙钟天花板。
        harness.advance(RESEARCH_POLICY.totalBudgetMs - reserveMs + 1);
        return {
          status: "completed",
          finalText: "本轮让出。",
          toolResults: [],
          usage: { requestCount: 2, inputTokens: 11, outputTokens: 22 },
          confirmationRequests: [],
        };
      },
      async () => {
        // 第二个 turn 不应被打开：天花板到线后禁止新的外部调查与模型调用。
        const detail = await harness.feature.queries.detail(taskId);
        midRunModelRequests = detail?.task.usage.modelRequests ?? null;
        return {
          status: "completed",
          finalText: "不应到达。",
          toolResults: [],
          usage: { requestCount: 9, inputTokens: 9, outputTokens: 9 },
          confirmationRequests: [],
        };
      },
    ]);

    await harness.application.execute(taskId, new AbortController().signal);

    const detail = await harness.feature.queries.detail(taskId);
    assert.equal(detail?.task.status, "completed");
    assert.equal(detail?.task.completion, "forced");
    assert.equal(detail?.task.ceilingHit, "wall_clock");

    // 只打开了一个 turn；第二个脚本从未执行（没有第二次模型调用烧额度）。
    assert.equal(harness.getOpenTurnCount(), 1);
    assert.equal(midRunModelRequests, null);
    assert.equal(detail?.task.usage.modelRequests, 2);

    // 强制收尾经窄 seam 以 forced 调用；账本保留（来源仍在）。
    assert.equal(harness.finalizationCalls.length, 1);
    assert.equal(harness.finalizationCalls[0].completion, "forced");
    assert.equal(harness.finalizationCalls[0].ceilingHit, "wall_clock");
    const ledger = await harness.feature.queries.ledger(taskId);
    assert.ok((ledger?.sources.length ?? 0) >= 1);
    const wallClock = ledger.actionEvents.filter(
      (event) => event.kind === "resource_state_change" && event.payload.to === "finalization_required",
    );
    assert.equal(wallClock.length, 1);
    assert.equal(wallClock[0].payload.reason, "wall_clock_reserve");
  });
});

test("用户取消：turn 边界收敛 cancelled，不产出报告", async () => {
  await withHarness(async (harness) => {
    const taskId = await harness.startTask();
    await harness.feature.commands.claimNextQueued({ startedAt: 20_000 });
    const ledger0 = await harness.feature.queries.ledger(taskId);
    const questionId = ledger0.questions[0].id;

    harness.setTurnScripts([
      async ({ callTool }) => {
        await callTool("research_search", { query: "长上下文 推理成本", questionRefs: [questionId] });
        // 第一轮让出后由用户取消（第二个脚本执行前取消已落标记）。
        await harness.application.cancel(taskId);
        return {
          status: "completed",
          finalText: "本轮让出。",
          toolResults: [],
          usage: { requestCount: 1, inputTokens: 5, outputTokens: 6 },
          confirmationRequests: [],
        };
      },
      completedTurn(),
    ]);

    await harness.application.execute(taskId, new AbortController().signal);

    const detail = await harness.feature.queries.detail(taskId);
    assert.equal(detail?.task.status, "cancelled");
    assert.equal(detail?.task.errorCode, "research_cancelled");
    assert.equal(detail?.task.reportTitle, null);
    assert.equal(harness.finalizationCalls.length, 0);
    assert.equal(harness.getOpenTurnCount(), 1);
  });
});

test("中止信号：在途 turn 返回 cancelled 后收敛 cancelled", async () => {
  await withHarness(async (harness) => {
    const taskId = await harness.startTask();
    await harness.feature.commands.claimNextQueued({ startedAt: 20_000 });
    const controller = new AbortController();

    harness.setTurnScripts([
      async ({ signal }) => {
        // 模拟 worker 的取消轮询：在途调用收到中止信号后 loop 返回 cancelled。
        controller.abort();
        assert.equal(signal.aborted, true);
        return {
          status: "cancelled",
          toolResults: [],
          usage: { requestCount: 1, inputTokens: 0, outputTokens: 0 },
          confirmationRequests: [],
          error: "cancelled",
        };
      },
    ]);

    await harness.application.execute(taskId, controller.signal);

    const detail = await harness.feature.queries.detail(taskId);
    assert.equal(detail?.task.status, "cancelled");
    assert.equal(harness.finalizationCalls.length, 0);
  });
});

test("模型配置类不可用：立即收敛 research_model_unavailable，不烧检索额度", async () => {
  await withHarness(async (harness) => {
    const taskId = await harness.startTask();
    await harness.feature.commands.claimNextQueued({ startedAt: 20_000 });

    // 配置类失败（缺 API Key）在打开第一个 turn 时就暴露：应用层立即如实收敛，
    // 不进入循环、不烧检索/抓取额度、不进入成稿。
    const searchCallsBefore = harness.searchCalls.length;
    const failingTurns = {
      openTurn: async () => ({ status: "unavailable", reason: "model_api_key_missing" }),
    };
    const failingApplication = createResearchApplication({
      feature: harness.feature,
      turns: failingTurns,
      finalization: { finalize: async () => ({ status: "completed", title: "t", spans: [] }) },
      readiness: async () => ({ search: { available: true } }),
      now: () => 10_000,
    });
    await failingApplication.execute(taskId, new AbortController().signal);

    const detail = await harness.feature.queries.detail(taskId);
    assert.equal(detail?.task.status, "failed");
    assert.equal(detail?.task.errorCode, "research_model_unavailable");
    assert.match(detail?.task.errorMessage ?? "", /API Key/u);
    assert.equal(harness.searchCalls.length, searchCallsBefore);
    assert.equal(detail?.task.usage.searchRequests, 0);
    assert.equal(detail?.task.usage.fetchRequests, 0);
    assert.equal(detail?.task.usage.modelRequests, 0);
  });
});

test("启动恢复只标记 interrupted：running 残留不回到队列、不自动重放", async () => {
  await withHarness(async (harness) => {
    const taskId = await harness.startTask();
    await harness.feature.commands.claimNextQueued({ startedAt: 20_000 });
    // 进程在 turn 之间死亡：任务停留在 running（每个 turn 结束时的账本即恢复点）。

    const recovered = await harness.feature.ready();
    assert.equal(recovered, 1);
    const detail = await harness.feature.queries.detail(taskId);
    assert.equal(detail?.task.status, "interrupted");
    assert.equal(detail?.task.errorCode, "research_interrupted");
    // 不自动重放：队列为空，终态任务不会被再次领取。
    assert.equal(await harness.feature.commands.claimNextQueued({ startedAt: 30_000 }), undefined);
  });
});
