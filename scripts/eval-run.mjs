#!/usr/bin/env node
/**
 * Eval retrieval runner (T11) — FTS5-only lexical baseline over a lane
 * directory built by eval-build-lanes.mjs. This is the Phase 2 baseline the
 * handbook's vector/hybrid gates are measured against (《手册》16.1/17.5).
 *
 * 中文检索按《手册》16.2 采用 CJK bigram + 拉丁词标准化的 lexical projection
 * （unicode61 分词器下直接存原文等于整句 token，无法匹配）。投影只存在于本次
 * 运行的临时内存 FTS5 表，不落盘、不进 Product schema。
 *
 * Scope discipline: 每条查询只在其 spaceId 的文档内检索（跨 Space 泄漏硬门 0）。
 *
 * Usage:
 *   node scripts/eval-run.mjs --lanes <lanesDir> --queries <queries.jsonl> \
 *        [--lane chunk|summary|both] [--k 4] [--clear-conversations id1,id2] \
 *        [--out-dir <dir>]
 * Output: <out-dir>/results-<lane>.jsonl（供 eval-metrics.mjs --results 使用）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  const args = { lane: "both", k: 4, clearConversations: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--lanes" && value !== undefined) { args.lanes = path.resolve(value); index += 1; }
    else if (flag === "--queries" && value !== undefined) { args.queries = path.resolve(value); index += 1; }
    else if (flag === "--lane" && value !== undefined) { args.lane = value; index += 1; }
    else if (flag === "--k" && value !== undefined) { args.k = Number(value); index += 1; }
    else if (flag === "--clear-conversations" && value !== undefined) {
      args.clearConversations = new Set(value.split(",").map((id) => id.trim()).filter(Boolean)); index += 1;
    }
    else if (flag === "--out-dir" && value !== undefined) { args.outDir = path.resolve(value); index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${flag ?? "(none)"}`);
  }
  if (args.lanes === undefined || args.queries === undefined) throw new Error("--lanes and --queries are required");
  if (!["chunk", "summary", "both"].includes(args.lane)) throw new Error("--lane must be chunk|summary|both");
  return args;
}

/** 《手册》16.2：CJK bigram + 拉丁词标准化的 lexical projection。 */
export function lexicalProjection(text) {
  const tokens = new Set();
  for (const word of text.match(/[A-Za-z0-9_]+/g) ?? []) tokens.add(word.toLowerCase());
  for (const run of text.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) { tokens.add(run); continue; }
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens];
}

// bigram 查询用 OR 连接 + bm25 排序：包含更多查询 bigram 的文档排名更高；
// AND 会在长查询上过度严格（缺任一 bigram 即全灭），不适合作召回基线。
const ftsMatchQuery = (tokens) => tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");

function buildDatabase(docs) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE VIRTUAL TABLE docs_fts USING fts5(
      terms,
      doc_id UNINDEXED,
      space_id UNINDEXED,
      conversation_id UNINDEXED,
      from_ordinal UNINDEXED,
      to_ordinal UNINDEXED,
      evidence_groups UNINDEXED,
      tokenize = 'unicode61'
    );
  `);
  const insert = database.prepare(`
    INSERT INTO docs_fts(terms, doc_id, space_id, conversation_id, from_ordinal, to_ordinal, evidence_groups)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const doc of docs) {
    insert.run(
      lexicalProjection(doc.text).join(" "),
      doc.docId,
      doc.spaceId,
      doc.conversationId,
      doc.fromOrdinal,
      doc.toOrdinal,
      JSON.stringify(doc.evidenceGroups),
    );
  }
  return database;
}

async function runLane(lane, args, queries) {
  const docs = (await readFile(path.join(args.lanes, lane, "docs.jsonl"), "utf8"))
    .split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const database = buildDatabase(docs);
  const search = database.prepare(`
    SELECT doc_id AS docId, space_id AS spaceId, conversation_id AS conversationId,
           from_ordinal AS fromOrdinal, to_ordinal AS toOrdinal, evidence_groups AS evidenceGroups,
           bm25(docs_fts) AS score
    FROM docs_fts
    WHERE docs_fts MATCH ? AND space_id = ?
    ORDER BY score
    LIMIT ?
  `);

  const records = [];
  let emptyQueries = 0;
  for (const query of queries) {
    const tokens = lexicalProjection(query.queryText);
    const rows = tokens.length === 0 ? [] : search.all(ftsMatchQuery(tokens), query.spaceId, args.k);
    if (rows.length === 0) emptyQueries += 1;
    records.push({
      queryId: query.queryId,
      lane,
      results: rows.map((row) => ({
        docId: row.docId,
        score: row.score,
        conversationId: row.conversationId,
        spaceId: row.spaceId,
        evidenceGroups: JSON.parse(row.evidenceGroups),
      })),
    });
  }
  database.close();
  return { records, emptyQueries, docCount: docs.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const queries = (await readFile(args.queries, "utf8"))
    .split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const outDir = args.outDir ?? path.join(args.lanes, "runs");
  await mkdir(outDir, { recursive: true });

  const lanes = args.lane === "both" ? ["chunk", "summary"] : [args.lane];
  const summary = { outDir, lanes: {}, clearConversations: [...args.clearConversations] };
  for (const lane of lanes) {
    const { records, emptyQueries, docCount } = await runLane(lane, args, queries);
    const filtered = args.clearConversations.size > 0
      ? records.map((record) => ({
          ...record,
          results: record.results.filter((entry) => !args.clearConversations.has(entry.conversationId)),
        }))
      : records;
    const filePath = path.join(outDir, `results-${lane}.jsonl`);
    await writeFile(filePath, filtered.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    summary.lanes[lane] = {
      docs: docCount,
      resultsFile: filePath,
      queriesWithZeroHits: emptyQueries,
      next: `node scripts/eval-metrics.mjs --queries ${args.queries} --results ${filePath} --run-mode ${args.clearConversations.size > 0 ? "cleared" : "baseline"}`,
    };
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("[eval-run] retrieval run failed:", error?.message ?? error);
  process.exitCode = 1;
});
