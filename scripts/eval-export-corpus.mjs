#!/usr/bin/env node
/**
 * Eval corpus exporter (T6/T17) — read-only toolchain validation for the offline
 * evaluation harness (docs/memory-system/离线评测调研.md, 《手册》17 章).
 *
 * Exports Ordinary's durably settled facts (conversation control + terminal run
 * snapshots) as JSONL through Ordinary's own zod-validated repository layer, so
 * the exporter never re-parses or re-interprets product files. It writes only to
 * the --out directory (default <ProductHome>/cache/eval-corpus) and never writes
 * into the Product schema or any owner's data directory.
 *
 * With --with-sessions (T17) it additionally reads each stable run's Pi session
 * transcript through the dependency's JsonlSessionRepo and fills assistantMessage
 * with the run's final assistant answer, aligning the real export with the seed
 * corpus (scripts/eval-seed-corpus.mjs). The run snapshot intentionally stores no
 * transcript copy — only durable leaf refs (OrdinaryRunSessionPhase) — so the
 * transcript read is the documented export extension point (调研 §3.2). Without
 * the flag the output is byte-compatible with the previous exporter (no
 * assistantMessage field).
 *
 * Not a product fact consumer: eval data lives outside the target schema and is
 * explicitly deletable (《手册》17.1).
 *
 * Usage: node scripts/eval-export-corpus.mjs [--home <ProductHome>] [--out <dir>] [--with-sessions]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import {
  createFileSystemOrdinaryConversationControlRepository,
  createFileSystemOrdinaryRunRepository,
} from "../dist/app/ordinary-agent/index.js";

/** Terminal statuses whose facts are durably settled (OrdinaryStableTerminalRunFacts). */
const STABLE_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);

function parseArgs(argv) {
  const args = { home: undefined, out: undefined, withSessions: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--with-sessions") {
      args.withSessions = true;
      continue;
    }
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

/**
 * Pi session transcript access (T17). Wiring mirrors the product's own
 * FileSystemAgentSessionRepository (src/adapters/intelligence/file-system-agent-session-repository.ts,
 * constructed in src/app/panel-server/panel-host.ts with NodeExecutionEnv
 * cwd = <ProductHome>/data/agent and sessionsRoot = <ProductHome>/data/agent/sessions,
 * see src/platform/storage/product-paths.ts).
 */
function createSessionTranscriptRepository(agentDataRoot) {
  const sessionsRoot = path.join(agentDataRoot, "sessions");
  return {
    sessionsRoot,
    repo: new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: agentDataRoot }), sessionsRoot }),
    /** One opened Session per sessionId so a conversation's transcript is read once per export. */
    opened: new Map(),
  };
}

/**
 * AgentSessionRef → JsonlSessionMetadata, mirroring the product adapter's
 * metadataFromRef/pathFromStorageKey: storageKey is sessionsRoot-relative and
 * must resolve inside the sessions root (pi-agent-core JsonlSessionRepo.open
 * reads metadata.path directly).
 */
function jsonlMetadataFromSessionRef(sessionsRoot, sessionRef) {
  const resolved = path.resolve(sessionsRoot, sessionRef.storageKey);
  const relative = path.relative(sessionsRoot, resolved);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`session storageKey "${sessionRef.storageKey}" does not resolve inside the sessions root`);
  }
  // Fields per pi-agent-core dist/harness/types.d.ts JsonlSessionMetadata.
  return { id: sessionRef.sessionId, cwd: sessionRef.sessionCwd, createdAt: sessionRef.createdAt, path: resolved };
}

function openTranscriptSession(transcript, sessionRef) {
  const cached = transcript.opened.get(sessionRef.sessionId);
  if (cached !== undefined) return cached;
  const opened = transcript.repo.open(jsonlMetadataFromSessionRef(transcript.sessionsRoot, sessionRef));
  transcript.opened.set(sessionRef.sessionId, opened);
  return opened;
}

/**
 * Resolves one stable run's final assistant answer from its Pi session
 * transcript using the run snapshot's durable leaf refs (OrdinaryRunSessionPhase,
 * src/app/ordinary-agent/contracts.ts):
 *
 * - "not_started"/"started" have no durable end leaf → no durable answer (null).
 * - "rollbackable" endLeafRef: a completed run settles with the assistant
 *   response entry as its end leaf (ordinary-agent state.ts sessionAfter:
 *   "complete" requires the completion candidate as the rollbackable end leaf),
 *   so the end leaf IS the final answer. failed/cancelled/blocked runs settle
 *   at their rollback leaf, which is never an assistant response → null.
 * - "completion_candidate" is not a settled phase but is handled defensively
 *   via assistantEntryRef, mirroring conversation-projection.ts.
 *
 * The start leaf is used as the interval bound only: it must be an ancestor of
 * the end leaf on the session tree, otherwise the run's slice cannot be proven
 * and we return an anomaly instead of guessing text from outside the run.
 *
 * Message filtering follows the product adapter (readAssistantEntries): an
 * entry counts only when entry.type === "message" && entry.message.role ===
 * "assistant" (never by position), and text is the concatenation of its
 * "text" content blocks. Never throws: failures come back as marked results
 * so one unreadable transcript cannot abort the whole export.
 */
