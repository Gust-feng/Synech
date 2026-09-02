#!/usr/bin/env node
/**
 * Eval lane builder (T9) — builds retrieval lanes from a corpus directory
 * (produced by eval-export-corpus.mjs on real data, or eval-seed-corpus.mjs
 * for toolchain validation; 沟通笔记 §5 项 3).
 *
 * Lanes (《手册》17.1):
 * - chunk:  conversation turns concatenated, split into ~200–300 token chunks
 *           with small overlap (model-token counting via the product's
 *           js-tiktoken).
 * - summary: one deterministic extractive summary document per conversation
 *           (toolchain mode). Model-generated summaries can replace these later
 *           in the identical document format without touching the metrics.
 *
 * Every retrieval document carries a canonical evidence group mapping
 * (conversationId + inclusive ordinal range) so metrics (T10) can fold
 * candidates from different lanes onto the same evidence groups.
 *
 * Usage: node scripts/eval-build-lanes.mjs --corpus <dir> [--out <dir>]
 *        [--chunk-tokens 260] [--overlap-tokens 40] [--summary-max-tokens 900]
 * If the corpus contains records.jsonl (from eval-export-corpus --with-memory),
 * a third record lane is built from the real MemoryRecord provenance.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { encodingForModel } from "js-tiktoken";

function parseArgs(argv) {
  const args = { chunkTokens: 260, overlapTokens: 40, summaryMaxTokens: 900 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--corpus" && value !== undefined) { args.corpus = path.resolve(value); index += 1; }
    else if (flag === "--out" && value !== undefined) { args.out = path.resolve(value); index += 1; }
    else if (flag === "--chunk-tokens" && value !== undefined) { args.chunkTokens = Number(value); index += 1; }
    else if (flag === "--overlap-tokens" && value !== undefined) { args.overlapTokens = Number(value); index += 1; }
    else if (flag === "--summary-max-tokens" && value !== undefined) { args.summaryMaxTokens = Number(value); index += 1; }
    else throw new Error(`Unknown or incomplete argument: ${flag ?? "(none)"}`);
  }
  if (args.corpus === undefined) throw new Error("--corpus <dir> is required (dir with conversations.jsonl and runs.jsonl)");
  if (!(args.chunkTokens >= 100 && args.chunkTokens <= 800)) throw new Error("--chunk-tokens must be within 100..800");
  if (!(args.overlapTokens >= 0 && args.overlapTokens < args.chunkTokens)) throw new Error("--overlap-tokens must be within 0..<chunk-tokens)");
  return args;
}

async function readJsonl(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`missing corpus file: ${filePath}`);
    throw error;
  }
}

async function readOptionalJsonl(filePath) {
  try {
    return await readJsonl(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.message === `missing corpus file: ${filePath}`) return [];
    throw error;
  }
}

function turnText(run) {
  // 真实导出（无 session 转录扩展前）只有 userMessage；种子带 assistantMessage。
  return [run.userMessage, run.assistantMessage].filter((value) => typeof value === "string" && value.length > 0).join("\n");
}

/** 把 turn 文本序列切成 token 窗口；窗口记录覆盖的 turn ordinal 范围。 */
function chunkTurns(turns, encode, decode, chunkTokens, overlapTokens) {
  const chunks = [];
  let currentTokens = [];
  let currentFrom;
  let currentTo;
  const flush = () => {
    if (currentTokens.length === 0) return;
    chunks.push({
      text: decode(currentTokens),
      fromOrdinal: currentFrom,
      toOrdinal: currentTo,
    });
    // overlap：保留尾部 token，但归属范围回退到重叠起始 turn 由下一次追加修正。
    const tail = currentTokens.slice(Math.max(0, currentTokens.length - overlapTokens));
    currentTokens = [...tail];
    currentFrom = currentTo;
  };
  for (const turn of turns) {
    const turnTokens = encode(turn.text);
    let offset = 0;
    while (offset < turnTokens.length || (offset === 0 && turnTokens.length === 0)) {
      const space = chunkTokens - currentTokens.length;
      if (space <= 0) { flush(); continue; }
      const take = turnTokens.slice(offset, offset + space);
      if (currentFrom === undefined) currentFrom = turn.ordinal;
      currentTo = turn.ordinal;
      currentTokens.push(...take);
      offset += take.length;
      if (currentTokens.length >= chunkTokens) flush();
      if (turnTokens.length === 0) break;
    }
  }
  if (currentTokens.length > 0) {
    chunks.push({ text: decode(currentTokens), fromOrdinal: currentFrom, toOrdinal: currentTo });
  }
  return chunks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const conversations = await readJsonl(path.join(args.corpus, "conversations.jsonl"));
  const runs = await readJsonl(path.join(args.corpus, "runs.jsonl"));
  const memoryRecords = await readOptionalJsonl(path.join(args.corpus, "records.jsonl"));

  const spaceByConversation = new Map(conversations.map((record) => [record.conversationId, record.ownerId]));
  const runsByConversation = new Map();
  for (const run of runs) {
    if (!runsByConversation.has(run.conversationId)) runsByConversation.set(run.conversationId, []);
    runsByConversation.get(run.conversationId).push(run);
  }
  for (const list of runsByConversation.values()) {
    list.sort((left, right) => left.ordinal - right.ordinal);
  }

  const encoder = encodingForModel("gpt-4o");
  const decode = (tokens) => encoder.decode(tokens);

  const chunkDocs = [];
  const summaryDocs = [];
  const recordDocs = memoryRecords.map((record) => {
    const sources = Array.isArray(record.sources) ? record.sources : [];
    const evidenceGroups = sources
      .filter((source) => typeof source.conversationId === "string")
      .map((source) => ({
        conversationId: source.conversationId,
        fromOrdinal: Number.isInteger(source.fromOrdinal) ? source.fromOrdinal : 1,
        toOrdinal: Number.isInteger(source.toOrdinal)
          ? source.toOrdinal
          : (Number.isInteger(source.fromOrdinal) ? source.fromOrdinal : 1),
      }));
    const ordinals = evidenceGroups.flatMap((group) => [group.fromOrdinal, group.toOrdinal]);
    const ownerId = typeof record.ownerKey === "string" && record.ownerKey.includes(":")
      ? record.ownerKey.slice(record.ownerKey.indexOf(":") + 1)
      : "global";
    return {
      lane: "record",
      docId: `record:${record.recordId}:${record.revision}`,
      conversationId: evidenceGroups[0]?.conversationId ?? "unknown",
      spaceId: ownerId,
      fromOrdinal: ordinals.length === 0 ? 1 : Math.min(...ordinals),
      toOrdinal: ordinals.length === 0 ? 1 : Math.max(...ordinals),
      evidenceGroups,
      text: record.modelText,
    };
  });
  for (const [conversationId, conversationRuns] of runsByConversation) {
    const spaceId = spaceByConversation.get(conversationId) ?? "unknown";
    const turns = conversationRuns.map((run) => ({ ordinal: run.ordinal, text: turnText(run) }));

    for (const [index, chunk] of chunkTurns(turns, (text) => encoder.encode(text), decode, args.chunkTokens, args.overlapTokens).entries()) {
      chunkDocs.push({
        lane: "chunk",
        docId: `chunk:${conversationId}:${index + 1}`,
        conversationId,
        spaceId,
        fromOrdinal: chunk.fromOrdinal,
        toOrdinal: chunk.toOrdinal,
        evidenceGroups: [{ conversationId, fromOrdinal: chunk.fromOrdinal, toOrdinal: chunk.toOrdinal }],
        text: chunk.text,
      });
    }

    // 工具链模式的确定性抽取式 summary：按 ordinal 拼接并截断到预算。
    // 正式评测时由辅助模型生成的 summary 以相同文档格式替换，指标不动。
    const fullText = turns.map((turn) => turn.text).join("\n");
    const summaryTokens = encoder.encode(fullText);
    const text = summaryTokens.length > args.summaryMaxTokens
      ? encoder.decode(summaryTokens.slice(0, args.summaryMaxTokens))
      : fullText;
    summaryDocs.push({
      lane: "summary",
      docId: `summary:${conversationId}`,
      conversationId,
      spaceId,
      fromOrdinal: turns[0]?.ordinal ?? 1,
      toOrdinal: turns.at(-1)?.ordinal ?? 1,
      evidenceGroups: [{ conversationId, fromOrdinal: turns[0]?.ordinal ?? 1, toOrdinal: turns.at(-1)?.ordinal ?? 1 }],
      text,
    });
  }

  const outDir = args.out ?? path.join(args.corpus, "lanes");
  const manifest = {
    corpus: args.corpus,
    chunk: { docCount: chunkDocs.length, chunkTokens: args.chunkTokens, overlapTokens: args.overlapTokens },
    summary: { docCount: summaryDocs.length, summaryMaxTokens: args.summaryMaxTokens, mode: "extract_toolchain" },
    record: { docCount: recordDocs.length, mode: recordDocs.length > 0 ? "memory_store_active_records" : "unavailable" },
    conversations: runsByConversation.size,
  };
  const asJsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");

  await mkdir(path.join(outDir, "chunk"), { recursive: true });
  await mkdir(path.join(outDir, "summary"), { recursive: true });
  if (recordDocs.length > 0) await mkdir(path.join(outDir, "record"), { recursive: true });
  await writeFile(path.join(outDir, "chunk", "docs.jsonl"), asJsonl(chunkDocs), "utf8");
  await writeFile(path.join(outDir, "summary", "docs.jsonl"), asJsonl(summaryDocs), "utf8");
  if (recordDocs.length > 0) await writeFile(path.join(outDir, "record", "docs.jsonl"), asJsonl(recordDocs), "utf8");
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const chunkTokenStats = chunkDocs.map((doc) => encoder.encode(doc.text).length);
  console.log(JSON.stringify({
    outDir,
    ...manifest,
    chunkTokenRange: chunkTokenStats.length > 0
      ? { min: Math.min(...chunkTokenStats), max: Math.max(...chunkTokenStats) }
      : null,
  }, null, 2));
}

main().catch((error) => {
  console.error("[eval-build-lanes] lane build failed:", error?.message ?? error);
  process.exitCode = 1;
});
