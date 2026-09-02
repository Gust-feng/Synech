import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  createMemoryRuntime,
  createSqliteMemoryContentRepository,
  createSqliteMemoryControlRepository,
} from "../dist/app/memory/index.js";
import { consolidateJob } from "../dist/app/memory/capture/consolidation.js";
import { createMemoryCaptureScheduler } from "../dist/app/panel-server/memory/capture-scheduler.js";
import {
  POLICY_KEY,
  participationKey,
} from "../dist/app/memory/policy/policy-snapshot.js";

// 被测不变量（《手册》9.1/9.3/13.2，T21 Consolidation 提炼管线）：
// - 提炼成功后 Record + Source + Cursor + job 状态在同一事务原子提交；
// - 提交边界 admission 变化（off / revision 变化）整批废弃，游标不动；
// - 游标只推进到实际送入模型的最后一轮；
// - 模型输出引用越界轮次 → 整批废弃；
// - 模型不可用 → job 保持可重试，绝不伪造记录。

const OWNER = { kind: "space", id: "s1" };
const OWNER_KEY = "space:s1";
const CONVERSATION_ID = "conv-1";

function fakeEvidenceReader(availableOrdinals) {
  return {
    async readTurnWindow({ conversationId, fromOrdinal, through }) {
      const turns = [];
      for (const ordinal of availableOrdinals) {
        if (ordinal < fromOrdinal) continue;
        if (ordinal > through.ordinal) break;
        turns.push({
          turnId: `u${ordinal}`,
          ordinal,
          role: "user",
          text: `turn ${ordinal} text`,
          runId: `run-${ordinal}`,
          occurredAt: "2026-09-02T00:00:00.000Z",
          sourceRevision: 100 + ordinal,
        });
      }
      const nextCursor = turns.length === 0 ? undefined : {
        conversationId,
        coveredThroughOrdinal: turns.at(-1).ordinal,
        sourceFingerprint: `rev:${turns.at(-1).sourceRevision}`,
      };
      return { turns, nextCursor };
    },
  };
}

function stubModel() {
  const calls = [];
  let handler = () => ({ status: "unavailable", reason: "no_handler" });
  return {
    calls,
    setHandler(fn) { handler = fn; },
    port: {
      async extract(input) {
        calls.push(input.messages);
        return handler(input);
      },
    },
  };
}

const createOp = (from, to, text = "项目决定采用单一 SQLite 数据库存储。") => ({
  op: "create",
  kind: "decision",
  text,
  evidenceClass: "quoted_user_evidence",
  evidence: [{ fromOrdinal: from, toOrdinal: to }],
});

const completed = (operations) => ({
  status: "completed",
  text: JSON.stringify({ operations: Array.isArray(operations) ? operations : [operations] }),
});