async function readRunAssistantMessage(transcript, state) {
  const phase = state.session.phase;
  const endRef = phase === "rollbackable"
    ? state.session.endLeafRef
    : phase === "completion_candidate"
      ? state.session.assistantEntryRef
      : null;
  if (endRef === null) return { text: null };
  if (endRef.sessionId !== state.sessionRef.sessionId) {
    return { text: null, anomaly: `end entry ${endRef.entryId} belongs to session ${endRef.sessionId}, not ${state.sessionRef.sessionId}` };
  }
  let session;
  try {
    session = await openTranscriptSession(transcript, state.sessionRef);
  } catch (error) {
    return { text: null, unreadable: error?.message ?? String(error) };
  }
  try {
    // getBranch returns the tree path root → given entry, inclusive, oldest
    // first (pi-agent-core Session.getBranch → JsonlSessionStorage.getPathToRoot).
    const branch = await session.getBranch(endRef.entryId);
    const startLeafRef = state.session.startLeafRef;
    if (startLeafRef !== null && startLeafRef !== undefined &&
        !branch.some((entry) => entry.id === startLeafRef.entryId)) {
      return {
        text: null,
        anomaly: `start leaf ${startLeafRef.entryId} is not an ancestor of end leaf ${endRef.entryId}`,
      };
    }
    const endEntry = branch.at(-1);
    if (endEntry === undefined || endEntry.type !== "message" || endEntry.message.role !== "assistant") {
      return { text: null };
    }
    const text = endEntry.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return { text };
  } catch (error) {
    return { text: null, unreadable: error?.message ?? String(error) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const productHome = args.home ?? resolveDefaultProductHome();
  const agentDataRoot = path.join(productHome, "data", "agent");
  const outDir = args.out ?? path.join(productHome, "cache", "eval-corpus");

  const runRepository = createFileSystemOrdinaryRunRepository(agentDataRoot);
  const conversationRepository = createFileSystemOrdinaryConversationControlRepository(agentDataRoot);
  // T17: transcript reading is opt-in so the default export stays backward compatible.
  const transcript = args.withSessions ? createSessionTranscriptRepository(agentDataRoot) : null;

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
  let assistantMessageCount = 0;
  let sessionTranscriptFailures = 0;
  let sessionRefAnomalies = 0;
  for (const summary of await runRepository.list()) {
    if (!STABLE_STATUSES.has(summary.status)) {
      skippedUnstable += 1;
      continue;
    }
    const document = await runRepository.get(summary.runId);
    if (document === undefined) continue;
    const state = document.state;
    let assistantMessage;
    if (transcript !== null) {
      const answer = await readRunAssistantMessage(transcript, state);
      if (answer.unreadable !== undefined) {
        sessionTranscriptFailures += 1;
        console.error(`[eval-export-corpus] run ${summary.runId} transcript unreadable: ${answer.unreadable}`);
      }
      if (answer.anomaly !== undefined) {
        sessionRefAnomalies += 1;
        console.error(`[eval-export-corpus] run ${summary.runId} session ref anomaly: ${answer.anomaly}`);
      }
      assistantMessage = answer.text;
    }
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
      // The user message is the durable canonical input. The final assistant
      // answer lives in the Pi session transcript (调研 §3.2 export extension
      // point): with --with-sessions it is read from the run's durable end
      // leaf (see readRunAssistantMessage); without the flag the field is
      // omitted so the default output stays byte-compatible.
      userMessage: state.input.userMessage,
      ...(transcript !== null ? { assistantMessage } : {}),
      sourceRevision: document.revision,
      createdAt: state.createdAt,
      terminalAt: state.terminalAt ?? null,
    };
    assertRecordShape(record, "run");
    if (transcript !== null &&
        typeof record.assistantMessage !== "string" && record.assistantMessage !== null) {
      throw new Error(`run record has invalid assistantMessage: ${JSON.stringify(record.assistantMessage).slice(0, 200)}`);
    }
    if (record.assistantMessage !== undefined && record.assistantMessage !== null) assistantMessageCount += 1;
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
    withSessions: args.withSessions,
    assistantMessages: transcript === null ? null : assistantMessageCount,
    sessionTranscriptFailures: transcript === null ? null : sessionTranscriptFailures,
    sessionRefAnomalies: transcript === null ? null : sessionRefAnomalies,
    files: { conversations: conversationPath, runs: runPath },
  }, null, 2));
}

main().catch((error) => {
  console.error("[eval-export-corpus] export failed:", error?.message ?? error);
  process.exitCode = 1;
});
