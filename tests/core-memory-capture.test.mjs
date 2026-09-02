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
import {
  POLICY_KEY,
  participationKey,
} from "../dist/app/memory/policy/policy-snapshot.js";

// 被测不变量（《手册》9.1/9.2）：
// - 真实 Capture 经 Policy Gate（持久化行 → 当次重算，fail-closed）决定接单与否；
// - accepted 只在达到最小完整轮次门后出现，且 durable job 落盘（重启可枚举）；
// - owner fence 与轮次不足都不得落 job。

const OWNER = { kind: "space", id: "s1" };
const OWNER_KEY = "space:s1";
const CONVERSATION_ID = "conv-1";

// 证据读取口 stub：模拟 Ordinary 稳定 run 投影的「连续无洞」语义
// （availableOrdinals 按升序给定，一旦断洞或越过 through 立即停止）。
function fakeEvidenceReader(availableOrdinals, calls = []) {
  return {
    async readTurnWindow({ conversationId, fromOrdinal, through }) {
      calls.push({ conversationId, fromOrdinal, through });
      const turns = [];
      let coveredThrough;
      let expected = fromOrdinal;
      for (const ordinal of availableOrdinals) {
        if (ordinal !== expected || ordinal > through.ordinal) break;
        turns.push({
          turnId: `u${ordinal}`,
          ordinal,
          role: "user",
          text: `turn ${ordinal}`,
          runId: `run-${ordinal}`,
          occurredAt: "2026-09-02T00:00:00.000Z",
          sourceRevision: through.sourceRevision,
        });
        coveredThrough = ordinal;
        expected += 1;
      }
      const nextCursor = coveredThrough === undefined ? undefined : {
        conversationId,
        coveredThroughOrdinal: coveredThrough,
        sourceFingerprint: `rev:${through.sourceRevision}`,
      };
      return { turns, nextCursor };
    },
  };
}

const signalThrough = (ordinal) => ({
  owner: OWNER,
  conversationId: CONVERSATION_ID,
  stableThrough: { turnId: `u${ordinal}`, ordinal, sourceRevision: 10 + ordinal },
});

async function admitSpaceOwner(controlRepository, { rollout = "active" } = {}) {
  await controlRepository.setPolicy({
    key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true,
  });
  if (rollout !== "off") {
    await controlRepository.setPolicy({
      key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: rollout, enabled: true,
    });
  }
  await controlRepository.setPolicy({
    key: participationKey(OWNER_KEY), kind: "scope_participation", scopeOwnerKey: OWNER_KEY, enabled: true,
  });
}

async function withRuntime(run, { availableOrdinals = [1, 2, 3], evidenceCalls = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-capture-"));
  const filePath = path.join(dir, "synech.sqlite3");
  const database = new SqliteRuntimeDatabase(filePath);
  const controlRepository = createSqliteMemoryControlRepository(database, {
    idFactory: (() => { let n = 0; return () => `memjob-${++n}`; })(),
  });
  const contentRepository = createSqliteMemoryContentRepository(database);
  const runtime = createMemoryRuntime({
    controlRepository,
    contentRepository,
    evidenceReader: fakeEvidenceReader(availableOrdinals, evidenceCalls),
  });
  try {
    await run({ runtime, controlRepository, database, filePath, evidenceCalls });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("absent content/evidence composition keeps capture as noop skip", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-capture-noop-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  try {
    const runtime = createMemoryRuntime({
      controlRepository: createSqliteMemoryControlRepository(database),
    });
    const acceptance = await runtime.captureRuntime.acceptStableSignal(signalThrough(2));
    assert.deepEqual(acceptance, { status: "skipped", reason: "memory_capture_disabled" });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("capture is fail-closed without persisted policy rows", async () => {
  await withRuntime(async ({ runtime, controlRepository }) => {
    const acceptance = await runtime.captureRuntime.acceptStableSignal(signalThrough(3));
    assert.equal(acceptance.status, "skipped");
    assert.equal(acceptance.reason, "global_consent");
    assert.equal((await controlRepository.listJobsByStatus("queued")).length, 0);
  });
});

test("consent with active rollout accepts and the durable job survives reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-capture-accept-"));
  const filePath = path.join(dir, "synech.sqlite3");
  try {
    const first = new SqliteRuntimeDatabase(filePath);
    const controlRepository = createSqliteMemoryControlRepository(first, {
      idFactory: (() => { let n = 0; return () => `memjob-${++n}`; })(),
    });
    const contentRepository = createSqliteMemoryContentRepository(first);
    const runtime = createMemoryRuntime({
      controlRepository,
      contentRepository,
      evidenceReader: fakeEvidenceReader([1, 2, 3]),
    });
    await admitSpaceOwner(controlRepository);

    const acceptance = await runtime.captureRuntime.acceptStableSignal(signalThrough(2));
    assert.equal(acceptance.status, "accepted");
    assert.equal(acceptance.checkpoint.conversationId, CONVERSATION_ID);
    assert.equal(acceptance.checkpoint.coveredThroughOrdinal, 2);
    first.close();

    // durable job 边界落盘：进程随后退出也不丢证据段。
    const second = new SqliteRuntimeDatabase(filePath);
    const reopened = createSqliteMemoryControlRepository(second);
    const queued = await reopened.listJobsByStatus("queued");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].conversationId, CONVERSATION_ID);
    assert.equal(queued[0].ownerKey, OWNER_KEY);
    assert.equal(queued[0].coveredThroughOrdinal, 2);
    assert.equal(queued[0].coveredThroughTurnId, "u2");
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner fence blocks capture even when all policy gates are open", async () => {
  await withRuntime(async ({ runtime, controlRepository }) => {
    await admitSpaceOwner(controlRepository);
    await controlRepository.setLifecycleFence(OWNER_KEY, "fenced");
    const acceptance = await runtime.captureRuntime.acceptStableSignal(signalThrough(3));
    assert.deepEqual(acceptance, { status: "skipped", reason: "generation_fence" });
    assert.equal((await controlRepository.listJobsByStatus("queued")).length, 0);
  });
});

test("windows below the minimum full-turn gate are skipped without enqueueing a job", async () => {
  await withRuntime(
    async ({ runtime, controlRepository }) => {
      await admitSpaceOwner(controlRepository);
      const acceptance = await runtime.captureRuntime.acceptStableSignal(signalThrough(1));
      assert.deepEqual(acceptance, { status: "skipped", reason: "below_capture_threshold" });
      assert.equal((await controlRepository.listJobsByStatus("queued")).length, 0);
    },
    { availableOrdinals: [1] },
  );
});
