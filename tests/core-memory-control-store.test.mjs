import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  MemoryError,
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
    await rm(dir, { recursive: true, force: true });
  }
}

const jobInput = (overrides = {}) => ({
  conversationId: "c1",
  ownerKey: "space:s1",
  coveredThroughTurnId: "u1",
  coveredThroughOrdinal: 1,
  sourceFingerprint: "fp1",
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
    await repo1.enqueueOrAdvanceJob(jobInput());
    first.close();

    const second = new SqliteRuntimeDatabase(filePath);
    const repo2 = createSqliteMemoryControlRepository(second);
    const queued = await repo2.listJobsByStatus("queued");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].conversationId, "c1");
    assert.equal(queued[0].coveredThroughOrdinal, 1);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interrupted running jobs return to queued with attempt increment on recovery", async () => {
  await withStore(async ({ repository }) => {
    const job = await repository.enqueueOrAdvanceJob(jobInput());
    const running = await repository.transitionJob(job.jobId, "queued", "running");
    assert.equal(running.status, "running");
    const recovered = await repository.recoverInterruptedJobs();
    assert.equal(recovered, 1);
    const queued = await repository.listJobsByStatus("queued");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].attempt, 1);
  });
});

test("lifecycle generation is strictly monotonic", async () => {
  await withStore(async ({ repository }) => {
    const first = await repository.advanceGeneration("space:s1");
    const second = await repository.advanceGeneration("space:s1");
    assert.equal(first.generation, 1);
    assert.equal(second.generation, 2);
  });
});

test("policy write rejects stale expectedRevision (CAS)", async () => {
  await withStore(async ({ repository }) => {
    await repository.setPolicy({
      key: "global_consent", kind: "global_consent", scopeOwnerKey: null, enabled: true,
    });
    await assert.rejects(
      repository.setPolicy({
        key: "global_consent", kind: "global_consent", scopeOwnerKey: null,
        enabled: false, expectedRevision: 0,
      }),
      (error) => error instanceof MemoryError && error.code === "memory_policy_revision_stale",
    );
  });
});

test("repeated signals advance the single active job instead of duplicating", async () => {
  await withStore(async ({ repository }) => {
    await repository.enqueueOrAdvanceJob(jobInput());
    const advanced = await repository.enqueueOrAdvanceJob(
      jobInput({ coveredThroughTurnId: "u3", coveredThroughOrdinal: 3, sourceFingerprint: "fp3" }),
    );
    assert.equal(advanced.coveredThroughOrdinal, 3);
    assert.equal((await repository.listJobsByStatus("queued")).length, 1);
    assert.equal((await repository.listJobsByStatus("running")).length, 0);
  });
});
