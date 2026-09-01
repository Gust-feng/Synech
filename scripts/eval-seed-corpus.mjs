#!/usr/bin/env node
/**
 * Eval seed corpus generator (T8) — synthetic conversations + labeled queries
 * used ONLY to validate the offline evaluation toolchain (T9–T11) and to
 * pre-calibrate parameters before real usage data exists.
 *
 * 用户决策（沟通笔记 §5 项 3，方案 c）：种子语料不用于"是否推进复杂度"的硬门
 * 判断；正式 corpus 必须来自真实使用数据并单独冻结。输出目录与真实导出
 * （eval-export-corpus.mjs）分离。
 *
 * 场景覆盖（《手册》17.2 八类）：decision_reversal / rename_continuity /
 * open_loop_completion / old_decision_recall / stable_preference /
 * unanswerable / cross_space_negative / post_clear。
 *
 * Usage: node scripts/eval-seed-corpus.mjs [--home <ProductHome>] [--out <dir>]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SPACES = [
  { id: "seed-space-a", title: "电商后台重构" },
  { id: "seed-space-b", title: "官网改版" },
  { id: "seed-space-c", title: "数据管道" },
];

const BASE_TIME = Date.parse("2026-08-01T09:00:00+08:00");
const MINUTE = 60_000;

/** 每条 = 一个 run（一轮问答）；ordinal 按数组顺序 1..N。 */
const CONVERSATIONS = [
  {
    id: "seed-a1", spaceId: "seed-space-a", title: "网关选型（GraphQL→REST）",
    turns: [
      { user: "我们的后台 API 网关要重做，你觉得 GraphQL 和 REST 怎么选？", assistant: "两者都可行：GraphQL 适合多端聚合查询、前端取数灵活；REST 更简单、缓存成熟。需要结合团队经验和现有网关能力再定。" },
      { user: "那就定 GraphQL，前端可以少写很多聚合层。", assistant: "已确定：后台网关采用 GraphQL，客户端用单一 endpoint 聚合查询，减少前端聚合层代码。" },
      { user: "刚了解到网关团队只维护 REST 中间件，而且现有鉴权插件都是 REST 的，GraphQL 接入成本比想象高。", assistant: "新约束：网关团队维护能力与现有鉴权插件都绑定 REST；GraphQL 需要自建鉴权中间件，接入成本显著上升。" },
      { user: "那撤回 GraphQL 的决定，改回 REST，按资源拆分接口。", assistant: "最终决定：撤回 GraphQL，网关采用 REST 并按资源拆分 endpoint；GraphQL 仅在内部 BFF 层有限试用。原因：网关维护能力与鉴权插件均为 REST 生态。" },
    ],
  },
  {
    id: "seed-a2", spaceId: "seed-space-a", title: "报表中心（飞马→天马）",
    turns: [
      { user: "启动‘飞马’项目：为后台做一个统一的报表中心，先梳理数据来源。", assistant: "‘飞马’项目启动：目标是为后台建立统一报表中心，第一步是盘点各业务线数据来源与口径。" },
      { user: "项目正式改名‘天马’，避免和已有项目重名，其他不变。", assistant: "项目由‘飞马’正式更名为‘天马’，范围不变：统一报表中心，继续盘点数据来源。" },
      { user: "天马的部署方式用容器还是虚机？", assistant: "‘天马’（原‘飞马’，统一报表中心）部署采用容器化：与后台现有 Kubernetes 集群一致，报表服务以无状态 Deployment 部署。" },
      { user: "好，那数据源先用数仓的宽表。", assistant: "‘天马’报表中心数据源确定：优先使用数仓宽表，接口层按需聚合，不直连业务库。" },
    ],
  },
  {
    id: "seed-a3", spaceId: "seed-space-a", title: "导出缓存计划（open loop）",
    turns: [
      { user: "报表导出现在太慢，打算加一层导出缓存，你先记一下这个计划。", assistant: "已记录 open loop：报表导出计划引入导出缓存层，尚未开始实施。" },
      { user: "缓存打算怎么设计？先说思路就行。", assistant: "导出缓存思路：按‘用户+报表参数’生成缓存键，TTL 10 分钟，命中直接回传文件；未命中走原有导出流程。仅是计划，未实施。" },
      { user: "先这样，回头再说。", assistant: "好的。当前待办：导出缓存层保持计划状态（缓存键=用户+报表参数、TTL 10 分钟），未排期。" },
    ],
  },
  {
    id: "seed-a4", spaceId: "seed-space-a", title: "导出缓存实施 + 协作偏好",
    turns: [
      { user: "继续上次的导出缓存，开始实施吧。", assistant: "开始实施导出缓存层：按此前计划，缓存键=用户+报表参数、TTL 10 分钟，命中直接回传文件。" },
      { user: "顺便说下，你以后回答都直接给可运行的代码，不要伪代码。", assistant: "已记下稳定协作偏好：今后回答提供可直接运行的代码而非伪代码。导出缓存实现将附完整代码。" },
      { user: "缓存层做完了，压测命中率 82%。", assistant: "导出缓存层已完成并验证：压测命中率 82%，符合‘用户+报表参数’键设计与 10 分钟 TTL。该 open loop 关闭。" },
      { user: "好，接下来清理临时脚本。", assistant: "导出缓存已收敛。开始清理临时脚本，属于常规维护事项。" },
    ],
  },
  {
    id: "seed-a5", spaceId: "seed-space-a", title: "闲聊与常识问答",
    turns: [
      { user: "今天天气不错啊。", assistant: "是的，适合专注写代码。有什么项目上的事要继续吗？" },
      { user: "React 是哪一年发布的？", assistant: "React 由 Facebook 于 2013 年开源发布。这是公开常识，与本项目无关。" },
      { user: "行。对了，你觉得我们团队中午吃什么好？", assistant: "这个我没有相关记录，帮不上忙。回到项目上的话，报表中心还有下一步可做。" },
    ],
  },
  {
    id: "seed-a6", spaceId: "seed-space-a", title: "图片上传决定（清除模拟素材）",
    turns: [
      { user: "后台的图片上传统一走对象存储，禁止落本地磁盘。", assistant: "已确定：后台图片上传统一接入对象存储，应用不再写本地磁盘；旧本地路径仅作只读迁移源。" },
      { user: "迁移工具用分批校验和的方式。", assistant: "图片迁移工具确定：分批搬运 + 校验和比对；单批失败可重试，不影响其他批次。" },
      { user: "好，记住这个决定就行。", assistant: "已记录现行决定：图片上传统一对象存储 + 分批校验和迁移。" },
    ],
  },
  {
    id: "seed-b1", spaceId: "seed-space-b", title: "官网渲染与缓存",
    turns: [
      { user: "官网改版用静态生成，构建时渲染所有营销页。", assistant: "官网改版确定：采用静态生成（SSG），营销页全部构建时渲染，TTFB 最优。" },
      { user: "缓存策略：CDN 全量缓存，发布时 purge。", assistant: "官网缓存策略确定：CDN 全量缓存，发布流程触发 purge；页面更新以发布为缓存失效点。" },
      { user: "好。", assistant: "已记录官网两项决定：SSG 渲染 + CDN 全量缓存/purge。" },
    ],
  },
  {
    id: "seed-b2", spaceId: "seed-space-b", title: "详情页与移动端",
    turns: [
      { user: "官网的商品详情页要接实时价格，不能纯静态。", assistant: "官网调整：商品详情页从 SSG 改为增量静态再生（ISR），价格分钟级更新。" },
      { user: "移动端官网单独做一套还是响应式？", assistant: "确定响应式：移动端与桌面共用一套模板按断点适配，不再单独维护 m 站。" },
      { user: "行。", assistant: "已记录：详情页 ISR + 移动端响应式（不单独维护 m 站）。" },
    ],
  },
  {
    id: "seed-c1", spaceId: "seed-space-c", title: "实时管道（星河）",
    turns: [
      { user: "实时管道的聚合窗口定 5 分钟，先这么定。", assistant: "已确定：实时管道聚合窗口为 5 分钟，直接生效。" },
      { user: "下钻维度支持到小时吗？", assistant: "聚合窗口 5 分钟，可上卷到小时/天；下钻到原始事件需回放任务，不做实时下钻。" },
      { user: "管道对外改名叫‘星河’。", assistant: "数据管道对外命名‘星河’，内部仓库名不变。" },
      { user: "今天先到这。", assistant: "今日收敛：‘星河’（数据管道）聚合窗口 5 分钟、可上卷小时/天、不做实时下钻。" },
    ],
  },
  {
    id: "seed-c2", spaceId: "seed-space-c", title: "告警阈值",
    turns: [
      { user: "星河的告警阈值先按 P99 1 秒。", assistant: "已确定：‘星河’告警阈值 P99 1 秒，超限触发页面告警。" },
      { user: "行。", assistant: "已记录告警阈值 P99 1 秒。" },
    ],
  },
];

