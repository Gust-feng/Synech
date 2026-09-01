#!/usr/bin/env node
/**
 * Eval metrics (T10) — group-level retrieval metrics (《手册》17.5).
 *
 * Candidates from any lane are folded onto canonical evidence groups
 * (conversationId + ordinal range) before scoring: 同源重复项折叠（保留最优
 * 排名），指标在折叠后的列表上计算，Precision 分母固定为 k。
 *
 * 行为口径：
 * - answer_with_evidence → Recall@4 / Precision@4 / nDCG@4 / MRR / miss rate；
 * - stay_uncertain       → no-hit accuracy（零结果才正确）；
 * - no_recollection      → false-positive rate（出现任一结果即误报）；
 * - post_clear           → --run-mode cleared 用 expectedBehavior 判定，
 *                          baseline 用 expectedBaseline（未模拟清除时应命中）。
 *
 * Usage:
 *   node scripts/eval-metrics.mjs --selfcheck
 *   node scripts/eval-metrics.mjs --queries <queries.jsonl> --results <results.jsonl> \
 *        [--run-mode baseline|cleared] [--k 4] [--out report.json]
 */
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const groupKey = (group) => `${group.conversationId}#${group.fromOrdinal}-${group.toOrdinal}`;

/** 折叠同源重复：只折叠"相关组"的重复文档，无关文档保留（占据预算槽位）。 */
export function foldRanking(results, relevantGroupKeys) {
  const seenRelevantGroups = new Set();
  const folded = [];
  for (const result of results) {
    const docGroups = result.evidenceGroups ?? [];
    const isRelevant = docGroups.some((group) => relevantGroupKeys.has(groupKey(group)));
    if (isRelevant) {
      const newGroups = docGroups.filter((group) => relevantGroupKeys.has(groupKey(group)) && !seenRelevantGroups.has(groupKey(group)));
      if (newGroups.length === 0) continue; // 纯重复：折叠掉。
      for (const group of newGroups) seenRelevantGroups.add(groupKey(group));
      folded.push({ ...result, relevant: true });
    } else {
      folded.push({ ...result, relevant: false });
    }
  }
  return folded;
}

function dcg(gains) {
  return gains.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
}

export function scoreQuery(query, results, k, expectation) {
  const relevantGroupKeys = new Set((query.evidenceGroups ?? []).map(groupKey));
  const folded = foldRanking(results, relevantGroupKeys).slice(0, k);
  const topK = folded;
  const relevantCount = (query.evidenceGroups ?? []).length;
  const hasRelevantGroups = relevantCount > 0;

  const gains = topK.map((entry) => (entry.relevant ? 1 : 0));
  const hitGroups = new Set();
  for (const entry of topK) {
    for (const group of entry.evidenceGroups ?? []) {
      if (relevantGroupKeys.has(groupKey(group))) hitGroups.add(groupKey(group));
    }
  }
  const firstRelevantRank = topK.find((entry) => entry.relevant)?.rank ?? 0;

  const record = {
    queryId: query.queryId,
    scenarioClass: query.scenarioClass,
    expectedBehavior: expectation,
    resultCount: results.length,
  };
  if (expectation === "answer_with_evidence") {
    record.recallAtK = hasRelevantGroups ? hitGroups.size / relevantCount : null;
    record.precisionAtK = gains.reduce((sum, gain) => sum + gain, 0) / k;
    const idealGains = [...Array(Math.min(relevantCount, k))].map(() => 1);
    record.ndcgAtK = dcg(gains) / (dcg(idealGains) || 1);
    record.mrr = firstRelevantRank > 0 ? 1 / firstRelevantRank : 0;
    record.miss = hasRelevantGroups && hitGroups.size === 0;
  } else {
    record.falsePositive = results.length > 0;
  }
  return record;
}

export function expectationFor(query, runMode) {
  if (runMode === "cleared") return query.expectedBehavior;
  return query.expectedBaseline ?? query.expectedBehavior;
}

export function computeMetrics(queries, resultsByQuery, { k = 4, runMode = "baseline" } = {}) {
  const perQuery = [];
  for (const query of queries) {
    const results = (resultsByQuery.get(query.queryId) ?? []).map((entry, index) => ({ rank: index + 1, ...entry }));
    perQuery.push(scoreQuery(query, results, k, expectationFor(query, runMode)));
  }

  const answerable = perQuery.filter((record) => record.expectedBehavior === "answer_with_evidence");
  const average = (values) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const aggregate = {
    k,
    runMode,
    queryCount: perQuery.length,
    answerable: {
      count: answerable.length,
      recallAtK: average(answerable.map((record) => record.recallAtK).filter((value) => value !== null)),
      precisionAtK: average(answerable.map((record) => record.precisionAtK)),
      ndcgAtK: average(answerable.map((record) => record.ndcgAtK)),
      mrr: average(answerable.map((record) => record.mrr)),
      missRate: average(answerable.map((record) => (record.miss ? 1 : 0))) ?? 0,
    },
    noHitAccuracy: (() => {
      const negatives = perQuery.filter((record) => record.expectedBehavior === "stay_uncertain");
      return negatives.length > 0
        ? negatives.filter((record) => !record.falsePositive).length / negatives.length
        : null;
    })(),
    falsePositiveRate: (() => {
      const negatives = perQuery.filter((record) => record.expectedBehavior === "no_recollection");
      return negatives.length > 0
        ? negatives.filter((record) => record.falsePositive).length / negatives.length
        : null;
    })(),
  };
  const byScenarioClass = {};
  for (const record of perQuery) {
    byScenarioClass[record.scenarioClass] ??= { count: 0 };
    byScenarioClass[record.scenarioClass].count += 1;
  }
  return { aggregate, byScenarioClass, perQuery };
}

