import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  createSqliteMemoryDocumentRepository,
  createSqliteMemoryControlRepository,
  createMemoryCaptureRuntime,
  POLICY_KEY,
  spaceParticipationKey,
} from "../dist/app/memory/index.js";
import { lexicalMatchExpression } from "../dist/app/memory/recall/lexical-projection.js";

async function withHarness(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-capture-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  const now = options.now ?? (() => 10_000);
  // 默认 policy：全局同意 + Space 参与 + rollout active。
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: spaceParticipationKey("s1"), kind: "space_participation", scopeOwnerKey: "space:s1", enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
  const runtime = createMemoryCaptureRuntime({
    controlRepository: control,
    documentRepository: documents,
    evidenceReader: options.evidenceReader ?? { async readTurnWindow() { return { turns: [], nextCursor: undefined }; } },
    idleDelayMs: options.idleDelayMs ?? 270_000,
    now,
  });
  try {
    await run({ control, documents, runtime, database });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const stableThrough = (ordinal) => ({ turnId: `u${ordinal}`, ordinal, sourceRevision: ordinal });

test("accepted signal registers a durable per-conversation job with eligibleAt = stableAt + idle", async () => {
  await withHarness(async ({ control, runtime }) => {
    const acceptance = await runtime.acceptStableSignal({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      stableThrough: stableThrough(2),
    });
    assert.equal(acceptance.status, "accepted");
    assert.equal(acceptance.eligibleAt, 10_000 + 270_000);
    const queued = await control.listJobsByStatus("queued");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].requestedThroughOrdinal, 2);
  });
});

test("effective off (no consent) skips without creating jobs or advancing progress", async () => {
  await withHarness(async ({ control, documents, runtime }) => {
    const acceptance = await runtime.acceptStableSignal({
      owner: { kind: "space", id: "s2" },
      conversationId: "c-other",
      stableThrough: stableThrough(2),
    });
    assert.equal(acceptance.status, "skipped");
    assert.equal((await control.listJobsByStatus("queued")).length, 0);
    assert.equal(await documents.getProgress("c-other"), undefined);
  });
});

test("signals without new evidence beyond processed/excluded floor are skipped", async () => {
  await withHarness(async ({ control, runtime, documents }) => {
    await documents.setExcludedThrough({
      conversationId: "c1", ownerKey: "space:s1", excludedThroughOrdinal: 5, now: 1,
    });
    const acceptance = await runtime.acceptStableSignal({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      stableThrough: stableThrough(5),
    });
    assert.equal(acceptance.status, "skipped");
    assert.equal((await control.listJobsByStatus("queued")).length, 0);
  });
});

test("transcript index advances incrementally with signals and is independently searchable", async () => {
  const turnsFor = (from, through) => {
    const turns = [];
    for (let ordinal = from; ordinal <= through.ordinal; ordinal += 1) {
      turns.push({
        turnId: `u${ordinal}`, ordinal, role: "user", text: `第${ordinal}轮讨论安装器设计`,
        runId: `r${ordinal}`, occurredAt: "2026-09-05T00:00:00.000Z", sourceRevision: ordinal,
      });
      turns.push({
        turnId: `a${ordinal}`, ordinal, role: "assistant", text: `第${ordinal}轮回复`,
        runId: `r${ordinal}`, occurredAt: "2026-09-05T00:00:01.000Z", sourceRevision: ordinal,
      });
    }
    return turns;
  };
  await withHarness(async ({ documents, runtime }) => {
    await runtime.acceptStableSignal({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      stableThrough: stableThrough(2),
    });
    const coverage = await documents.getTranscriptCoverage("c1");
    assert.equal(coverage.indexedThroughOrdinal, 2);
    const hits = await documents.searchTranscript({ ownerKey: "space:s1", match: lexicalMatchExpression("安装器"), limit: 8 });
    assert.equal(hits.length, 2);
    assert.ok(hits.every((hit) => hit.conversationId === "c1"));
  }, {
    evidenceReader: {
      async readTurnWindow({ conversationId, fromOrdinal, through }) {
        const turns = turnsFor(fromOrdinal, through);
        return {
          turns,
          nextCursor: turns.length === 0 ? undefined : {
            conversationId,
            coveredThroughOrdinal: through.ordinal,
            sourceFingerprint: `rev:${through.ordinal}`,
          },
        };
      },
    },
  });
});