/**
 * expectedBehavior: answer_with_evidence | stay_uncertain | no_recollection。
 * scenarioClass=post_clear 额外带 expectedBaseline（未模拟清除时的正确行为）。
 * asOfOrdinal 语义：查询发生在 homeConversationId 会话第 asOfOrdinal 轮之后；
 * 校验器强制同会话证据 toOrdinal < asOfOrdinal（防未来泄漏）。
 */
const QUERIES = [
  { queryId: "sq-01", scenarioClass: "decision_reversal", homeConversationId: "seed-a1", asOfOrdinal: 5, spaceId: "seed-space-a", queryText: "电商后台的 API 网关最终采用什么风格？", evidenceGroups: [{ conversationId: "seed-a1", fromOrdinal: 4, toOrdinal: 4 }], expectedBehavior: "answer_with_evidence", note: "必须命中 t4（反转后）而非 t2（被撤回的 GraphQL 决定）" },
  { queryId: "sq-02", scenarioClass: "decision_reversal", homeConversationId: "seed-a1", asOfOrdinal: 5, spaceId: "seed-space-a", queryText: "为什么后台网关放弃了 GraphQL？", evidenceGroups: [{ conversationId: "seed-a1", fromOrdinal: 3, toOrdinal: 4 }], expectedBehavior: "answer_with_evidence", note: "理由在 t3 约束 + t4 决定" },
  { queryId: "sq-03", scenarioClass: "rename_continuity", homeConversationId: "seed-a2", asOfOrdinal: 4, spaceId: "seed-space-a", queryText: "天马项目的部署方式是什么？", evidenceGroups: [{ conversationId: "seed-a2", fromOrdinal: 2, toOrdinal: 3 }], expectedBehavior: "answer_with_evidence", note: "需要跨改名（飞马→天马）关联实体" },
  { queryId: "sq-04", scenarioClass: "rename_continuity", homeConversationId: "seed-a2", asOfOrdinal: 3, spaceId: "seed-space-a", queryText: "飞马项目后来怎么样了？", evidenceGroups: [{ conversationId: "seed-a2", fromOrdinal: 1, toOrdinal: 2 }], expectedBehavior: "answer_with_evidence", note: "答案应说明飞马已更名天马且范围不变" },
  { queryId: "sq-05", scenarioClass: "open_loop_completion", homeConversationId: "seed-a4", asOfOrdinal: 4, spaceId: "seed-space-a", queryText: "导出缓存做完了吗？怎么设计的？", evidenceGroups: [{ conversationId: "seed-a3", fromOrdinal: 1, toOrdinal: 3 }, { conversationId: "seed-a4", fromOrdinal: 1, toOrdinal: 3 }], expectedBehavior: "answer_with_evidence", note: "跨会话：a3 是计划、a4 是完成，需综合并给出命中率 82%" },
  { queryId: "sq-06", scenarioClass: "open_loop_completion", homeConversationId: "seed-a4", asOfOrdinal: 4, spaceId: "seed-space-a", queryText: "导出缓存当时的缓存键是怎么设计的？", evidenceGroups: [{ conversationId: "seed-a3", fromOrdinal: 2, toOrdinal: 2 }], expectedBehavior: "answer_with_evidence", note: "缓存键=用户+报表参数、TTL 10 分钟" },
  { queryId: "sq-07", scenarioClass: "old_decision_recall", homeConversationId: "seed-c1", asOfOrdinal: 4, spaceId: "seed-space-c", queryText: "实时管道的聚合窗口是多少？", evidenceGroups: [{ conversationId: "seed-c1", fromOrdinal: 1, toOrdinal: 2 }], expectedBehavior: "answer_with_evidence", note: "长期后追问旧决定：5 分钟、可上卷、不实时下钻" },
  { queryId: "sq-08", scenarioClass: "rename_continuity", homeConversationId: "seed-c1", asOfOrdinal: 4, spaceId: "seed-space-c", queryText: "星河是什么？", evidenceGroups: [{ conversationId: "seed-c1", fromOrdinal: 3, toOrdinal: 3 }], expectedBehavior: "answer_with_evidence", note: "改名关联：星河=数据管道" },
  { queryId: "sq-09", scenarioClass: "stable_preference", homeConversationId: "seed-a4", asOfOrdinal: 4, spaceId: "seed-space-a", queryText: "我在代码风格上有什么长期要求？", evidenceGroups: [{ conversationId: "seed-a4", fromOrdinal: 2, toOrdinal: 2 }], expectedBehavior: "answer_with_evidence", note: "稳定偏好：给可运行代码而非伪代码" },
  { queryId: "sq-10", scenarioClass: "old_decision_recall", homeConversationId: "seed-a4", asOfOrdinal: 4, spaceId: "seed-space-a", queryText: "导出缓存最终的压测命中率是多少？", evidenceGroups: [{ conversationId: "seed-a4", fromOrdinal: 3, toOrdinal: 3 }], expectedBehavior: "answer_with_evidence", note: "82%" },
  { queryId: "sq-11", scenarioClass: "unanswerable", homeConversationId: "seed-a5", asOfOrdinal: 3, spaceId: "seed-space-a", queryText: "我们的报表中心上线时间定在哪天？", evidenceGroups: [], expectedBehavior: "stay_uncertain", note: "语料中不存在上线时间，应保持不确定" },
  { queryId: "sq-12", scenarioClass: "unanswerable", homeConversationId: "seed-a5", asOfOrdinal: 3, spaceId: "seed-space-a", queryText: "我们团队上次团建去了哪里？", evidenceGroups: [], expectedBehavior: "stay_uncertain", note: "语料中不存在团建记录" },
  { queryId: "sq-13", scenarioClass: "unanswerable", homeConversationId: "seed-c2", asOfOrdinal: 2, spaceId: "seed-space-c", queryText: "星河项目的预算是多少？", evidenceGroups: [], expectedBehavior: "stay_uncertain", note: "语料中只有告警阈值，没有预算" },
  { queryId: "sq-14", scenarioClass: "cross_space_negative", homeConversationId: "seed-b1", asOfOrdinal: 3, spaceId: "seed-space-b", queryText: "我们的缓存策略是怎么定的？", evidenceGroups: [{ conversationId: "seed-b1", fromOrdinal: 2, toOrdinal: 2 }], expectedBehavior: "answer_with_evidence", note: "scope=space-b：应答 CDN 全量缓存/purge，不得混入 space-a 的导出缓存（相似主题不同 Space）" },
  { queryId: "sq-15", scenarioClass: "cross_space_negative", homeConversationId: "seed-a4", asOfOrdinal: 4, spaceId: "seed-space-a", queryText: "官网的渲染方式是什么？", evidenceGroups: [], expectedBehavior: "no_recollection", note: "官网决定只在 space-b；space-a 范围内必须零召回（跨 Space 泄漏=0 的硬门）" },
  { queryId: "sq-16", scenarioClass: "cross_space_negative", homeConversationId: "seed-a4", asOfOrdinal: 4, spaceId: "seed-space-a", queryText: "后台管理端的移动适配是怎么定的？", evidenceGroups: [], expectedBehavior: "no_recollection", note: "移动适配只讨论过 space-b 官网（响应式）；space-a 未讨论" },
  { queryId: "sq-17", scenarioClass: "post_clear", homeConversationId: "seed-a6", asOfOrdinal: 4, spaceId: "seed-space-a", queryText: "图片上传是怎么定的？", evidenceGroups: [{ conversationId: "seed-a6", fromOrdinal: 1, toOrdinal: 3 }], expectedBehavior: "no_recollection", expectedBaseline: "answer_with_evidence", note: "harness 模拟清除 seed-a6（或其 space）记忆后必须零召回；未模拟清除时应正常命中" },
];

