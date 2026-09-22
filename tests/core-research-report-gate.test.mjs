import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  createResearchFeature,
  createSqliteResearchRepository,
} from "../dist/app/research/index.js";
import {
  RESEARCH_REPORT_SECTIONS,
  composeResearchReport,
  exportResearchReportMarkdown,
} from "../dist/app/research/report/index.js";

/**
 * 报告子系统硬门（ADR 0001 §2.4 / §2.5 / §6 验证项 2 / 设计草案 §10.1）的最小不变量验证。
 *
 * 按 AGENTS.md 规则 11：发布阻断路径必须保护「引用真实且可核验」这条长期不变量——
 * 硬门坏掉时，用户会拿到带幻觉引用或内部标识的报告。全部用例用真实 SQLite 账本状态
 * 构造（不 mock 存储），覆盖：
 * 1. quote 不落 content hash（含仅摘要级来源的逐字引文）→ 拒绝发布；
 * 2. evidence 不存在（claim 无证据绑定 / claim 不存在）→ 拒绝发布；
 * 3. span 无 claim 归因 → 拒绝发布；
 * 4. 零保留来源 → 不成稿（ADR §2.4 终止路径）；
 * 5. 内部标识泄漏 → 拒绝发布；
 * 6. 通过路径：六节渲染、导出保真（URL 可点/标题/access_level/定位）、确定性、
 *    抽样支撑率与导出拒写。
 */

