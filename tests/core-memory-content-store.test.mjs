import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  MemoryError,
  createSqliteMemoryContentRepository,
  createSqliteMemoryControlRepository,
} from "../dist/app/memory/index.js";

let seq = 0;
function deterministicIds() {
  return (prefix) => `${prefix}-${++seq}`;
}

async function withStores(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-content-"));
  const filePath = path.join(dir, "synech.sqlite3");
  const database = new SqliteRuntimeDatabase(filePath);
  seq = 0;
  const content = createSqliteMemoryContentRepository(database, { idFactory: deterministicIds() });
  const control = createSqliteMemoryControlRepository(database, { idFactory: deterministicIds() });
  try {
    await run({ content, control, database });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const record = (overrides = {}) => ({
  kind: "decision",
  modelText: "The project uses a single node:sqlite database.",
  evidenceClass: "quoted_user_evidence",
  confirmation: "unconfirmed",
  contentHash: "hash-a",
  generation: 0,
  sources: [
    { conversationId: "c1", runId: "r1", turnId: "t1", fromOrdinal: 0, toOrdinal: 1, sourceRevision: 3 },
  ],
  ...overrides,
});

const commit = (overrides = {}) => ({
  conversationId: "c1",
  ownerKey: "space:s1",
  records: [record()],
  advanceCursorTo: { coveredThroughOrdinal: 1, sourceFingerprint: "fp1" },
  ...overrides,
});

test("commit atomically persists record, sources, cursor and pending outbox", async () => {
  await withStores(async ({ content }) => {
    const result = await content.commitConsolidation(commit());
    assert.deepEqual(result.recordRefs, [{ id: "memrec-1", revision: 1 }]);
    assert.equal(result.cursor.coveredThroughOrdinal, 1);

    const active = await content.listActiveByOwner("space:s1");
    assert.equal(active.length, 1);
    assert.equal(active[0].modelText, "The project uses a single node:sqlite database.");
    assert.equal(active[0].status, "active");

    const sources = await content.listSources("memrec-1", 1);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].conversationId, "c1");
    assert.equal(sources[0].sourceRevision, 3);

    const outbox = await content.claimPendingOutbox(10);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].op, "index");
    assert.equal(outbox[0].status, "pending");

    const marked = await content.markOutbox(outbox[0].outboxId, "done");
    assert.equal(marked.status, "done");
    assert.equal(marked.attempts, 1);
  });
});

test("a failing record rolls back the whole commit (no half-written record/cursor/outbox)", async () => {
  await withStores(async ({ content }) => {
    // 第一条 generation=0 合法，第二条 generation=9 与当前 0 不符，必须整体回滚。
    const bad = commit({
      records: [record(), record({ contentHash: "hash-b", generation: 9 })],
    });
    await assert.rejects(
      () => content.commitConsolidation(bad),
      (error) => error instanceof MemoryError && error.code === "memory_generation_fenced",
    );

    assert.deepEqual(await content.listActiveByOwner("space:s1"), []);
    assert.equal(await content.getCursor("c1"), undefined);
    assert.deepEqual(await content.claimPendingOutbox(10), []);
  });
});

test("capture cursor only advances forward", async () => {
  await withStores(async ({ content }) => {
    await content.commitConsolidation(
      commit({ advanceCursorTo: { coveredThroughOrdinal: 3, sourceFingerprint: "fp3" } }),
    );
    await assert.rejects(
      () =>
        content.commitConsolidation(
          commit({ records: [], advanceCursorTo: { coveredThroughOrdinal: 2, sourceFingerprint: "fp2" } }),
        ),
      (error) => error instanceof MemoryError && error.code === "memory_store_failure",
    );
    const cursor = await content.getCursor("c1");
    assert.equal(cursor.coveredThroughOrdinal, 3);
  });
});

test("fenced or tombstoned owner rejects consolidation writes", async () => {
  await withStores(async ({ content, control }) => {
    const ticket = await control.fenceForRemoval("space:s1");
    assert.equal(ticket.fenceState, "fenced");
    await assert.rejects(
      () => content.commitConsolidation(commit()),
      (error) => error instanceof MemoryError && error.code === "memory_generation_fenced",
    );
    assert.deepEqual(await content.listActiveByOwner("space:s1"), []);
    assert.equal(await content.getCursor("c1"), undefined);
  });
});

test("new revision of a logical record retires the previous active version and queues removal", async () => {
  await withStores(async ({ content }) => {
    const first = await content.commitConsolidation(commit());
    const id = first.recordRefs[0].id;

    const second = await content.commitConsolidation(
      commit({
        records: [record({ recordId: id, contentHash: "hash-b", modelText: "Updated decision text." })],
        advanceCursorTo: { coveredThroughOrdinal: 3, sourceFingerprint: "fp3" },
      }),
    );
    assert.deepEqual(second.recordRefs, [{ id, revision: 2 }]);

    const active = await content.listActiveByOwner("space:s1");
    assert.equal(active.length, 1);
    assert.equal(active[0].revision, 2);
    assert.equal(active[0].modelText, "Updated decision text.");

    const outbox = await content.claimPendingOutbox(10);
    const ops = outbox.map((row) => `${row.op}:${row.revision}`).sort();
    assert.deepEqual(ops, ["index:1", "index:2", "remove:1"]);
  });
});

test("content commits cannot move a logical record or cursor across owner scopes", async () => {
  await withStores(async ({ content }) => {
    const first = await content.commitConsolidation(commit());
    const id = first.recordRefs[0].id;

    await assert.rejects(
      () => content.commitConsolidation(commit({
        conversationId: "c2",
        ownerKey: "space:s2",
        records: [record({ recordId: id, contentHash: "cross-owner" })],
      })),
      (error) => error instanceof MemoryError && error.code === "memory_invalid_owner",
    );
    assert.equal((await content.listActiveByOwner("space:s1")).length, 1);
    assert.equal((await content.listActiveByOwner("space:s2")).length, 0);
    assert.equal(await content.getCursor("c2"), undefined);
  });
});