function assert(condition, message) {
  if (!condition) throw new Error(`seed corpus validation failed: ${message}`);
}

function buildRecords() {
  const conversationRecords = CONVERSATIONS.map((conversation, conversationIndex) => ({
    type: "conversation",
    conversationId: conversation.id,
    ownerKind: "space",
    ownerId: conversation.spaceId,
    titleOverride: conversation.title,
    autoTitle: null,
    sessionRef: `seed-session-${conversation.id}`,
    createdAt: new Date(BASE_TIME + conversationIndex * MINUTE).toISOString(),
    sourceRevision: 1,
    deletedAt: null,
    seed: true,
  }));

  const runRecords = [];
  for (const conversation of CONVERSATIONS) {
    const conversationIndex = CONVERSATIONS.indexOf(conversation);
    conversation.turns.forEach((turn, turnIndex) => {
      const ordinal = turnIndex + 1;
      const createdAt = new Date(BASE_TIME + (conversationIndex * 100 + turnIndex) * MINUTE).toISOString();
      runRecords.push({
        type: "run",
        runId: `seed-${conversation.id}-r${ordinal}`,
        conversationId: conversation.id,
        ordinal,
        userTurnId: `seed-${conversation.id}-u${ordinal}`,
        assistantTurnId: `seed-${conversation.id}-a${ordinal}`,
        predecessorRunId: null,
        status: "completed",
        failure: null,
        userMessage: turn.user,
        // seed-only：真实导出（eval-export-corpus）没有 assistantMessage，
        // 它在 Pi session 转录中，属调研 §3.2 扩展点；种子直接携带以便 lane 构建。
        assistantMessage: turn.assistant,
        sourceRevision: 1,
        createdAt,
        terminalAt: createdAt,
        seed: true,
      });
    });
  }
  return { conversationRecords, runRecords };
}