async function withFeature(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-research-report-gate-"));
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
    await run({ feature, advance: (ms) => { clock += ms; } });
  } finally {
    await feature.release();
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

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

const questionDraft = {
  text: "长上下文的成本结构如何？",
  boundaryNote: "只看推理成本，不看训练成本",
  priority: "critical",
  origin: { kind: "brief", scopeBasis: "批准范围：目标与纳入项" },
};

const EXCERPT = "长上下文改变成本结构，这是来源原文摘录。";

/**
 * 真实账本种子：任务 + 批准范围 + 问题 + 来源 + 证据 + 主张 + covered 标记。
 * options.fetch=false 时来源保持 snippet 级（contentHash=null），用于引文不落 hash 用例。
 * options.sourceCount>1 时入列多个来源（返回全部），用于跨来源引文用例。
 */
async function seedLedger(feature, options = {}) {
  const task = await feature.commands.createTask({ question: "长上下文与 RAG 各自适合什么？" });
  await feature.commands.approveScope({ taskId: task.id, approval, brief });
  const [question] = await feature.commands.appendQuestions({
    taskId: task.id,
    questions: [questionDraft],
  });
  const sourceDrafts = options.sourceCount && options.sourceCount > 1
    ? [
      { title: "来源一", url: "https://a.example.com/1", snippet: "摘要一" },
      { title: "来源二", url: "https://b.example.com/2", snippet: "摘要二" },
    ]
    : [{ title: "来源一", url: "https://a.example.com/1", snippet: "摘要一" }];
  const sourceEntries = await feature.commands.appendSourceEntries({
    taskId: task.id,
    drafts: sourceDrafts,
  });
  for (const entry of sourceEntries) {
    if (options.fetch !== false) {
      await feature.commands.markSourceAccess({
        taskId: task.id,
        sourceId: entry.id,
        accessLevel: "fulltext",
        contentHash: options.contentHash ?? "sha256:content-one",
      });
    }
  }
  const evidenceSource = sourceEntries[(options.evidenceSourceOrdinal ?? 1) - 1] ?? sourceEntries[0];
  const [evidence] = await feature.commands.appendEvidenceItems({
    taskId: task.id,
    items: [{
      sourceId: evidenceSource.id,
      questionIds: [question.id],
      excerpt: options.excerpt ?? EXCERPT,
      locator: "第 2 节第 1 段",
      extractedClaim: "摘录支持的论断",
      stance: "supports",
    }],
  });
  const claims = await feature.commands.appendClaims({
    taskId: task.id,
    claims: options.claimDrafts ?? [{
      text: "长上下文改变成本结构",
      type: "sourced",
      evidenceIds: [evidence.id],
    }],
  });
  if (options.covered !== false) {
    await feature.commands.applyObservations({
      taskId: task.id,
      batch: {
        questionUpdates: [
          { questionId: question.id, status: "investigating" },
          { questionId: question.id, status: "covered" },
        ],
      },
    });
  }
  const ledger = await feature.queries.ledger(task.id);
  return { task, question, source: sourceEntries[0], sourceEntries, evidence, claims, ledger };
}

/** 六节各一个 span 的合法模型输出；段落级覆盖用 overrides.spans 替换。 */
function modelOutput({ claimIds, sourceIds, overrides = {} }) {
  return {
    title: "长上下文成本结构研究报告",
    spans: RESEARCH_REPORT_SECTIONS.map((section, index) => ({
      text: index === 0
        ? "研究表明「长上下文改变成本结构」，这是来源给出的结论。"
        : `第 ${index + 1} 节的正文，挂靠同一主张与来源。`,
      claim_ids: claimIds,
      attribution_type: "source_statement",
      citation_source_ids: sourceIds,
      section,
    })),
    gap_ids: [],
    conflict_ids: [],
    ...overrides,
  };
}

const hasFailure = (composition, code) =>
  composition.gate.ok === false && composition.gate.failures.some((failure) => failure.code === code);

test("report gate rejects quotes that do not land on the preserved content hash", async () => {
  await withFeature(async ({ feature }) => {
    const { claims, ledger } = await seedLedger(feature);
    const claimId = claims[0].id;

    // 引文不在任何背书证据的 excerpt 里：不落 content hash。
    const hallucinated = composeResearchReport({
      ledger,
      modelOutput: modelOutput({
        claimIds: [claimId],
        sourceIds: [ledger.sources[0].id],
        overrides: {
          spans: RESEARCH_REPORT_SECTIONS.map((section, index) => ({
            text: index === 0 ? "研究表明「来源没有说过的话」，这是引用不落内容的例子。" : `第 ${index + 1} 节。`,
            claim_ids: [claimId],
            attribution_type: "source_statement",
            citation_source_ids: [ledger.sources[0].id],
            section,
          })),
        },
      }),
    });
    assert.equal(hallucinated.ok, false);
    assert.ok(hasFailure(hallucinated, "span_quote_not_verified"));
    assert.equal(hallucinated.markdown, null);
    const quoteFailure = hallucinated.gate.failures.find((f) => f.code === "span_quote_not_verified");
    assert.equal(quoteFailure.spanOrdinal, 1);

    // 仅摘要级来源（未抓取、contentHash=null）不支持逐字引文：摘要不等于全文。
    const snippetLedger = await seedLedger(feature, { fetch: false });
    const snippetClaimId = snippetLedger.claims[0].id;
    const snippetQuote = composeResearchReport({
      ledger: snippetLedger.ledger,
      modelOutput: modelOutput({
        claimIds: [snippetClaimId],
        sourceIds: [snippetLedger.source.id],
        overrides: {
          spans: RESEARCH_REPORT_SECTIONS.map((section, index) => ({
            text: index === 0 ? `研究表明「${EXCERPT}」，逐字照抄摘要。` : `第 ${index + 1} 节。`,
            claim_ids: [snippetClaimId],
            attribution_type: "source_statement",
            citation_source_ids: [snippetLedger.source.id],
            section,
          })),
        },
      }),
    });
    assert.equal(snippetQuote.ok, false);
    assert.ok(hasFailure(snippetQuote, "span_quote_not_verified"));

    // 同一句话去掉引号（改写而非照抄）即可通过引文检查。
    const paraphrased = composeResearchReport({
      ledger: snippetLedger.ledger,
      modelOutput: modelOutput({
        claimIds: [snippetClaimId],
        sourceIds: [snippetLedger.source.id],
        overrides: {
          spans: RESEARCH_REPORT_SECTIONS.map((section, index) => ({
            text: index === 0 ? "研究表明长上下文会改变成本结构，与摘要一致。" : `第 ${index + 1} 节。`,
            claim_ids: [snippetClaimId],
            attribution_type: "source_statement",
            citation_source_ids: [snippetLedger.source.id],
            section,
          })),
        },
      }),
    });
    assert.equal(paraphrased.gate.ok, true);
  });
});

test("report gate rejects quotes backed by evidence of sources the span does not cite", async () => {
  await withFeature(async ({ feature }) => {
    // 证据挂在来源乙；span 只引用来源甲，正文逐字引用来源乙的 excerpt：
    // 引文被未引用来源的证据背书，渲染会把引文错位挂到用户点开的甲来源名下
    // （设计 §10.1「Evidence.source_id 与引用一致」）——必须拒绝。
    const { sourceEntries, claims, ledger } = await seedLedger(feature, {
      sourceCount: 2,
      evidenceSourceOrdinal: 2,
    });
    const sourceA = sourceEntries[0];
    const sourceB = sourceEntries[1];
    assert.equal(ledger.evidence.length, 1);
    assert.equal(ledger.evidence[0].sourceId, sourceB.id);
    const claimId = claims[0].id;

    const misattributed = composeResearchReport({
      ledger,
      modelOutput: modelOutput({
        claimIds: [claimId],
        sourceIds: [sourceA.id],
        overrides: {
          spans: RESEARCH_REPORT_SECTIONS.map((section, index) => ({
            text: index === 0 ? `研究表明「${EXCERPT}」，引文实际来自来源乙。` : `第 ${index + 1} 节。`,
            claim_ids: [claimId],
            attribution_type: "source_statement",
            citation_source_ids: [sourceA.id],
            section,
          })),
        },
      }),
    });
    assert.equal(misattributed.ok, false);
    assert.ok(hasFailure(misattributed, "span_quote_not_verified"));
    assert.equal(misattributed.markdown, null);

    // 把来源乙也列入引用后同一引文即可过门：背书范围随引用声明走。
    const corrected = composeResearchReport({
      ledger,
      modelOutput: modelOutput({
        claimIds: [claimId],
        sourceIds: [sourceA.id, sourceB.id],
        overrides: {
          spans: RESEARCH_REPORT_SECTIONS.map((section, index) => ({
            text: index === 0 ? `研究表明「${EXCERPT}」，引文实际来自来源乙。` : `第 ${index + 1} 节。`,
            claim_ids: [claimId],
            attribution_type: "source_statement",
            citation_source_ids: [sourceA.id, sourceB.id],
            section,
          })),
        },
      }),
    });
    assert.equal(corrected.ok, true);
    // 两个引用都进入产物：标题、URL 与读取深度齐全。
    assert.ok(corrected.markdown.includes("[来源一](https://a.example.com/1)"));
    assert.ok(corrected.markdown.includes("[来源二](https://b.example.com/2)"));
    assert.ok(corrected.markdown.includes("全文"));
  });
});

test("report gate rejects claims without existing evidence and unknown claims", async () => {
  await withFeature(async ({ feature }) => {
    const { ledger } = await seedLedger(feature, {
      claimDrafts: [{ text: "没有证据支撑的主张", type: "inference", evidenceIds: [] }],
    });
    const orphanClaimId = ledger.claims[0].id;

    // claim 存在但没有绑定任何 Evidence：证据不存在 → 拒绝。
    const missingEvidence = composeResearchReport({
      ledger,
      modelOutput: modelOutput({ claimIds: [orphanClaimId], sourceIds: [ledger.sources[0].id] }),
    });
    assert.equal(missingEvidence.ok, false);
    assert.ok(hasFailure(missingEvidence, "span_claim_evidence_missing"));

    // 引用账本里不存在的 claim：同样拒绝（ID 必须真实）。
    const unknownClaim = composeResearchReport({
      ledger,
      modelOutput: modelOutput({
        claimIds: [`${ledger.taskId}:c99`],
        sourceIds: [ledger.sources[0].id],
      }),
    });
    assert.equal(unknownClaim.ok, false);
    assert.ok(hasFailure(unknownClaim, "span_claim_missing"));

    // 引用不存在的来源：拒绝。
    const unknownSource = composeResearchReport({
      ledger,
      modelOutput: modelOutput({
        claimIds: [orphanClaimId],
        sourceIds: [`${ledger.taskId}:s99`],
      }),
    });
    assert.equal(unknownSource.ok, false);
    assert.ok(hasFailure(unknownSource, "span_citation_source_missing"));
  });
});

test("report gate rejects spans without claim attribution", async () => {
  await withFeature(async ({ feature }) => {
    const { ledger } = await seedLedger(feature);

    // 每个 span 都没有 claim 归因：无归因的事实句不得出现。
    const unattributed = composeResearchReport({
      ledger,
      modelOutput: modelOutput({ claimIds: [], sourceIds: [ledger.sources[0].id] }),
    });
    assert.equal(unattributed.ok, false);
    assert.equal(unattributed.markdown, null);
    const failures = unattributed.gate.failures.filter((f) => f.code === "span_claim_unattributed");
    assert.equal(failures.length, RESEARCH_REPORT_SECTIONS.length);
    assert.equal(failures[0].spanOrdinal, 1);

    // 解析失败（缺节）同样不得发布，且不产出 Markdown。
    const incomplete = composeResearchReport({
      ledger,
      modelOutput: {
        title: "不完整的报告",
        spans: [{
          text: "只有一节。",
          claim_ids: [ledger.claims[0].id],
          attribution_type: "inference",
          citation_source_ids: [],
          section: "summary",
        }],
        gap_ids: [],
        conflict_ids: [],
      },
    });
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.parse.ok, false);
    assert.equal(incomplete.markdown, null);
    assert.ok(incomplete.parse.failures.some((failure) => failure.code === "section_empty"));
  });
});