async function withHarness(run, { availableOrdinals = [1, 2, 3] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-consolidation-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const content = createSqliteMemoryContentRepository(database);
  const reader = fakeEvidenceReader(availableOrdinals);
  const runtime = createMemoryRuntime({
    controlRepository: control,
    contentRepository: content,
    evidenceReader: reader,
  });
  const model = stubModel();
  const deps = {
    controlRepository: control,
    contentRepository: content,
    evidenceReader: reader,
    model: model.port,
  };
  try {
    await run({ database, control, content, runtime, model, reader, deps });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function admitOwner(control) {
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
  await control.setPolicy({ key: participationKey(OWNER_KEY), kind: "scope_participation", scopeOwnerKey: OWNER_KEY, enabled: true });
}

async function acceptJob(runtime, control, { throughOrdinal = 3 } = {}) {
  const acceptance = await runtime.captureRuntime.acceptStableSignal({
    owner: OWNER,
    conversationId: CONVERSATION_ID,
    stableThrough: { turnId: `u${throughOrdinal}`, ordinal: throughOrdinal, sourceRevision: 100 + throughOrdinal },
  });
  assert.equal(acceptance.status, "accepted");
  const queued = await control.listJobsByStatus("queued");
  assert.equal(queued.length, 1);
  return queued[0];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("consolidation commits record, sources, cursor and job atomically", async () => {
  await withHarness(async ({ control, content, model, runtime, deps }) => {
    await admitOwner(control);
    const job = await acceptJob(runtime, control);
    model.setHandler(() => completed(createOp(1, 3)));

    const outcome = await consolidateJob(deps, job.jobId);
    assert.equal(outcome.status, "completed");

    const active = await content.listActiveByOwner(OWNER_KEY);
    assert.equal(active.length, 1);
    assert.equal(active[0].kind, "decision");
    assert.equal(active[0].confirmation, "unconfirmed");
    assert.equal(active[0].status, "active");

    const sources = await content.listSources(active[0].recordId, active[0].revision);
    assert.equal(sources.length, 3);

    const cursor = await content.getCursor(CONVERSATION_ID);
    assert.equal(cursor.coveredThroughOrdinal, 3);
    assert.equal((await control.listJobsByStatus("done")).length, 1);
    assert.equal((await control.listJobsByStatus("queued")).length, 0);
    assert.equal((await control.listJobsByStatus("running")).length, 0);
  });
});

test("admission revoked during the model call discards the whole batch and keeps the cursor", async () => {
  await withHarness(async ({ control, content, model, runtime, deps }) => {
    await admitOwner(control);
    const job = await acceptJob(runtime, control);
    model.setHandler(async () => {
      await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: false });
      return completed(createOp(1, 3));
    });
    const outcome = await consolidateJob(deps, job.jobId);
    assert.equal(outcome.status, "deferred");
    assert.equal(outcome.reason, "admission_off");

    assert.deepEqual(await content.listActiveByOwner(OWNER_KEY), []);
    assert.equal(await content.getCursor(CONVERSATION_ID), undefined);
    assert.equal((await control.listJobsByStatus("queued")).length, 1);
  });
});

test("policy revision bump during the model call discards the batch even while still admitted", async () => {
  await withHarness(async ({ control, content, model, runtime, deps }) => {
    await admitOwner(control);
    const job = await acceptJob(runtime, control);
    model.setHandler(async () => {
      // 重新写入 enabled=true 的 consent：admission 仍为 on 但 policyRevision 已变化。
      await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
      return completed(createOp(1, 3));
    });
    const outcome = await consolidateJob(deps, job.jobId);
    assert.equal(outcome.status, "deferred");
    assert.equal(outcome.reason, "admission_revision_changed");
    assert.deepEqual(await content.listActiveByOwner(OWNER_KEY), []);
    assert.equal(await content.getCursor(CONVERSATION_ID), undefined);
  });
});

test("cursor only advances to the last turn actually fed to the model", async () => {
  await withHarness(async ({ control, content, model, runtime, deps }) => {
    await admitOwner(control);
    const job = await acceptJob(runtime, control);
    // 批 1 成功（针对轮 1 单轮），批 2 模型不可用 → 推进到批 1 实际入模的最后一轮 = 1，job 退回 queued。
    let callIndex = 0;
    model.setHandler((input) => {
      callIndex += 1;
      if (callIndex === 1) return completed(createOp(1, 1));
      return { status: "unavailable", reason: "model_provider_not_configured" };
    });
    const outcome = await consolidateJob({
      ...deps,
      countTokens: (text) => text.length,
      batchTokenBudget: 12,
    }, job.jobId);
    assert.equal(outcome.status, "retry_queued");
    const cursor = await content.getCursor(CONVERSATION_ID);
    assert.equal(cursor.coveredThroughOrdinal, 1, "cursor must equal last batch's last ordinal, not job's through");
    const active = await content.listActiveByOwner(OWNER_KEY);
    assert.equal(active.length, 1);
    assert.equal((await control.listJobsByStatus("queued")).length, 1);
  });
});

test("model output citing out-of-batch ordinals is discarded entirely", async () => {
  await withHarness(async ({ control, content, model, runtime, deps }) => {
    await admitOwner(control);
    const job = await acceptJob(runtime, control);
    model.setHandler(() => completed(createOp(1, 9)));
    const outcome = await consolidateJob(deps, job.jobId);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "evidence_out_of_batch_range");
    assert.deepEqual(await content.listActiveByOwner(OWNER_KEY), []);
    assert.equal(await content.getCursor(CONVERSATION_ID), undefined);
  });
});

test("model unavailable keeps the job retryable without writing any record", async () => {
  await withHarness(async ({ control, content, model, runtime, deps }) => {
    await admitOwner(control);
    const job = await acceptJob(runtime, control);
    model.setHandler(() => ({ status: "unavailable", reason: "model_provider_not_configured" }));
    const outcome = await consolidateJob(deps, job.jobId);
    assert.equal(outcome.status, "retry_queued");
    assert.deepEqual(await content.listActiveByOwner(OWNER_KEY), []);
    assert.equal(await content.getCursor(CONVERSATION_ID), undefined);
    assert.equal((await control.listJobsByStatus("queued")).length, 1);
  });
});

test("idle scheduler drains durable queued jobs after activity and stops on release", async () => {
  await withHarness(async ({ control, content, model, runtime, deps }) => {
    await admitOwner(control);
    await acceptJob(runtime, control);
    model.setHandler(() => completed(createOp(1, 3)));
    const diagnostics = [];
    const scheduler = createMemoryCaptureScheduler({
      ...deps,
      idleDelayMs: 20,
      onDiagnostic: (topic, error) => diagnostics.push({ topic, error }),
    });
    try {
      scheduler.noteActivity({ conversationId: CONVERSATION_ID });
      for (let waited = 0; waited < 2000; waited += 25) {
        if ((await control.listJobsByStatus("done")).length === 1) break;
        await sleep(25);
      }
      assert.equal((await control.listJobsByStatus("done")).length, 1);
      assert.equal((await content.listActiveByOwner(OWNER_KEY)).length, 1);
      assert.deepEqual(diagnostics, []);
    } finally {
      await scheduler.release();
    }
  });
});