function validate(conversationRecords, runRecords, queryRecords) {
  const conversationIds = new Set(conversationRecords.map((record) => record.conversationId));
  const spaceIds = new Set(conversationRecords.map((record) => record.ownerId));
  const turnOrdinals = new Map();
  for (const record of runRecords) {
    const key = record.conversationId;
    turnOrdinals.set(key, Math.max(turnOrdinals.get(key) ?? 0, record.ordinal));
  }
  const seenRunIds = new Set();
  for (const record of runRecords) {
    assert(!seenRunIds.has(record.runId), `duplicate runId ${record.runId}`);
    seenRunIds.add(record.runId);
    assert(conversationIds.has(record.conversationId), `run ${record.runId} references unknown conversation`);
  }
  for (const conversation of CONVERSATIONS) {
    const max = turnOrdinals.get(conversation.id) ?? 0;
    for (let ordinal = 1; ordinal <= max; ordinal += 1) {
      assert(seenRunIds.has(`seed-${conversation.id}-r${ordinal}`), `conversation ${conversation.id} is missing ordinal ${ordinal} (ordinals must be contiguous)`);
    }
  }
  const queryIds = new Set();
  for (const query of QUERIES) {
    assert(!queryIds.has(query.queryId), `duplicate queryId ${query.queryId}`);
    queryIds.add(query.queryId);
    assert(spaceIds.has(query.spaceId), `query ${query.queryId} references unknown space`);
    assert(conversationIds.has(query.homeConversationId), `query ${query.queryId} references unknown home conversation`);
    assert(Number.isInteger(query.asOfOrdinal) && query.asOfOrdinal >= 1, `query ${query.queryId} has invalid asOfOrdinal`);
    const isNegative = query.expectedBehavior === "stay_uncertain" || query.expectedBehavior === "no_recollection";
    assert(isNegative === (query.evidenceGroups.length === 0) || query.scenarioClass === "post_clear",
      `query ${query.queryId}: evidenceGroups presence must match expectedBehavior`);
    for (const group of query.evidenceGroups) {
      assert(conversationIds.has(group.conversationId), `query ${query.queryId} references unknown evidence conversation`);
      assert(group.fromOrdinal >= 1 && group.toOrdinal >= group.fromOrdinal, `query ${query.queryId} has invalid evidence range`);
      assert(group.toOrdinal <= (turnOrdinals.get(group.conversationId) ?? 0), `query ${query.queryId} evidence exceeds corpus`);
      // 防未来泄漏：同会话证据必须早于查询时点。
      if (group.conversationId === query.homeConversationId) {
        assert(group.toOrdinal < query.asOfOrdinal, `query ${query.queryId} leaks future evidence (toOrdinal ${group.toOrdinal} >= asOfOrdinal ${query.asOfOrdinal})`);
      }
    }
  }
  const negatives = QUERIES.filter((query) =>
    query.expectedBehavior !== "answer_with_evidence").length;
  assert(negatives / QUERIES.length >= 0.25, `negative quota too low: ${negatives}/${QUERIES.length}`);
}

