import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  createSqliteMemoryControlRepository,
} from "../dist/app/memory/index.js";

async function withStore(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-store-"));
  const filePath = path.join(dir, "synech.sqlite3");
  const database = new SqliteRuntimeDatabase(filePath);
  const repository = createSqliteMemoryControlRepository(database, {
    idFactory: (() => { let n = 0; return () => `memjob-${++n}`; })(),
  });
  try {
    await run({ repository, database, filePath });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const signal = (overrides = {}) => ({
  conversationId: "c1",
  ownerKey: "space:s1",
  stableThroughOrdinal: 2,
  sourceFingerprint: "fp1",
  eligibleAt: 1_000,
  now: 900,
  generation: 0,
  policyRevision: "p1",
  ...overrides,
});

test("durable job boundary survives repository/database recreation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-reopen-"));
  const filePath = path.join(dir, "synech.sqlite3");
  try {
    const first = new SqliteRuntimeDatabase(filePath);
    const repo1 = createSqliteMemoryControlRepository(first);
    await repo1.acceptConversationSignal(signal());
    first.close();

    const second = new SqliteRuntimeDatabase(filePath);
    const repo2 = createSqliteMemoryControlRepository(second);
    const queued = await repo2.listJobsByStatus("queued");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].conversationId, "c1");
    assert.equal(queued[0].requestedThroughOrdinal, 2);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("interrupted running jobs return to queued with attempt increment on recovery", async () => {
  await withStore(async ({ repository }) => {
    const job = await repository.acceptConversationSignal(signal());
    const claimed = await repository.claimJob({ jobId: job.jobId, claimToken: "claim-1", now: 1_100 });
    assert.equal(claimed.status, "running");
    assert.equal(claimed.targetThroughOrdinal, 2);
    assert.equal(claimed.attempt, 1);

    const recovered = await repository.recoverInterruptedJobs();
    assert.equal(recovered, 1);
    const queued = await repository.listJobsByStatus("queued");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].attempt, 2);
    assert.equal(queued[0].claimToken, null);
  });
});

test("a newer signal extends the active job and resets the attempt budget; an older signal cannot regress it", async () => {
  await withStore(async ({ repository }) => {
    await repository.acceptConversationSignal(signal({ stableThroughOrdinal: 3 }));
    const extended = await repository.acceptConversationSignal(signal({ stableThroughOrdinal: 6, now: 950, eligibleAt: 1_050 }));
    assert.equal(extended.requestedThroughOrdinal, 6);
    assert.equal(extended.eligibleAt, 1_050);
    assert.equal(extended.attempt, 0);

    // 迟到的旧信号：不缩小边界、不重置空闲计时。
    const stale = await repository.acceptConversationSignal(signal({ stableThroughOrdinal: 4, eligibleAt: 9_000 }));
    assert.equal(stale.requestedThroughOrdinal, 6);
    assert.equal(stale.eligibleAt, 1_050);
  });
});

test("claim is CAS: only one claimer wins and finishing requires the same claim token", async () => {
  await withStore(async ({ repository }) => {
    const job = await repository.acceptConversationSignal(signal());
    const first = await repository.claimJob({ jobId: job.jobId, claimToken: "claim-a", now: 1_000 });
    assert.equal(first.status, "running");
    const loser = await repository.claimJob({ jobId: job.jobId, claimToken: "claim-b", now: 1_000 });
    assert.equal(loser, undefined);

    const wrongToken = await repository.finishJob({
      jobId: job.jobId, claimToken: "claim-b", status: "done", now: 1_050,
    });
    assert.equal(wrongToken, undefined);

    const requeued = await repository.finishJob({
      jobId: job.jobId, claimToken: "claim-a", status: "queued", now: 1_050, nextAttemptAt: 2_000,
    });
    assert.equal(requeued.status, "queued");
    assert.equal(requeued.nextAttemptAt, 2_000);

    // 未到期（next_attempt_at 在未来）的任务不进入就绪队列。
    const due = await repository.listDueJobs({ now: 1_500, limit: 8 });
    assert.equal(due.length, 0);
    const dueLater = await repository.listDueJobs({ now: 2_000, limit: 8 });
    assert.equal(dueLater.length, 1);
  });
});

test("due jobs are ordered by eligibility and only include due tasks", async () => {
  await withStore(async ({ repository }) => {
    await repository.acceptConversationSignal(signal({
      conversationId: "c-late", eligibleAt: 5_000, now: 4_000,
    }));
    await repository.acceptConversationSignal(signal({
      conversationId: "c-early", eligibleAt: 1_000, now: 900,
    }));
    const due = await repository.listDueJobs({ now: 1_500, limit: 8 });
    assert.deepEqual(due.map((job) => job.conversationId), ["c-early"]);
  });
});

test("claim re-verifies current eligibility instead of trusting the queue snapshot (R07)", async () => {
  await withStore(async ({ repository }) => {
    await repository.acceptConversationSignal(signal());
    // 队列快照产生后，同会话新稳定信号把 eligibleAt 推到未来。
    await repository.acceptConversationSignal(signal({ stableThroughOrdinal: 9, eligibleAt: 5_000, now: 300 }));
    const staleSnapshotClaim = await repository.claimJob({ jobId: "memjob-1", claimToken: "claim-stale", now: 400 });
    assert.equal(staleSnapshotClaim, undefined);
    // 到期后才能领取。
    const due = await repository.claimJob({ jobId: "memjob-1", claimToken: "claim-due", now: 5_000 });
    assert.equal(due.status, "running");
  });
});
