import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startLocalPanelServer } from "../dist/app/panel-server/request-handler.js";

/**
 * 深度研究真实冒烟：用真实模型与联网搜索跑一次完整研究，核对报告与来源事实。
 *
 * 只用于开发期人工验证（不进入 `pnpm test:core`）：会真实消耗模型与搜索额度。
 * 运行：node scripts/smoke-research.mjs "研究问题"
 *
 * 数据目录用临时 Product Home，绝不触碰用户真实的 %LOCALAPPDATA%\Synech。
 * 模型与搜索凭证从用户配置中读取（只读，不修改），因为研发机上没有第二套凭证。
 */

const question = process.argv[2] ?? "家用 NAS 的实际维护负担有多大？";

const productHome = await mkdtemp(path.join(os.tmpdir(), "synech-research-smoke-"));
let server;
try {
  // 研发机上没有第二套凭证：把用户配置**复制**进临时 Home（只读来源、不修改用户目录），
  // 这样真实模型与搜索可用，而研究记录仍写在临时库里、不污染用户数据。
  await copyModelConfig(process.env.LOCALAPPDATA, productHome);

  server = await startLocalPanelServer({ productHome, host: "127.0.0.1", port: 0 });
  const base = server.url.replace(/\/$/u, "");

  // readiness 必须是「可用」：搜索服务没配好时应如实拒绝，而不是静默跑出空研究。
  const before = await getJson(`${base}/api/research`);
  console.log("readiness:", JSON.stringify(before.readiness));
  assert.equal(before.readiness.search.available, true, "搜索服务不可用，无法进行真实冒烟");
  assert.equal(before.tasks.length, 0);

  const created = await postJson(`${base}/api/research`, { question });
  console.log("created:", created.task.id);
  const taskId = created.task.id;

  const startedAt = Date.now();
  let detail;
  for (;;) {
    await delay(3_000);
    detail = await getJson(`${base}/api/research/${encodeURIComponent(taskId)}`);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[${elapsed}s] ${detail.status}${detail.stage === null ? "" : ` · ${detail.stage}`} · 来源 ${detail.sources.length} · 检索 ${detail.usage.searchRequests} · 抓取 ${detail.usage.fetchRequests} · 模型 ${detail.usage.modelRequests}`);
    if (detail.status !== "queued" && detail.status !== "running") break;
    if (elapsed > 1_200) throw new Error("研究超时未收敛");
  }

  console.log("\n最终状态:", detail.status);
  console.log("用时:", Math.round(detail.usage.elapsedMs / 1000), "秒");
  console.log("子问题:", detail.plan?.questions.length ?? 0);
  console.log("来源:", detail.sources.length, "（已读正文", detail.sources.filter((s) => s.hasContent).length, "条）");
  console.log("检索活动:", detail.queries.length, "次");
  if (detail.errorMessage !== null) console.log("错误:", detail.errorCode, detail.errorMessage);

  assert.equal(detail.status, "completed", `研究未完成：${detail.errorCode ?? ""} ${detail.errorMessage ?? ""}`);
  assert.ok(detail.reportMarkdown !== null && detail.reportMarkdown.length > 500, "报告正文过短");
  for (const section of ["## 摘要", "## 背景与范围", "## 主体分析", "## 结论与建议", "## 缺口与限制"]) {
    assert.ok(detail.reportMarkdown.includes(section), `报告缺少小节：${section}`);
  }
  assert.ok(detail.sources.length > 0, "没有收集到来源");

  // 引用编号必须落在真实来源范围内：报告里出现的 [n] 不能超出已入列来源。
  const cited = new Set([...detail.reportMarkdown.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1])));
  const ordinals = new Set(detail.sources.map((source) => source.ordinal));
  const outOfRange = [...cited].filter((number) => !ordinals.has(number));
  console.log("报告引用编号:", [...cited].sort((a, b) => a - b).join(", ") || "（无）");
  assert.equal(outOfRange.length, 0, `报告引用了不存在的来源编号：${outOfRange.join(", ")}`);

  console.log("\n--- 报告开头 ---");
  console.log(detail.reportMarkdown.slice(0, 700));
  console.log("\n--- 来源 ---");
  for (const source of detail.sources.slice(0, 8)) {
    console.log(`${source.ordinal}. ${source.title} — ${source.url}（${source.hasContent ? `正文 ${source.contentChars} 字` : source.contentStatus}）`);
  }
} finally {
  try {
    await server?.close();
  } finally {
    const resolved = path.resolve(productHome);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("synech-research-smoke-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把用户 config 目录复制到临时 Home 的 config/：只读来源，写入目标仅限临时目录。 */
async function copyModelConfig(localAppData, targetHome) {
  if (localAppData === undefined) throw new Error("缺少 LOCALAPPDATA，无法读取本机模型配置。");
  const source = path.join(localAppData, "Synech", "config");
  const target = path.join(targetHome, "config");
  await mkdir(target, { recursive: true });
  for (const name of ["settings.json", "local-dev-secrets.json"]) {
    try {
      await copyFile(path.join(source, name), path.join(target, name));
    } catch (error) {
      throw new Error(`无法读取本机配置 ${name}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(`${url} → ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${url} → ${response.status} ${JSON.stringify(body)}`);
  return body;
}