async function main() {
  const args = {};
  for (let index = 0; index < process.argv.length - 1; index += 1) {
    if (process.argv[index] === "--out") args.out = path.resolve(process.argv[index + 1]);
    if (process.argv[index] === "--home") args.home = path.resolve(process.argv[index + 1]);
  }
  const productHome = args.home ?? (process.env.SYNECH_HOME ? path.resolve(process.env.SYNECH_HOME)
    : path.join(process.env.LOCALAPPDATA ?? "", "Synech"));
  const outDir = args.out ?? path.join(productHome, "cache", "eval-corpus-seed");

  const { conversationRecords, runRecords } = buildRecords();
  validate(conversationRecords, runRecords, QUERIES);

  await mkdir(outDir, { recursive: true });
  const asJsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
  const files = {
    conversations: path.join(outDir, "conversations.jsonl"),
    runs: path.join(outDir, "runs.jsonl"),
    queries: path.join(outDir, "queries.jsonl"),
  };
  await writeFile(files.conversations, asJsonl(conversationRecords), "utf8");
  await writeFile(files.runs, asJsonl(runRecords), "utf8");
  await writeFile(files.queries, asJsonl(QUERIES), "utf8");

  const scenarioCoverage = [...new Set(QUERIES.map((query) => query.scenarioClass))].sort();
  console.log(JSON.stringify({
    outDir,
    conversations: conversationRecords.length,
    runs: runRecords.length,
    queries: QUERIES.length,
    scenarioCoverage,
    negativeRatio: `${QUERIES.filter((query) => query.expectedBehavior !== "answer_with_evidence").length}/${QUERIES.length}`,
    files,
    usage: "toolchain validation only — not a basis for complexity-promotion hard gates (§5 决策项 3)",
  }, null, 2));
}

main().catch((error) => {
  console.error("[eval-seed-corpus] generation failed:", error?.message ?? error);
  process.exitCode = 1;
});