test("report gate terminates the task when no source is retained", async () => {
  await withFeature(async ({ feature }) => {
    const task = await feature.commands.createTask({ question: "长上下文与 RAG 各自适合什么？" });
    await feature.commands.approveScope({ taskId: task.id, approval, brief });
    await feature.commands.appendQuestions({ taskId: task.id, questions: [questionDraft] });
    const ledger = await feature.queries.ledger(task.id);
    assert.equal(ledger.sources.length, 0);

    const composition = composeResearchReport({
      ledger,
      modelOutput: modelOutput({ claimIds: [`${task.id}:c1`], sourceIds: [] }),
    });
    assert.equal(composition.ok, false);
    assert.ok(hasFailure(composition, "report_no_citable_source"));
    assert.equal(composition.markdown, null);
  });
});

test("report gate rejects internal identifiers leaking into span text", async () => {
  await withFeature(async ({ feature }) => {
    const { source, claims, ledger } = await seedLedger(feature);
    const leaked = composeResearchReport({
      ledger,
      modelOutput: modelOutput({
        claimIds: [claims[0].id],
        sourceIds: [source.id],
        overrides: {
          spans: RESEARCH_REPORT_SECTIONS.map((section, index) => ({
            text: index === 0
              ? `研究表明见 ${source.id} 与证据 ${ledger.evidence[0].id}。`
              : `第 ${index + 1} 节。`,
            claim_ids: [claims[0].id],
            attribution_type: "source_statement",
            citation_source_ids: [source.id],
            section,
          })),
        },
      }),
    });
    assert.equal(leaked.ok, false);
    assert.ok(hasFailure(leaked, "span_internal_id_leaked"));
    assert.ok(hasFailure(leaked, "span_quote_not_verified") === false);
  });
});

