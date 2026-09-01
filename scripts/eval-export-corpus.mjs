#!/usr/bin/env node
/**
 * Eval corpus exporter (T6) — read-only toolchain validation for the offline
 * evaluation harness (docs/memory-system/离线评测调研.md, 《手册》17 章).
 *
 * Exports Ordinary's durably settled facts (conversation control + terminal run
 * snapshots) as JSONL through Ordinary's own zod-validated repository layer, so
 * the exporter never re-parses or re-interprets product files. It writes only to
 * the --out directory (default <ProductHome>/cache/eval-corpus) and never writes
 * into the Product schema or any owner's data directory.
 *
 * Not a product fact consumer: eval data lives outside the target schema and is
 * explicitly deletable (《手册》17.1).
 *
 * Usage: node scripts/eval-export-corpus.mjs [--home <ProductHome>] [--out <dir>]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  createFileSystemOrdinaryConversationControlRepository,
  createFileSystemOrdinaryRunRepository,
} from "../dist/app/ordinary-agent/index.js";

/** Terminal statuses whose facts are durably settled (OrdinaryStableTerminalRunFacts). */
const STABLE_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);

function parseArgs(argv) {
  const args = { home: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if ((argv[index] === "--home" || argv[index] === "--out") && value !== undefined) {
      args[argv[index].slice(2)] = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    }
  }
  return args;
}

function resolveDefaultProductHome() {
  if (process.env.SYNECH_HOME) return path.resolve(process.env.SYNECH_HOME);
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Synech");
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Synech");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "synech");
}

function assertRecordShape(record, kind) {
  const required = kind === "conversation"
    ? ["conversationId", "ownerKind", "createdAt", "sourceRevision"]
    : ["runId", "conversationId", "ordinal", "userTurnId", "status", "sourceRevision", "createdAt"];
  for (const field of required) {
    if (record[field] === undefined) {
      throw new Error(`${kind} record is missing required field "${field}": ${JSON.stringify(record).slice(0, 200)}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const productHome = args.home ?? resolveDefaultProductHome();
  const agentDataRoot = path.join(productHome, "data", "agent");
  const outDir = args.out ?? path.join(productHome, "cache", "eval-corpus");

  const runRepository = createFileSystemOrdinaryRunRepository(agentDataRoot);
  const conversationRepository = createFileSystemOrdinaryConversationControlRepository(agentDataRoot);

  const conversationRecords = [];
  for (const summary of await conversationRepository.list()) {
    const document = await conversationRepository.get(summary.conversationId);
    if (document === undefined) continue;
    const state = document.state;
    const record = {
      type: "conversation",
      conversationId: state.conversationId,
      ownerKind: state.owner.kind,
      ownerId: state.owner.kind === "global" ? null : state.owner.id,
      titleOverride: state.titleOverride ?? null,
      autoTitle: state.autoTitle ?? null,
      sessionRef: state.sessionRef.sessionId,
      createdAt: state.createdAt,
      sourceRevision: document.revision,
      deletedAt: state.deletedAt ?? null,
    };
    assertRecordShape(record, "conversation");
    conversationRecords.push(record);
  }

  const runRecords = [];
  let skippedUnstable = 0;
  for (const summary of await runRepository.list()) {
    if (!STABLE_STATUSES.has(summary.status)) {
      skippedUnstable += 1;
      continue;
    }
    const document = await runRepository.get(summary.runId);
    if (document === undefined) continue;
    const state = document.state;
    const record = {
      type: "run",
      runId: summary.runId,
      conversationId: state.turn.conversationId,
      ordinal: state.turn.ordinal,
      userTurnId: state.turn.userTurnId,
      assistantTurnId: state.turn.assistantTurnId,
      predecessorRunId: state.turn.predecessorRunId ?? null,
      status: state.status.kind,
      failure: state.status.kind === "failed" ? state.status.error : null,
      // The user message is the durable canonical input; the final assistant
      // answer lives in the Pi session transcript and is a documented export
      // extension point (调研 §3.2), not part of the run snapshot.
      userMessage: state.input.userMessage,
      sourceRevision: document.revision,
      createdAt: state.createdAt,
      terminalAt: state.terminalAt ?? null,
    };
    assertRecordShape(record, "run");
    runRecords.push(record);
  }

  await mkdir(outDir, { recursive: true });
  const conversationPath = path.join(outDir, "conversations.jsonl");
  const runPath = path.join(outDir, "runs.jsonl");
  await writeFile(conversationPath, conversationRecords.map((record) => JSON.stringify(record)).join("\n") + (conversationRecords.length > 0 ? "\n" : ""), "utf8");
  await writeFile(runPath, runRecords.map((record) => JSON.stringify(record)).join("\n") + (runRecords.length > 0 ? "\n" : ""), "utf8");

  console.log(JSON.stringify({
    productHome,
    outDir,
    conversations: conversationRecords.length,
    runs: runRecords.length,
    skippedUnstableRuns: skippedUnstable,
    files: { conversations: conversationPath, runs: runPath },
  }, null, 2));
}

main().catch((error) => {
  console.error("[eval-export-corpus] export failed:", error?.message ?? error);
  process.exitCode = 1;
});