// ---------------------------------------------------------------------------
// 自检：人工构造的已知排名，断言精确值。
// ---------------------------------------------------------------------------

function runSelfcheck() {
  const g1 = { conversationId: "c1", fromOrdinal: 1, toOrdinal: 2 };
  const g2 = { conversationId: "c1", fromOrdinal: 3, toOrdinal: 4 };
  const relevantKeys = new Set([groupKey(g1), groupKey(g2)]);
  const doc = (id, groups) => ({ docId: id, evidenceGroups: groups });
  const approx = (value, expected) => Math.abs(value - expected) < 1e-9;

  // 用例 1：无关、g1、g2、无关 → 折叠保持 4 项，nDCG = DCG([0,1,1,0])/IDCG([1,1])。
  const folded1 = foldRanking([doc("d1", []), doc("d2", [g1]), doc("d3", [g2]), doc("d4", [])], relevantKeys);
  if (folded1.length !== 4 || !folded1[1].relevant || !folded1[2].relevant) throw new Error("selfcheck case1 fold mismatch");
  const gains1 = folded1.map((entry) => (entry.relevant ? 1 : 0));
  const ndcg1 = dcg(gains1) / dcg([1, 1]);
  if (!approx(ndcg1, (1 / Math.log2(3) + 1 / Math.log2(4)) / (1 / Math.log2(2) + 1 / Math.log2(3)))) {
    throw new Error("selfcheck case1 ndcg mismatch");
  }

  // 用例 2：同组重复折叠（g1, g1, g2, 无关）→ 折叠后 [g1, g2, 无关]。
  const folded2 = foldRanking([doc("a", [g1]), doc("b", [g1]), doc("c", [g2]), doc("d", [])], relevantKeys);
  if (folded2.length !== 3 || folded2[0].docId !== "a" || folded2[1].docId !== "c" || folded2[2].docId !== "d") {
    throw new Error("selfcheck case2 fold-dedupe mismatch");
  }

  // 用例 3：完整查询打分——perfect ranking。
  const perfect = scoreQuery(
    { queryId: "q", scenarioClass: "s", evidenceGroups: [g1, g2] },
    [doc("d2", [g1]), doc("d3", [g2])].map((entry, index) => ({ rank: index + 1, ...entry })),
    4, "answer_with_evidence",
  );
  if (perfect.recallAtK !== 1 || perfect.precisionAtK !== 0.5 || !approx(perfect.ndcgAtK, 1) || perfect.mrr !== 1 || perfect.miss) {
    throw new Error("selfcheck case3 perfect-ranking mismatch");
  }

  // 用例 4：空结果 → miss，mrr 0。
  const empty = scoreQuery(
    { queryId: "q2", scenarioClass: "s", evidenceGroups: [g1] }, [], 4, "answer_with_evidence",
  );
  if (empty.recallAtK !== 0 || empty.mrr !== 0 || !empty.miss) throw new Error("selfcheck case4 empty mismatch");

  // 用例 5：负例有结果即误报。
  const fp = scoreQuery(
    { queryId: "q3", scenarioClass: "s", evidenceGroups: [], expectedBehavior: "no_recollection" },
    [doc("d9", [])], 4, "no_recollection",
  );
  if (!fp.falsePositive) throw new Error("selfcheck case5 false-positive mismatch");

  console.log(JSON.stringify({ selfcheck: "ok", cases: 5 }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selfcheck")) { runSelfcheck(); return; }
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--queries" && value !== undefined) { args.queries = value; index += 1; }
    else if (argv[index] === "--results" && value !== undefined) { args.results = value; index += 1; }
    else if (argv[index] === "--out" && value !== undefined) { args.out = value; index += 1; }
    else if (argv[index] === "--k" && value !== undefined) { args.k = Number(value); index += 1; }
    else if (argv[index] === "--run-mode" && value !== undefined) { args.runMode = value; index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  if (args.queries === undefined || args.results === undefined) throw new Error("--queries and --results are required");
  const queries = (await readFile(args.queries, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const resultRecords = (await readFile(args.results, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const resultsByQuery = new Map();
  for (const record of resultRecords) {
    if (!resultsByQuery.has(record.queryId)) resultsByQuery.set(record.queryId, []);
    resultsByQuery.get(record.queryId).push(...record.results);
  }
  const report = computeMetrics(queries, resultsByQuery, { k: args.k ?? 4, runMode: args.runMode ?? "baseline" });
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (args.out !== undefined) await writeFile(args.out, serialized, "utf8");
  else console.log(serialized);
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("eval-metrics.mjs");
if (invokedDirectly) {
  main().catch((error) => {
    console.error("[eval-metrics] failed:", error?.message ?? error);
    process.exitCode = 1;
  });
}
