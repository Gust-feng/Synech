#!/usr/bin/env node
/**
 * eval-curate-corpus.mjs — Agent-A 的独立高质量语料精选（与 Agent-B 的 mining/ 互不干扰）。
 *
 * 输入（只读）：eval-corpus-opencode/{conversations,runs}.jsonl（B 已做第一层规则导入：60 会话/1082 轮）。
 * 输出（全部写在独立目录，默认 cache/eval-curated-A）：
 *   - conversations.scored.jsonl  每个会话的多维指标、质量分、广度标签
 *   - curated.jsonl               分层配额选出的精选会话（含选中理由与覆盖标签）
 *   - curated-runs.jsonl          精选会话对应的配对轮次子集（供后续标注/record 挖掘）
 *   - curation-report.json        分布与覆盖统计（证明广度+深度），含落选原因汇总
 *
 * 设计原则：
 * - 第一层只做确定性、可解释、可复算的质量打分（不调 LLM），LLM 精修是后续独立步骤；
 * - 广度优先 + 深度保底：按 space / 任务类型 / 深度档位分层配额，避免被最大来源垄断；
 * - 不修改输入目录、不写 Product schema、不进 git（语料落本地 cache）。
 *
 * 用法：
 *   node scripts/eval-curate-corpus.mjs --profile                 # 只出画像，不筛选
 *   node scripts/eval-curate-corpus.mjs [--target 28] [--min-score 55]
 *   node scripts/eval-curate-corpus.mjs --src <dir> --out <dir>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { encodingForModel } from "js-tiktoken";

// ---------------------------------------------------------------- 参数
const args = { profile: false, target: 30, minScore: 55, src: "", out: "" };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--profile") args.profile = true;
    else if (flag === "--target") { args.target = Number(value); i += 1; }
    else if (flag === "--min-score") { args.minScore = Number(value); i += 1; }
    else if (flag === "--src") { args.src = value; i += 1; }
    else if (flag === "--out") { args.out = value; i += 1; }
  }
}
const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
const SRC = args.src || path.join(localAppData, "Synech", "cache", "eval-corpus-opencode");
const OUT = args.out || path.join(localAppData, "Synech", "cache", "eval-curated-A");

const enc = encodingForModel("gpt-4o");
const tokens = (text) => (text ? enc.encode(text).length : 0);

async function readJsonl(file) {
  const raw = await readFile(file, "utf8");
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------- 指标
const CODE_FENCE = /```/g;
const INLINE_CODE = /`[^`\n]{2,}`/g;
const STACK_TRACE = /at\s+[\w.<>]+\s*\(|Traceback|Error:\s|\bException\b|errno|E\d{3,4}/i;
const SHELL_CMD = /\b(pnpm|npm|node|git|cargo|pip|python|docker|curl|wget|mkdir|cd|ls|dir)\b[ ][^\n]{2,}/i;
const PATH_REF = /[A-Za-z]:[\\/][^\s]{3,}|[\\/]?(src|dist|tests?|scripts|packages?)[\\/][\w@./\\-]{2,}/;
const SHORT_CHITCHAT = /^(好的?|嗯|谢谢|感谢|ok|okay|nice|收到|可以|行|没问题|搞定|辛苦了|？|\?|。|．|\.)+[!！。.~～]*$/i;
const CLOSURE_SIGNAL = /谢谢|感谢|搞定|成功了?|可以了?|没问题|跑(通|起来)了?|解决了?|正常了?|很好|不错|辛苦了|thx|thanks|it works|great|perfect|继续|下一步|接下来/i;

// 残留隐私/密钥扫描（B 导入已脱敏 JWT/PEM，这里在精选层再兜底，只标记不修改原文）。
const PRIVACY_PATTERNS = [
  ["phone_cn", /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["ipv4", /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g],
  ["jwt", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g],
  ["secret_assignment", /(?:api[_-]?key|secret|password|passwd|token|access[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{12,}/gi],
  ["pem_private", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["long_hex", /(?<![A-Fa-f0-9])[A-Fa-f0-9]{40,}(?![A-Fa-f0-9])/g],
];
// 网络/抓包/逆向语料里 IP 是研究对象而非个人隐私，单独归为 technical（只透明计数，不打敏感标）。
const TECHNICAL_HITS = new Set(["ipv4"]);
function scanPrivacy(text) {
  const hits = {};
  let sensitive = 0;
  for (const [name, re] of PRIVACY_PATTERNS) {
    const m = text.match(re);
    if (m) { hits[name] = m.length; if (!TECHNICAL_HITS.has(name)) sensitive += m.length; }
  }
  return { hits, sensitive };
}

// 手册 17.2 评测场景的潜力启发式（粗标，供后续 60–80 查询人工标注选料；后三类需人工构造负例）。
const EVAL_POTENTIAL = [
  ["decide_then_reject", /改回|换成|不要这个|否决|之前的方案(不|没)|还是用|放弃|推翻|改用|不再用|换个(方案|思路)/],
  ["rename_continuity", /改名|重命名|rename|名字改|更名为|叫.*改成/],
  ["open_loop_done", /(待办|回头|之后再|todo|稍后|以后补)[\s\S]{0,120}(完成|搞定|实现|补上|解决)|(完成|搞定)[\s\S]{0,60}(之前|前面|上次)(留|说|提)/i],
  ["recall_old_decision", /之前(说|定|决定|提)|上次(说|定)|前面(说|定)|还记得|早先|前几天/],
  ["stable_preference", /我(喜欢|习惯|倾向)|以后都|每次都|默认(用|选)|统一用|不要用|一直(用|走)|向来/],
];

// 任务类型关键词（有序匹配，首个命中为准；覆盖广度标签）。
const TASK_TYPES = [
  ["环境搭建", /安装|环境|依赖|虚拟环境|venv|配置环境|setup|install|依赖包/],
  ["调试排错", /报错|错误|异常|bug|失败|无法|不能|为什么|堆栈|traceback|error|fail|崩|卡住|排查/],
  ["架构设计", /架构|设计|方案|抽象|模块|分层|选型|应该怎么(设计|做)|重构方案|设计稿/],
  ["代码审查", /审查|review|代码质量|挑刺|问题点|改进意见|看看这段|评审/],
  ["安全_CTF", /ctf|抓包|逆向|加密|解密|注入|漏洞|payload|爆破|token 获取|号池/],
  ["文档知识维护", /文档|docs|readme|记录|沉淀|手册|注释|知识库|总结经验|维护文档/],
  ["调研学习", /是什么|原理|讲解|学习|了解|区别|对比|调研|为什么.*(用|选)|教程/],
  ["代码实现", /实现|写一个|开发|新增|功能|编码|补全|改成|重构|脚本/],
];

function classifyTaskType(title, userText) {
  const hay = `${title}\n${userText.slice(0, 600)}`;
  for (const [label, re] of TASK_TYPES) if (re.test(hay)) return label;
  return "其他";
}

function scoreConversation(conv, runs) {
  const ordered = [...runs].sort((a, b) => a.ordinal - b.ordinal);
  const turnCount = ordered.length;
  const userTexts = ordered.map((r) => r.userMessage ?? "");
  const assistantTexts = ordered.map((r) => r.assistantMessage ?? "");
  const allUser = userTexts.join("\n");
  const allAssistant = assistantTexts.join("\n");

  const userTokens = tokens(allUser);
  const assistantTokens = tokens(allAssistant);
  const totalTokens = userTokens + assistantTokens;
  const assistantChars = allAssistant.length;
  const codeFencePairs = (allAssistant.match(CODE_FENCE)?.length ?? 0) / 2;
  const inlineCodeHits = allAssistant.match(INLINE_CODE)?.length ?? 0;
  const stackTurns = ordered.filter((r) => STACK_TRACE.test(`${r.userMessage}\n${r.assistantMessage}`)).length;
  const shellTurns = ordered.filter((r) => SHELL_CMD.test(r.assistantMessage ?? "")).length;
  const pathTurns = ordered.filter((r) => PATH_REF.test(`${r.userMessage}\n${r.assistantMessage}`)).length;

  const failed = ordered.filter((r) => r.status && r.status !== "completed").length;
  const failureRate = turnCount ? failed / turnCount : 1;
  const shortTurns = ordered.filter((r) =>
    (r.userMessage ?? "").trim().length < 8 && (r.assistantMessage ?? "").trim().length < 40
    || SHORT_CHITCHAT.test((r.userMessage ?? "").trim())).length;
  const chitchatRate = turnCount ? shortTurns / turnCount : 1;

  // 末尾闭环：最后 2 个用户轮是否出现推进/确认/解决信号。
  const tailUser = userTexts.slice(-2).join("\n");
  const closureHit = CLOSURE_SIGNAL.test(tailUser);

  // 时间跨度（分钟）
  const started = ordered[0]?.createdAt;
  const ended = ordered[ordered.length - 1]?.terminalAt ?? ordered[ordered.length - 1]?.createdAt;
  let spanMin = 0;
  if (started && ended) spanMin = Math.max(0, Math.round((new Date(ended) - new Date(started)) / 60000));

  // -------- 归一化子分（0..1），曲线用饱和函数避免极端值垄断
  const sat = (x, half) => x / (x + half);
  const depth = 0.55 * sat(turnCount, 6) + 0.45 * sat(totalTokens / 1000, 6);
  const technicality = sat(
    codeFencePairs * 1.4 + inlineCodeHits * 0.35 + stackTurns * 1.1 + shellTurns * 0.8 + pathTurns * 0.5,
    5,
  );
  const closure = 0.5 * (1 - failureRate) + 0.3 * (closureHit ? 1 : 0.45) + 0.2 * sat(turnCount, 6);
  const density = 1 - Math.min(1, chitchatRate * 1.4);
  // 会话过短天然上限受限
  const tooThin = turnCount < 3 || totalTokens < 900;

  const score = Math.round(
    100 * (0.34 * depth + 0.24 * technicality + 0.24 * closure + 0.18 * Math.max(0, density)),
  );

  // 深度档位
  const depthBand = totalTokens >= 6000 || turnCount >= 12 ? "long"
    : totalTokens >= 2200 || turnCount >= 6 ? "medium" : "short";

  const taskType = classifyTaskType(conv.titleOverride ?? conv.autoTitle ?? "", allUser);

  // 17.2 场景潜力（粗标，多标签）；隐私残留扫描（user+assistant 全文）。
  const potentialText = `${conv.titleOverride ?? conv.autoTitle ?? ""}\n${allUser}`;
  const evalPotential = EVAL_POTENTIAL.filter(([, re]) => re.test(potentialText)).map(([name]) => name);
  const { hits: privacyHits, sensitive: privacySensitive } = scanPrivacy(`${allUser}\n${allAssistant}`);
  const privacyCount = Object.values(privacyHits).reduce((n, c) => n + c, 0);

  return {
    conversationId: conv.conversationId,
    spaceId: conv.ownerId,
    title: conv.titleOverride ?? conv.autoTitle ?? "(未命名)",
    createdAt: conv.createdAt,
    taskType,
    depthBand,
    evalPotential,
    privacyHits,
    privacyCount,
    privacySensitive,
    metrics: {
      turnCount, totalTokens, userTokens, assistantTokens, assistantChars,
      codeFencePairs: Math.round(codeFencePairs), inlineCodeHits, stackTurns, shellTurns, pathTurns,
      failed, failureRate: Number(failureRate.toFixed(3)), shortTurns, chitchatRate: Number(chitchatRate.toFixed(3)),
      closureHit, spanMin,
    },
    subscores: {
      depth: Number(depth.toFixed(3)), technicality: Number(technicality.toFixed(3)),
      closure: Number(closure.toFixed(3)), density: Number(density.toFixed(3)),
    },
    score,
    tooThin,
    // 落选/保留的可解释原因
    flags: [
      tooThin ? "too_thin" : null,
      failureRate > 0.4 ? "high_failure" : null,
      chitchatRate > 0.5 ? "mostly_chitchat" : null,
      technicality < 0.12 && turnCount < 5 ? "low_substance" : null,
      closureHit ? "has_closure_signal" : null,
      privacySensitive > 0 ? "privacy_sensitive" : null,
    ].filter(Boolean),
  };
}

// ---------------------------------------------------------------- 分层配额选择
function selectCurated(scored, { target, minScore }) {
  const eligible = scored.filter((s) => !s.flags.includes("too_thin") && s.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const chosen = new Map();
  const reasons = [];
  const take = (s, reason) => {
    if (!chosen.has(s.conversationId)) { chosen.set(s.conversationId, s); reasons.push({ id: s.conversationId, reason }); }
  };

  // 1) 广度保底：每个 space 选其最高分 1 个（保证来源不缺位）。
  const bySpace = new Map();
  for (const s of eligible) {
    if (!bySpace.has(s.spaceId)) bySpace.set(s.spaceId, []);
    bySpace.get(s.spaceId).push(s);
  }
  for (const list of bySpace.values()) take(list[0], "space_coverage");

  // 2) 类型广度：每个任务类型补 1 个当前最优且未选的。
  const byType = new Map();
  for (const s of eligible) {
    if (!byType.has(s.taskType)) byType.set(s.taskType, []);
    byType.get(s.taskType).push(s);
  }
  for (const list of byType.values()) {
    const pick = list.find((s) => !chosen.has(s.conversationId));
    if (pick) take(pick, "tasktype_coverage");
  }

  // 2.5) 评测场景广度保底：每种手册 17.2 潜力标签至少保 2 个，为后续 60–80 查询标注备料。
  const POTENTIAL_FLOOR = 2;
  const byPotential = new Map();
  for (const s of eligible) for (const tag of s.evalPotential) {
    if (!byPotential.has(tag)) byPotential.set(tag, []);
    byPotential.get(tag).push(s);
  }
  for (const [tag, list] of byPotential) {
    for (const s of list) {
      const have = [...chosen.values()].filter((c) => c.evalPotential.includes(tag)).length;
      if (have >= POTENTIAL_FLOOR) break;
      take(s, `eval_potential:${tag}`);
    }
  }

  // 3) 深度保底：long 档至少占 1/3；另保 2 个 short 高闭环样本以维持粒度多样。
  const bands = { long: [], medium: [], short: [] };
  for (const s of eligible) bands[s.depthBand].push(s);
  const longFloor = Math.max(3, Math.round(target / 3));
  for (const s of bands.long) if ([...chosen.values()].filter((c) => c.depthBand === "long").length < longFloor) take(s, "depth_long_floor");
  let shortFloor = 0;
  for (const s of bands.short) {
    if (shortFloor >= 2) break;
    if (s.flags.includes("has_closure_signal")) { take(s, "short_closure_floor"); shortFloor += 1; }
  }

  // 4) 用全局质量分填到 target，同时维持 space 均衡（同一 space 上限）。
  const perSpaceCap = Math.max(2, Math.ceil((target * 1.4) / bySpace.size));
  for (const s of eligible) {
    if (chosen.size >= target) break;
    const spaceCount = [...chosen.values()].filter((c) => c.spaceId === s.spaceId).length;
    if (spaceCount >= perSpaceCap) continue;
    take(s, "top_quality_fill");
  }

  // 若配额后仍不足 target（合格池小），放宽 space cap 补齐。
  for (const s of eligible) {
    if (chosen.size >= target) break;
    take(s, "top_quality_fill_relaxed");
  }

  const reasonById = new Map(reasons.map((r) => [r.id, r.reason]));
  const curated = [...chosen.values()].sort((a, b) =>
    a.spaceId.localeCompare(b.spaceId) || b.score - a.score)
    .map((s) => ({ ...s, selectedReason: reasonById.get(s.conversationId) }));
  return { eligible, curated };
}

function groupCount(items, key) {
  const out = {};
  for (const it of items) { const k = typeof key === "function" ? key(it) : it[key]; out[k] = (out[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

// ---------------------------------------------------------------- 主流程
const conversations = await readJsonl(path.join(SRC, "conversations.jsonl"));
const runs = await readJsonl(path.join(SRC, "runs.jsonl"));
const runsByConv = new Map();
for (const r of runs) {
  if (!runsByConv.has(r.conversationId)) runsByConv.set(r.conversationId, []);
  runsByConv.get(r.conversationId).push(r);
}

const scored = conversations.map((conv) => scoreConversation(conv, runsByConv.get(conv.conversationId) ?? []));
scored.sort((a, b) => b.score - a.score);

// 画像（无论是否筛选都输出）
const profile = {
  source: SRC,
  conversationCount: conversations.length,
  runCount: runs.length,
  scoreQuartiles: (() => {
    const vals = scored.map((s) => s.score).sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
    return { min: vals[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: vals[vals.length - 1] };
  })(),
  bySpace: groupCount(scored, "spaceId"),
  byTaskType: groupCount(scored, "taskType"),
  byDepthBand: groupCount(scored, "depthBand"),
  byEvalPotential: groupCount(scored.flatMap((s) => s.evalPotential), (x) => x),
  privacySensitiveConversations: scored.filter((s) => s.privacySensitive > 0)
    .map((s) => ({ conversationId: s.conversationId, title: s.title, sensitive: s.privacySensitive, hits: s.privacyHits })),
  flagCounts: groupCount(scored.flatMap((s) => s.flags), (x) => x),
  tokenTotals: {
    all: scored.reduce((n, s) => n + s.metrics.totalTokens, 0),
    medianPerConv: (() => { const v = scored.map((s) => s.metrics.totalTokens).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; })(),
  },
};

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "conversations.scored.jsonl"),
  scored.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
await writeFile(path.join(OUT, "profile.json"), JSON.stringify(profile, null, 2) + "\n", "utf8");

console.log("[profile] conversations=%d runs=%d", profile.conversationCount, profile.runCount);
console.log("[profile] score quartiles %j", profile.scoreQuartiles);
console.log("[profile] bySpace %j", profile.bySpace);
console.log("[profile] byTaskType %j", profile.byTaskType);
console.log("[profile] byDepthBand %j", profile.byDepthBand);
console.log("[profile] flags %j", profile.flagCounts);

if (args.profile) {
  console.log("[--profile] scored profile written to", OUT);
  process.exit(0);
}

const { eligible, curated } = selectCurated(scored, { target: args.target, minScore: args.minScore });
const curatedIds = new Set(curated.map((s) => s.conversationId));
const curatedRuns = runs.filter((r) => curatedIds.has(r.conversationId));

const report = {
  source: SRC,
  out: OUT,
  params: { target: args.target, minScore: args.minScore },
  totals: { conversations: conversations.length, runs: runs.length, eligible: eligible.length, curated: curated.length, curatedRuns: curatedRuns.length },
  curatedBySpace: groupCount(curated, "spaceId"),
  curatedByTaskType: groupCount(curated, "taskType"),
  curatedByDepthBand: groupCount(curated, "depthBand"),
  selectedReasonCounts: groupCount(curated, "selectedReason"),
  curatedTokens: curated.reduce((n, s) => n + s.metrics.totalTokens, 0),
  scoreRange: { min: curated.at(-1)?.score, max: curated[0]?.score },
  dropped: scored.filter((s) => !curatedIds.has(s.conversationId))
    .map((s) => ({ conversationId: s.conversationId, spaceId: s.spaceId, taskType: s.taskType,
      depthBand: s.depthBand, title: s.title, score: s.score, flags: s.flags })),
  curated: curated.map((s) => ({
    conversationId: s.conversationId, spaceId: s.spaceId, title: s.title, taskType: s.taskType,
    depthBand: s.depthBand, score: s.score, selectedReason: s.selectedReason,
    evalPotential: s.evalPotential, privacySensitive: s.privacySensitive > 0 ? s.privacyHits : undefined,
    metrics: s.metrics,
  })),
};

// 人类可读精选清单（供用户/B 审阅，不进 git）。
const md = [];
md.push("# Agent-A 高质量语料精选清单（eval-curated-A）", "");
md.push(`- 输入：${report.totals.conversations} 会话 / ${report.totals.runs} 轮（B 第一层导入后的语料）`);
md.push(`- 合格池：${report.totals.eligible}；精选：**${report.totals.curated} 会话 / ${report.totals.curatedRuns} 轮 / 约 ${report.curatedTokens} tokens**`);
md.push(`- 参数：target=${report.params.target}, minScore=${report.params.minScore}`);
md.push(`- Space 覆盖：${Object.keys(report.curatedBySpace).length} 个；任务类型：${Object.keys(report.curatedByTaskType).length} 类；深度档：${JSON.stringify(report.curatedByDepthBand)}`);
md.push(`- 选中理由分布：${JSON.stringify(report.selectedReasonCounts)}`);
md.push("", "## 精选会话（按质量分降序）", "");
md.push("| 分 | 深度 | 类型 | 轮数 | tokens | 17.2场景潜力 | Space | 标题 | 入选理由 |");
md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const c of [...report.curated].sort((a, b) => b.score - a.score)) {
  md.push(`| ${c.score} | ${c.depthBand} | ${c.taskType} | ${c.metrics.turnCount} | ${c.metrics.totalTokens} | ${(c.evalPotential ?? []).join("/") || "—"} | ${c.spaceId.replace("ocsp-", "")} | ${c.title.replace(/\|/g, "/")} | ${c.selectedReason} |`);
}
md.push("", "## 任务类型 / Space / 深度覆盖", "");
md.push("### 任务类型"); for (const [k, v] of Object.entries(report.curatedByTaskType)) md.push(`- ${k}: ${v}`);
md.push("", "### 来源 Space"); for (const [k, v] of Object.entries(report.curatedBySpace)) md.push(`- ${k.replace("ocsp-", "")}: ${v}`);
md.push("", "## 落选会话（审计用）", "");
md.push("| 分 | 深度 | 类型 | Space | flags | 标题 |");
md.push("| --- | --- | --- | --- | --- | --- |");
for (const d of [...report.dropped].sort((a, b) => b.score - a.score)) {
  md.push(`| ${d.score} | ${d.depthBand} | ${d.taskType} | ${(d.spaceId ?? "").replace("ocsp-", "")} | ${d.flags.join("/") || "—"} | ${d.title.replace(/\|/g, "/")} |`);
}
const markdown = md.join("\n") + "\n";

await writeFile(path.join(OUT, "curated.jsonl"), curated.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
await writeFile(path.join(OUT, "curated-runs.jsonl"), curatedRuns.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
await writeFile(path.join(OUT, "curation-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
await writeFile(path.join(OUT, "curated-index.md"), markdown, "utf8");

console.log("\n[curate] eligible=%d curated=%d curatedRuns=%d tokens=%d",
  report.totals.eligible, report.totals.curated, report.totals.curatedRuns, report.curatedTokens);
console.log("[curate] curatedBySpace %j", report.curatedBySpace);
console.log("[curate] curatedByTaskType %j", report.curatedByTaskType);
console.log("[curate] curatedByDepthBand %j", report.curatedByDepthBand);
console.log("[curate] written to", OUT);