test("report gate applies user-visible controls to the report title", async () => {
  await withFeature(async ({ feature }) => {
    const { source, claims, ledger } = await seedLedger(feature);
    const validOutput = () => modelOutput({ claimIds: [claims[0].id], sourceIds: [source.id] });

    // 标题携带真实内部标识：原样渲染成 `# …` 并随 finishTask 持久化，硬门必须拒绝。
    const withId = composeResearchReport({
      ledger,
      modelOutput: { ...validOutput(), title: `报告 ${source.id}` },
    });
    assert.equal(withId.ok, false);
    assert.ok(hasFailure(withId, "title_internal_id_leaked"));

    // 标题携带自定义 Markdown 链接 / 裸 URL：引用语法由渲染器独占，解析层即拒。
    for (const badTitle of [
      `报告标题 [更多](https://evil.example.com/x)`,
      "报告标题 https://evil.example.com/x",
    ]) {
      const linked = composeResearchReport({
        ledger,
        modelOutput: { ...validOutput(), title: badTitle },
      });
      assert.equal(linked.ok, false);
      assert.equal(linked.parse.ok, false);
      assert.ok(linked.parse.failures.some((failure) => failure.code === "title_url_reserved"));
      assert.equal(linked.markdown, null);
    }
  });
});

test("report composition renders six sections deterministically and exports fidelity", async () => {
  await withFeature(async ({ feature }) => {
    const { source, evidence, claims, ledger } = await seedLedger(feature);
    const claimId = claims[0].id;
    const output = modelOutput({ claimIds: [claimId], sourceIds: [source.id] });

    const composition = composeResearchReport({
      ledger,
      modelOutput: output,
      verdicts: [
        { spanOrdinal: 1, claimId, verdict: "supports" },
        { spanOrdinal: 2, claimId, verdict: "does_not_support" },
      ],
    });
    assert.equal(composition.ok, true);
    assert.equal(composition.title, "长上下文成本结构研究报告");
    assert.equal(composition.spans.length, RESEARCH_REPORT_SECTIONS.length);

    const markdown = composition.markdown;
    assert.ok(markdown !== null);
    // 固定六节、按序出现。
    let cursor = -1;
    for (const heading of ["## 摘要", "## 背景与范围", "## 主体分析", "## 结论与建议", "## 分歧与争议", "## 缺口与限制"]) {
      const at = markdown.indexOf(heading);
      assert.ok(at > cursor, `${heading} 必须按固定顺序出现`);
      cursor = at;
    }
    // 导出保真：可点开 URL、来源标题、access_level 与证据定位一个不能少。
    assert.ok(markdown.includes(`[来源一](https://a.example.com/1)`));
    assert.ok(markdown.includes("全文"));
    assert.ok(markdown.includes("第 2 节第 1 段"));
    // 内部标识永不进入用户可见产物。
    assert.equal(markdown.includes(source.id), false);
    assert.equal(markdown.includes(evidence.id), false);
    assert.equal(markdown.includes(claimId), false);

    // 确定性：同一账本与同一模型输出两次装配逐字节相同。
    const again = composeResearchReport({ ledger, modelOutput: output });
    assert.equal(again.markdown, markdown);

    // 抽样支撑率：1 supports + 1 does_not_support → 0.5，非支撑判定给许可处理路径。
    assert.ok(composition.supportRate !== null);
    assert.equal(composition.supportRate.sampled, 2);
    assert.equal(composition.supportRate.supports, 1);
    assert.equal(composition.supportRate.doesNotSupport, 1);
    assert.equal(composition.supportRate.supportRate, 0.5);
    assert.equal(composition.supportRate.remediations.length, 1);
    assert.equal(composition.supportRate.remediations[0].spanOrdinal, 2);
    assert.deepEqual([...composition.supportRate.remediations[0].allowedActions],
      ["narrow_claim", "switch_to_inference", "reopen_question"]);

    // 导出=写文件：内容与界面所见一致。
    const dir = await mkdtemp(path.join(os.tmpdir(), "synech-research-report-export-"));
    try {
      const filePath = path.join(dir, "report.md");
      const exported = await exportResearchReportMarkdown({ composition, filePath });
      assert.equal(exported.ok, true);
      assert.equal(await readFile(filePath, "utf8"), markdown);

      // 硬门拒绝的组合拒写：不生成「差一点就发布」的产物。
      const rejected = composeResearchReport({
        ledger,
        modelOutput: modelOutput({ claimIds: [], sourceIds: [source.id] }),
      });
      const rejectedExport = await exportResearchReportMarkdown({
        composition: rejected,
        filePath: path.join(dir, "rejected.md"),
      });
      assert.equal(rejectedExport.ok, false);
      assert.equal(rejectedExport.reason, "gate_rejected");
      await assert.rejects(() => readFile(path.join(dir, "rejected.md"), "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

test("report citation support rate isolates out-of-enum verdicts in a rejected bucket", async () => {
  await withFeature(async ({ feature }) => {
    const { source, claims, ledger } = await seedLedger(feature);
    const claimId = claims[0].id;

    // 信任边界：verifier 模型原始输出直接灌入。枚举外字符串不得静默破坏计数
    // （sampled=Σbuckets），也不得伪装成 insufficient_context。
    const composition = composeResearchReport({
      ledger,
      modelOutput: modelOutput({ claimIds: [claimId], sourceIds: [source.id] }),
      verdicts: [
        { spanOrdinal: 1, claimId, verdict: "supports" },
        { spanOrdinal: 2, claimId, verdict: "probably_fine" },
        { spanOrdinal: 3, claimId, verdict: "partially_supports" },
      ],
    });
    const supportRate = composition.supportRate;
    assert.ok(supportRate !== null);
    assert.equal(supportRate.sampled, 2);
    assert.equal(supportRate.rejected, 1);
    assert.equal(supportRate.supports, 1);
    assert.equal(supportRate.partiallySupports, 1);
    assert.equal(supportRate.supportRate, 1);
    // 计数不变量：sampled 恰等于五个枚举桶之和，越界值不在其中。
    assert.equal(
      supportRate.sampled,
      supportRate.supports + supportRate.partiallySupports + supportRate.contradicts
        + supportRate.doesNotSupport + supportRate.insufficientContext,
    );
    // 越界判定不产生 remediation（它不是一个核验结论）。
    assert.equal(supportRate.remediations.length, 0);
  });
});
