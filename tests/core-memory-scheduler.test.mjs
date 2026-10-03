import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { POLICY_KEY, createSqliteMemoryControlRepository, createSqliteMemoryDocumentRepository } from "../dist/app/memory/composition.js";
import { createMemoryMaintenanceScheduler } from "../dist/app/panel-server/memory/capture-scheduler.js";

/**
 * 调度器持续推进不变量（R03/R06）：到期任务与长会话余批必须被继续处理，
 * 无关会话的活动不得推迟已安排的更早唤醒。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withHarness(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-sched-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });

  const modelCalls = [];
  const model = {
    async generate({ messages }) {
      const payload = JSON.parse(messages[1].content);
      modelCalls.push(payload);
      return { status: "completed", text: JSON.stringify({
        status: "ready",
        conversationSummary: { markdown: `s-${modelCalls.length}`, sourceRefs: payload.evidence.map(item => item.id) },
        mutations: [],
        topics: [],
        overview: null,
      }) };
    },
  };
  const evidenceReader = {
    async readTurnWindow({ conversationId, fromOrdinal, through }) {
      const selected = [];
      for (let ordinal = fromOrdinal; ordinal <= through.ordinal; ordinal += 1) {
        const pad = options.padText ?? "";
        selected.push(
          { turnId: `u${conversationId}-${ordinal}`, ordinal, role: "user", text: `第${ordinal}轮。${pad}`, runId: `r-${conversationId}-${ordinal}`, occurredAt: "2026-09-05T00:00:00.000Z", sourceRevision: ordinal },
          { turnId: `a${conversationId}-${ordinal}`, ordinal, role: "assistant", text: `第${ordinal}轮回复。${pad}`, runId: `r-${conversationId}-${ordinal}`, occurredAt: "2026-09-05T00:00:01.000Z", sourceRevision: ordinal },
        );
      }
      return { turns: selected, nextCursor: selected.length === 0 ? undefined : {
        conversationId,
        coveredThroughOrdinal: selected.at(-1).ordinal,
        sourceFingerprint: `rev:${selected.at(-1).sourceRevision}`,
      } };
    },
  };
  // Production capture publishes authorized transcript identities before registering a job.
  const enqueueJob = async input => {
    const evidence = await evidenceReader.readTurnWindow({ conversationId: input.conversationId, fromOrdinal: 1,
      through: { ordinal: input.stableThroughOrdinal, sourceRevision: input.stableThroughOrdinal } });
    const entries = new Map();
    for (const turn of evidence.turns) {
      const previous = entries.get(turn.ordinal);
      entries.set(turn.ordinal, { ordinal: turn.ordinal, sourceRevision: turn.sourceRevision,
        text: previous === undefined ? turn.text : `${previous.text}\n${turn.text}` });
    }
    const coverage = await documents.indexTranscriptRange({ conversationId: input.conversationId, ownerKey: input.ownerKey,
      entries: [...entries.values()], now: input.now,
      publication: { policyRevision: input.policyRevision, generation: input.generation, conversationGeneration: 0 } });
    assert.equal(coverage?.indexedThroughOrdinal, input.stableThroughOrdinal, "scheduler fixture must publish authorized evidence identities");
    return control.acceptConversationSignal(input);
  };
  const scheduler = createMemoryMaintenanceScheduler({
    controlRepository: control,
    documentRepository: documents,
    evidenceReader,
    model,
    idleDelayMs: options.idleDelayMs ?? 270_000,
    ...(options.isConversationActive === undefined ? {} : { isConversationActive: options.isConversationActive }),
    now: options.now ?? Date.now,
  });
  try {
    await run({ control, documents, scheduler, modelCalls, database, enqueueJob });
  } finally {
    await scheduler.release();
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("R03: more than 16 due jobs are all processed across continued wakes", async () => {
  await withHarness(async ({ control, documents, scheduler, enqueueJob }) => {
    for (let index = 1; index <= 17; index += 1) {
      await enqueueJob({
        conversationId: `c${index}`, ownerKey: "space:s1", stableThroughOrdinal: 2,
        sourceFingerprint: "fp", eligibleAt: 100, now: 0,
        generation: 0, policyRevision: "g1:r1:gen0",
      });
    }
    await scheduler.recoverQueuedJobs();
    await sleep(900);
    const done = await control.listJobsByStatus("done");
    assert.equal(done.length, 17);
    const queued = await control.listJobsByStatus("queued");
    assert.equal(queued.length, 0);
    for (let index = 1; index <= 17; index += 1) {
      const progress = await documents.getProgress(`c${index}`);
      assert.equal(progress.processedThroughOrdinal, 2);
    }
  }, { idleDelayMs: 270_000 });
});

test("R03: a long conversation's remaining batches continue without new activity", async () => {
  await withHarness(async ({ control, documents, scheduler, modelCalls, enqueueJob }) => {
    await enqueueJob({
      conversationId: "c-long", ownerKey: "space:s1", stableThroughOrdinal: 6,
      sourceFingerprint: "fp", eligibleAt: 100, now: 0,
      generation: 0, policyRevision: "g1:r1:gen0",
    });
    await scheduler.recoverQueuedJobs();
    await sleep(1_500);
    // 每批装不下全部轮次，剩余批次靠持续唤醒处理到边界。
    const progress = await documents.getProgress("c-long");
    assert.equal(progress.processedThroughOrdinal, 6);
    assert.ok(modelCalls.length > 1, "the fixture must require continued batches without another activity signal");
    const queued = await control.listJobsByStatus("queued");
    assert.equal(queued.length, 0);
  }, {
    idleDelayMs: 270_000,
    // Both user and assistant evidence consume the bounded request capacity.
    padText: "detail ".repeat(1500),
  });
});

test("R06: unrelated activity does not postpone an already scheduled earlier wake", async () => {
  await withHarness(async ({ control, scheduler, enqueueJob }) => {
    // A：立即到期。
    await enqueueJob({
      conversationId: "c-a", ownerKey: "space:s1", stableThroughOrdinal: 2,
      sourceFingerprint: "fp", eligibleAt: Date.now() + 100, now: Date.now(),
      generation: 0, policyRevision: "g1:r1:gen0",
    });
    await scheduler.recoverQueuedJobs();
    // 50ms 后 B 的活动信号：不得把 A 的唤醒推迟到更晚。
    await sleep(50);
    scheduler.noteActivity({ conversationId: "c-b" });
    await sleep(900);
    const done = await control.listJobsByStatus("done");
    assert.equal(done.length, 1);
    assert.equal(done[0].conversationId, "c-a");
  }, { idleDelayMs: 5_000 });
});

test("N02: active jobs are deferred and cannot starve later eligible jobs", async () => {
  const activeConversations = new Set();
  await withHarness(async ({ control, documents, scheduler, enqueueJob }) => {
    // 17 个到期任务：前 16 个属于「恢复活动」的会话，第 17 个空闲。
    for (let index = 1; index <= 17; index += 1) {
      await enqueueJob({
        conversationId: `c${index}`, ownerKey: "space:s1", stableThroughOrdinal: 2,
        sourceFingerprint: "fp", eligibleAt: 100, now: 0,
        generation: 0, policyRevision: "g1:r1:gen0",
      });
      if (index <= 16) activeConversations.add(`c${index}`);
    }
    await scheduler.recoverQueuedJobs();
    await sleep(900);
    // 第 17 个不被前 16 个活动任务饿死。
    const done = await control.listJobsByStatus("done");
    assert.ok(done.some((job) => job.conversationId === "c17"), "the idle 17th job must be processed");
    // 活动任务被延期到未来而不是留在队首反复空转。
    const queued = await control.listJobsByStatus("queued");
    assert.equal(queued.length, 16);
    const nowMs = Date.now();
    assert.ok(queued.every((job) => job.eligibleAt > nowMs), "deferred jobs must not stay due");
  }, {
    idleDelayMs: 270_000,
    isConversationActive: async (conversationId) => activeConversations.has(conversationId),
  });
});
