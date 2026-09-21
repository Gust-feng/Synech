import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { createLocalConfigCenter } from "../dist/app/config-center/index.js";
import { createResearchApplication } from "../dist/app/application/research-application.js";
import { createConfigCenterResearchModel } from "../dist/app/panel-server/research/research-model.js";
import { createResearchFeature, createSqliteResearchRepository } from "../dist/app/research/index.js";

/**
 * 深度研究编排真实冒烟：真实模型 + 固定检索资料。
 *
 * 与 smoke-research.mjs 的分工：
 * - 那个跑真实联网检索与抓取（要求本机配置搜索服务与 Playwright）；
 * - 这个只验证最脆弱的一环——真实模型对三个提示词的返回是否可解析、
 *   报告是否合规、引用编号是否落在真实来源内，因此检索与抓取用固定夹具。
 *
 * 运行：node scripts/smoke-research-orchestration.mjs
 * 只用于开发期人工验证，会真实消耗模型额度（一次约 3–6 次调用）。
 */

const question = process.argv[2] ?? "家用 NAS 的实际维护负担有多大？";

const productHome = await mkdtemp(path.join(os.tmpdir(), "synech-research-orchestration-"));
const database = new SqliteRuntimeDatabase(path.join(productHome, "data", "synech.sqlite3"));
const feature = createResearchFeature({ repository: createSqliteResearchRepository(database) });
let application;
try {
  await copyConfig(process.env.LOCALAPPDATA, productHome);
  const { configCenter } = createLocalConfigCenter({ configDirectory: path.join(productHome, "config") });
  const provider = await configCenter.getModelProviderConfig();
  console.log("模型:", provider.profileId, provider.label, "| 已配置:", provider.secretConfigured);
  assert.equal(provider.secretConfigured, true, "本机未配置模型密钥，无法进行编排冒烟");

  // 固定检索资料：真实可打开的链接与摘要，让证据链路可核对但不受网络与额度影响。
  const searchResults = [
    {
      title: "NAS 的日常维护到底要做哪些事",
      url: "https://example.com/nas-maintenance-1",
      snippet: "群晖与威联通都提供自动快照与健康检查，日常维护主要是磁盘告警处理、定期更新固件以及检查备份任务是否按计划完成。多数用户在稳定运行后每周只需查看一次控制台。",
    },
    {
      title: "机械硬盘与固态盘在 NAS 中的寿命差异",
      url: "https://example.com/nas-maintenance-2",
      snippet: "机械盘在 7x24 环境下的年故障率明显高于固态盘，但固态盘写入寿命有限。常见做法是用固态盘放热数据、机械盘放归档，并配置定期 SMART 检测。",
    },
    {
      title: "NAS 维护失败的常见原因与教训",
      url: "https://example.com/nas-maintenance-3",
      snippet: "最常见的问题不是硬件故障，而是备份从未验证：用户以为阵列冗余等于备份，直到误删或勒索软件加密才发现同步目录也被加密。建议保留至少一份离线或异机备份。",
    },
    {
      title: "NAS 与公有云的维护成本比较",
      url: "https://example.com/nas-maintenance-4",
      snippet: "自建 NAS 的前期硬件投入高于订阅公有云，但五年总拥有成本在容量需求较大时更低。代价是维护责任转移到用户：需要在停电、网络中断与漏洞修补上自行投入时间。",
    },
    {
      title: "远程访问与安全问题",
      url: "https://example.com/nas-maintenance-5",
      snippet: "开放公网端口会显著提高被扫描与暴力破解的风险。较稳妥的做法是只通过 VPN 或厂商的中继服务访问，并强制启用双因素认证与失败登录锁定。",
    },
  ];
  const articleBody = "这是一段用于验证的正文摘录：设备维护的负担主要来自异常处理与备份验证，而不是日常操作。";

  application = createResearchApplication({
    feature,
    model: createConfigCenterResearchModel({ configCenter }),
    search: {
      async search() {
        return { status: "completed", results: searchResults };
      },
    },
    content: {
      async fetch() {
        return { status: "completed", text: articleBody.repeat(12) };
      },
    },
    readiness: async () => ({ search: { available: true } }),
    onDiagnostic: (topic, error) => console.error(`[diag] ${topic}`, error),
  });

  const { taskId } = await application.start({ question });
  await feature.commands.claimNextQueued({ startedAt: Date.now() });
  const startedAt = Date.now();
  await application.execute(taskId, new AbortController().signal);

  const detail = await feature.queries.detail(taskId);
  assert.ok(detail !== undefined);
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log("\n状态:", detail.task.status, "| 用时:", elapsed, "秒");
  console.log("模型调用:", detail.task.usage.modelRequests, "| token:", detail.task.usage.inputTokens, "/", detail.task.usage.outputTokens);
  console.log("子问题:", detail.task.plan?.questions.length ?? 0, "| 覆盖轮次:", detail.task.coverage.length);
  console.log("来源:", detail.sources.length, "| 检索记录:", detail.queries.length);
  if (detail.task.errorMessage !== null) console.log("错误:", detail.task.errorCode, detail.task.errorMessage);

  assert.equal(detail.task.status, "completed", `研究未完成：${detail.task.errorCode ?? ""} ${detail.task.errorMessage ?? ""}`);
  assert.ok(detail.task.plan !== null, "拆题未产出计划（真实模型的 JSON 输出不可解析）");
  assert.ok(detail.task.coverage.length > 0, "没有产生任何覆盖判断");
  assert.ok(detail.task.reportMarkdown !== null && detail.task.reportMarkdown.length > 800, "报告正文过短");
  for (const section of ["## 摘要", "## 背景与范围", "## 主体分析", "## 结论与建议", "## 分歧与争议", "## 缺口与限制"]) {
    assert.ok(detail.task.reportMarkdown.includes(section), `报告缺少小节：${section}`);
  }
  assert.equal(detail.sources.length, searchResults.length, "来源数量与检索结果不一致");

  const cited = [...new Set([...detail.task.reportMarkdown.matchAll(/\[(\d+)\]/gu)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const ordinals = new Set(detail.sources.map((source) => source.ordinal));
  const outOfRange = cited.filter((number) => !ordinals.has(number));
  console.log("报告引用编号:", cited.join(", ") || "（无）");
  assert.equal(outOfRange.length, 0, `报告引用了不存在的来源编号：${outOfRange.join(", ")}`);
  assert.ok(cited.length > 0, "报告没有使用任何来源引用");

  console.log("\n--- 报告开头 ---");
  console.log(detail.task.reportMarkdown.slice(0, 800));
  console.log("\n编排冒烟通过：真实模型的拆题、覆盖判断与报告输出均可用，引用编号落在真实来源内。");
} finally {
  await feature.release().catch(() => undefined);
  database.close();
  const resolved = path.resolve(productHome);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("synech-research-orchestration-"));
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

async function copyConfig(localAppData, targetHome) {
  if (localAppData === undefined) throw new Error("缺少 LOCALAPPDATA，无法读取本机模型配置。");
  const source = path.join(localAppData, "Synech", "config");
  const target = path.join(targetHome, "config");
  await mkdir(target, { recursive: true });
  for (const name of ["settings.json", "local-dev-secrets.json"]) {
    await copyFile(path.join(source, name), path.join(target, name));
  }
}
