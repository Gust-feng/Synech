import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  MemoryError,
  createControlMemoryLifecycle,
  createSqliteMemoryControlRepository,
} from "../dist/app/memory/index.js";

// 删除路径核心不变量：两阶段 prepare(bump generation + fenced) → finalize(tombstone)；
// stale ticket 与错误 scope 必须被拒（迟到的旧删除/写入请求不得越过 fence）。
async function withLifecycle(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-lifecycle-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const repository = createSqliteMemoryControlRepository(database);
  const lifecycle = createControlMemoryLifecycle(repository, {
    idFactory: (() => { let n = 0; return () => `memrm-${++n}`; })(),
  });
  try {
    await run({ lifecycle, repository });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("owner removal: prepare fences and finalize leaves tombstone with advanced generation", async () => {
  await withLifecycle(async ({ lifecycle, repository }) => {
    const ticket = await lifecycle.prepareOwnerRemoval({ kind: "space", id: "s1" });
    assert.equal(ticket.scope.kind, "owner");
    assert.equal(ticket.fencedGeneration, 1);
    let row = await repository.getLifecycle("space:s1");
    assert.equal(row?.fenceState, "fenced");
    assert.equal(row?.generation, 1);

    await lifecycle.finalizeOwnerRemoval(ticket);
    row = await repository.getLifecycle("space:s1");
    assert.equal(row?.fenceState, "tombstone");
    assert.equal(row?.generation, 1);
  });
});

test("stale ticket is rejected after a newer prepare advances the generation", async () => {
  await withLifecycle(async ({ lifecycle }) => {
    const first = await lifecycle.prepareOwnerRemoval({ kind: "workspace", id: "w1" });
    // 删除恢复/并发删除再次 prepare，generation 前进，旧 ticket 即刻失效。
    await lifecycle.prepareOwnerRemoval({ kind: "workspace", id: "w1" });
    await assert.rejects(
      () => lifecycle.finalizeOwnerRemoval(first),
      (error) => error instanceof MemoryError && error.code === "memory_generation_fenced",
    );
  });
});

test("owner ticket cannot finalize a conversation removal and vice versa", async () => {
  await withLifecycle(async ({ lifecycle }) => {
    const ownerTicket = await lifecycle.prepareOwnerRemoval({ kind: "space", id: "s9" });
    await assert.rejects(
      () => lifecycle.finalizeConversationRemoval(ownerTicket),
      (error) => error instanceof MemoryError && error.code === "memory_invalid_owner",
    );

    const conversationTicket = await lifecycle.prepareConversationRemoval("c9");
    assert.equal(conversationTicket.scope.kind, "conversation");
    await lifecycle.finalizeConversationRemoval(conversationTicket);
    await assert.rejects(
      () => lifecycle.finalizeOwnerRemoval(conversationTicket),
      (error) => error instanceof MemoryError && error.code === "memory_invalid_owner",
    );
  });
});

test("repeated removal is resumable: prepare/finalize again ends at tombstone with monotonic generation", async () => {
  await withLifecycle(async ({ lifecycle, repository }) => {
    const t1 = await lifecycle.prepareOwnerRemoval({ kind: "space", id: "s2" });
    await lifecycle.finalizeOwnerRemoval(t1);
    // 模拟删除状态机 resume 时重新进入清理段：再次两阶段仍收敛到 tombstone，generation 单调 +1。
    const t2 = await lifecycle.prepareOwnerRemoval({ kind: "space", id: "s2" });
    assert.equal(t2.fencedGeneration, 2);
    await lifecycle.finalizeOwnerRemoval(t2);
    const row = await repository.getLifecycle("space:s2");
    assert.equal(row?.fenceState, "tombstone");
    assert.equal(row?.generation, 2);
  });
});
