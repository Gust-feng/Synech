import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { createSqliteMemoryDocumentRepository, createSqliteMemoryControlRepository, createMemoryCaptureRuntime, createMemoryAdminApplication, createControlMemoryLifecycle, createMemoryHistoryQueryPort, POLICY_KEY } from "../dist/app/memory/composition.js";
import { lexicalMatchExpression } from "../dist/app/memory/recall/lexical-projection.js";

async function withHarness(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-capture-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  const now = options.now ?? (() => 10_000);
  // 全局 enabled + rollout active；没有逐 owner participation。
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
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

test("effective off (global switch disabled) skips without creating jobs or advancing progress", async () => {
  await withHarness(async ({ control, documents, runtime }) => {
    // ADR 0018：用户只有全局开关；Space 与 second Space 同源，关掉开关对所有 owner 生效。
    await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: false });
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

function captureAdmin(control, documents, owner, highwater) {
  const lifecycle = createControlMemoryLifecycle(control, { documentRepository: documents });
  return createMemoryAdminApplication({
    controlRepository: control, documentRepository: documents, lifecycle,
    spaceAdmission: { assertAvailable() {}, admit: async (_id, operation) => await operation() },
    workspaceAdmission: { admit: async (_id, operation) => await operation() },
    ownerExistsQuery: { isSpaceAvailable: async () => true, isWorkspaceAvailable: async () => true },
    conversationHighWaterQuery: { listConversationHighWaters: async () => [{ conversationId: "c1", ownerKey: owner.kind + ":" + owner.id, allocatedThroughOrdinal: highwater() }] },
  });
}

function captureEvidence(texts, beforeRead = async () => {}) {
  return { async readTurnWindow({ fromOrdinal, through }) {
    await beforeRead();
    const turns = texts.flatMap((text, index) => {
      const ordinal = index + 1;
      return ordinal < fromOrdinal || ordinal > through.ordinal ? [] : [{
        turnId: "u" + ordinal, ordinal, role: "user", text, runId: "r" + ordinal,
        occurredAt: "2026-10-03T00:00:00.000Z", sourceRevision: ordinal,
      }];
    });
    return { turns, nextCursor: turns.length === 0 ? undefined : { conversationId: "c1", coveredThroughOrdinal: turns.at(-1).ordinal, sourceFingerprint: "rev:" + turns.at(-1).ordinal } };
  } };
}

test("re-enabling preserves authorized history but never indexes or reads the disabled interval", async () => {
  const owner = { kind: "space", id: "s2" };
  const reader = captureEvidence(["ALLOWED_BEFORE", "DISABLED_SECRET_TWO", "DISABLED_SECRET_THREE", "ALLOWED_AFTER " + "continuation ".repeat(1000)]);
  await withHarness(async ({ control, documents, runtime }) => {
    await runtime.acceptStableSignal({ owner, conversationId: "c1", stableThrough: stableThrough(1) });
    let highwater = 1;
    const admin = captureAdmin(control, documents, owner, () => highwater);
    await admin.setEnabled({ enabled: false });
    highwater = 3;
    await admin.setEnabled({ enabled: true });
    await runtime.acceptStableSignal({ owner, conversationId: "c1", stableThrough: stableThrough(4) });
    const ordinals = await documents.listTranscriptOrdinals({ ownerKey: "space:s2", conversationId: "c1", fromOrdinal: 1, limit: 20 });
    assert.deepEqual(ordinals, [1, 4]);
    const history = createMemoryHistoryQueryPort({ controlRepository: control, documentRepository: documents, evidenceReader: reader,
      conversationLookup: { resolveConversationOwner: async () => owner } });
    const search = await history.search({ owner, query: "DISABLED_SECRET_TWO", sources: "transcript", limit: 8 });
    assert.equal(search.items.length, 0);
    const chunks = [];
    const visited = new Set();
    let position = {};
    for (let count = 0; ; count += 1) {
      assert.ok(count < 30, "authorized transcript pagination must converge");
      const read = await history.read({ owner, conversationId: "c1", source: "transcript", limitTokens: 1000, ...position });
      assert.equal(read.outcome, "ok");
      assert.doesNotMatch(read.text, /DISABLED_SECRET/);
      chunks.push(read.text);
      if (!read.truncated) break;
      assert.ok([1, 4].includes(read.nextFromOrdinal), "continuation must stay on captured ordinals");
      const cursor = `${read.nextFromOrdinal}:${read.nextFragmentStart ?? 0}`;
      assert.ok(!visited.has(cursor), "continuation must advance");
      visited.add(cursor);
      position = { fromOrdinal: read.nextFromOrdinal, fragmentStart: read.nextFragmentStart };
    }
    assert.match(chunks.join(""), /ALLOWED_BEFORE/);
    assert.match(chunks.join(""), /ALLOWED_AFTER/);
    let page = await history.read({ owner, conversationId: "c1", source: "transcript", limitTokens: 200 });
    assert.equal(page.outcome, "ok");
    assert.equal(page.truncated, true);
    assert.equal(page.nextFromOrdinal, 4, "pagination must not point into the excluded gap");
    if (page.nextFragmentStart === undefined) {
      page = await history.read({ owner, conversationId: "c1", source: "transcript", fromOrdinal: page.nextFromOrdinal, limitTokens: 200 });
      assert.equal(page.outcome, "ok");
      assert.equal(page.truncated, true);
      assert.equal(page.nextFromOrdinal, 4);
    }
    assert.ok(page.nextFragmentStart > 0);
    assert.doesNotMatch(page.text, /DISABLED_SECRET/);
    const continuation = await history.read({ owner, conversationId: "c1", source: "transcript",
      fromOrdinal: page.nextFromOrdinal, fragmentStart: page.nextFragmentStart, limitTokens: 200 });
    assert.equal(continuation.outcome, "ok");
    assert.doesNotMatch(continuation.text, /ALLOWED_BEFORE|DISABLED_SECRET|ALLOWED_AFTER/);
  }, { evidenceReader: reader });
});

test("capture publication rejects clear, disable and branch changes while evidence is awaiting", async () => {
  for (const action of ["owner_clear", "global_clear", "disable", "branch_change"]) {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const reader = captureEvidence(["REVOKED_CONTENT"], async () => { entered(); await gate; });
    await withHarness(async ({ control, documents, runtime, database }) => {
      const owner = { kind: "space", id: "s1" };
      const admin = captureAdmin(control, documents, owner, () => 1);
      const pending = runtime.acceptStableSignal({ owner, conversationId: "c1", stableThrough: stableThrough(1) });
      await started;
      if (action === "disable") await admin.setEnabled({ enabled: false });
      else if (action === "branch_change") await createControlMemoryLifecycle(control, { documentRepository: documents })
        .supersedeConversationSources({ conversationId: "c1", owner, retainedThroughOrdinal: 1 });
      else await admin.clearMemory({ scope: action === "global_clear" ? { kind: "global" } : owner });
      release();
      assert.equal((await pending).status, "skipped", action);
      assert.equal(database.connection.prepare("SELECT COUNT(*) AS count FROM memory_transcript_fts").get().count, 0, action);
      assert.equal((await control.listJobsByStatus("queued")).length, 0, action);
    }, { evidenceReader: reader });
  }
});

test("clear between index publication and job registration cannot recreate a stale job", async () => {
  await withHarness(async ({ control, documents, runtime }) => {
    const owner = { kind: "space", id: "s1" };
    const admin = captureAdmin(control, documents, owner, () => 1);
    const index = documents.indexTranscriptRange.bind(documents);
    documents.indexTranscriptRange = async input => {
      const result = await index(input);
      await admin.clearMemory({ scope: owner });
      return result;
    };
    assert.equal((await runtime.acceptStableSignal({ owner, conversationId: "c1", stableThrough: stableThrough(1) })).status, "skipped");
    assert.equal((await control.listJobsByStatus("queued")).length, 0);
    assert.equal(await documents.getTranscriptCoverage("c1"), undefined);
  }, { evidenceReader: captureEvidence(["CLEARED"]) });
});
