#!/usr/bin/env node
/**
 * Freeze a real offline-evaluation corpus after validating its hard shape
 * requirements (《手册》17.2). This never treats the seed corpus as a release
 * corpus: the seed has fewer than 60 queries and is intentionally rejected.
 *
 * Usage:
 *   node scripts/eval-freeze-corpus.mjs --corpus <dir> --out <frozen-dir>
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

const REQUIRED_SCENARIOS = [
  "decision_reversal",
  "rename_continuity",
  "open_loop_completion",
  "old_decision_recall",
  "stable_preference",
  "unanswerable",
  "cross_space_negative",
  "post_clear",
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag === "--corpus" || flag === "--out") && value !== undefined) {
      args[flag.slice(2)] = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error("Usage: node scripts/eval-freeze-corpus.mjs --corpus <dir> --out <frozen-dir>");
  }
  if (args.corpus === undefined || args.out === undefined) {
    throw new Error("Both --corpus <dir> and --out <frozen-dir> are required.");
  }
  return args;
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, "utf8");
  return text.split("\n").filter((line) => line.trim().length > 0).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(filePath + ":" + (index + 1) + " is not valid JSON.", { cause: error });
    }
  });
}

function assert(condition, message) {
  if (!condition) throw new Error("Corpus cannot be frozen: " + message);
}

function validateCorpus(conversations, runs, queries) {
  assert(queries.length >= 60 && queries.length <= 80, "query count must be 60..80, received " + queries.length);
  const conversationIds = new Set(conversations.map((conversation) => conversation.conversationId));
  const spaceIds = new Set(conversations.map((conversation) => conversation.ownerId).filter((id) => typeof id === "string"));
  assert(conversationIds.size === conversations.length, "conversationId values must be unique");

  const runIds = new Set();
  for (const run of runs) {
    assert(typeof run.runId === "string" && run.runId.length > 0, "every run needs runId");
    assert(!runIds.has(run.runId), "duplicate runId " + run.runId);
    runIds.add(run.runId);
    assert(conversationIds.has(run.conversationId), "run " + run.runId + " references an unknown conversation");
    assert(Number.isInteger(run.ordinal) && run.ordinal >= 1, "run " + run.runId + " has an invalid ordinal");
  }

  const queryIds = new Set();
  const scenarioCounts = new Map();
  for (const query of queries) {
    assert(typeof query.queryId === "string" && query.queryId.length > 0, "every query needs queryId");
    assert(!queryIds.has(query.queryId), "duplicate queryId " + query.queryId);
    queryIds.add(query.queryId);
    assert(REQUIRED_SCENARIOS.includes(query.scenarioClass), "query " + query.queryId + " has unsupported scenario " + query.scenarioClass);
    scenarioCounts.set(query.scenarioClass, (scenarioCounts.get(query.scenarioClass) ?? 0) + 1);
    assert(conversationIds.has(query.homeConversationId), "query " + query.queryId + " references an unknown home conversation");
    assert(spaceIds.has(query.spaceId), "query " + query.queryId + " references an unknown Space");
    assert(Number.isInteger(query.asOfOrdinal) && query.asOfOrdinal >= 1, "query " + query.queryId + " has an invalid asOfOrdinal");
    assert(Array.isArray(query.evidenceGroups), "query " + query.queryId + " has no evidenceGroups array");
    for (const group of query.evidenceGroups) {
      assert(conversationIds.has(group.conversationId), "query " + query.queryId + " references an unknown evidence conversation");
      assert(Number.isInteger(group.fromOrdinal) && Number.isInteger(group.toOrdinal), "query " + query.queryId + " has an invalid evidence range");
      assert(group.fromOrdinal >= 1 && group.toOrdinal >= group.fromOrdinal, "query " + query.queryId + " has a reversed evidence range");
      if (group.conversationId === query.homeConversationId) {
        assert(group.toOrdinal < query.asOfOrdinal, "query " + query.queryId + " leaks future evidence");
      }
    }
  }
  for (const scenario of REQUIRED_SCENARIOS) {
    assert((scenarioCounts.get(scenario) ?? 0) >= 7, scenario + " needs at least 7 queries");
  }
  return Object.fromEntries([...scenarioCounts].sort(([left], [right]) => left.localeCompare(right)));
}

async function sha256(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = ["conversations.jsonl", "runs.jsonl", "queries.jsonl"];
  const inputPaths = files.map((file) => path.join(args.corpus, file));
  const [conversations, runs, queries] = await Promise.all(inputPaths.map(readJsonl));
  const scenarioCounts = validateCorpus(conversations, runs, queries);
  await mkdir(args.out, { recursive: true });
  const manifestPath = path.join(args.out, "freeze-manifest.json");
  const destinations = [...files.map((file) => path.join(args.out, file)), manifestPath];
  for (const destination of destinations) {
    try {
      await readFile(destination);
      throw new Error("Refusing to overwrite existing frozen file: " + destination);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const file of files) {
    const destination = path.join(args.out, file);
    await copyFile(path.join(args.corpus, file), destination);
  }
  const manifest = {
    kind: "synech-eval-corpus-freeze/v1",
    source: args.corpus,
    frozenAt: new Date().toISOString(),
    conversations: conversations.length,
    runs: runs.length,
    queries: queries.length,
    scenarioCounts,
    files: Object.fromEntries(await Promise.all(files.map(async (file) => [file, await sha256(path.join(args.out, file))]))),
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ out: args.out, ...manifest }, null, 2));
}

main().catch((error) => {
  console.error("[eval-freeze-corpus] failed:", error?.message ?? error);
  process.exitCode = 1;
});
