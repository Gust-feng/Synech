import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  MemoryError,
  createControlMemoryLifecycle,
  createMemoryAdminApplication,
  createSqliteMemoryControlRepository,
  createSqliteMemoryDocumentRepository,
} from "../dist/app/memory/index.js";

/**
 * Memory Admin（正式设计 §11.2/§11.3/§11.5）：
 * - writeSpaceMemory：CAS + 容量 + admission；发布即撤销被替换版本供给；
 * - 启用边界：setConsent(true)/setSpaceParticipation(true) 依据 Ordinary 高水位
 *   写 excludedThrough（关闭区间不回填）；
 * - clear：高水位排除 → fence/generation → purge（保留排除边界）。
 */

async function withHarness(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-admin-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  const highWaters = options.highWaters ?? [
    { conversationId: "c1", ownerKey: "space:s1", allocatedThroughOrdinal: 12 },
    { conversationId: "c2", ownerKey: "space:s2", allocatedThroughOrdinal: 30 },
  ];
  const admin = createMemoryAdminApplication({
    controlRepository: control,
    documentRepository: documents,
    lifecycle: createControlMemoryLifecycle(control, { documentRepository: documents }),
    spaceAdmission: { admit: async (_spaceId, operation) => await operation() },
    workspaceAdmission: { admit: async (_spaceId, operation) => await operation() },
    ownerExistsQuery: {
      isSpaceAvailable: async (spaceId) => spaceId !== "s-deleted",
      isWorkspaceAvailable: async () => true,
    },
    conversationHighWaterQuery: { listConversationHighWaters: async () => highWaters },
  });
  try {
    await run({ admin, control, documents, database });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("writeSpaceMemory publishes a user_edit revision and a stale expectedRevision is rejected", async () => {
  await withHarness(async ({ admin, documents }) => {
    const first = await admin.writeSpaceMemory({
      spaceId: "s1",
      expectedRevisionId: null,
      markdown: "# v1",
      requestId: "req-1",
    });
    assert.ok(first.revisionId.length > 0);

    const view = await admin.getSpaceMemoryView({ spaceId: "s1" });
    assert.equal(view.document.revisionId, first.revisionId);
    assert.equal(view.document.origin, "user_edit");

    // 过期的 CAS（null 或旧 revisionId）都拒绝。
    await assert.rejects(() => admin.writeSpaceMemory({
      spaceId: "s1", expectedRevisionId: null, markdown: "# stale", requestId: "req-2",
    }), (error) => error instanceof MemoryError && error.code === "memory_revision_stale");

    const second = await admin.writeSpaceMemory({
      spaceId: "s1",
      expectedRevisionId: first.revisionId,
      markdown: "# v2",
      requestId: "req-3",
    });
    assert.equal(second.revision, first.revision + 1);
    // 被替换的 v1 停止供给（validity=invalidated）。
    assert.equal((await documents.getSpaceMemoryRevision(first.revisionId)).validity, "invalidated");
  });
});

test("writeSpaceMemory enforces the token capacity cap", async () => {
  await withHarness(async ({ admin }) => {
    const oversized = "很长的正文。".repeat(6_000 * 2);
    await assert.rejects(() => admin.writeSpaceMemory({
      spaceId: "s1", expectedRevisionId: null, markdown: oversized, requestId: "req-cap",
    }), (error) => error instanceof MemoryError && error.code === "memory_capacity_exceeded");
  });
});

test("writeSpaceMemory on an unavailable (deleted) space is rejected", async () => {
  await withHarness(async ({ admin }) => {
    await assert.rejects(() => admin.writeSpaceMemory({
      spaceId: "s-deleted", expectedRevisionId: null, markdown: "# x", requestId: "req-x",
    }), (error) => error instanceof MemoryError && error.code === "memory_owner_deleted");
  });
});

test("enabling consent writes exclusions from Ordinary high-waters (no backfill on re-enable)", async () => {
  await withHarness(async ({ admin, documents }) => {
    // 全局启用：全部 Space 会话的已分配高水位都被排除（含 s2 的 c2）。
    await admin.setConsent({ globalConsent: true });
    const c1 = await documents.getProgress("c1");
    assert.equal(c1.excludedThroughOrdinal, 12);
    const c2 = await documents.getProgress("c2");
    assert.equal(c2.excludedThroughOrdinal, 30);

    // Space 参与启用：s1 的排除边界按高水位再次写入（单调，不回退）。
    await admin.setSpaceParticipation({ spaceId: "s1", enabled: true });
    assert.equal((await documents.getProgress("c1")).excludedThroughOrdinal, 12);
  }, {
    highWaters: [
      { conversationId: "c1", ownerKey: "space:s1", allocatedThroughOrdinal: 12 },
      { conversationId: "c2", ownerKey: "space:s2", allocatedThroughOrdinal: 30 },
    ],
  });
});

test("clear persists exclusions for the scope, bumps generation, and preserves the exclusion boundary", async () => {
  await withHarness(async ({ admin, control, documents }) => {
    await admin.setConsent({ globalConsent: true });
    await admin.setSpaceParticipation({ spaceId: "s1", enabled: true });
    await admin.writeSpaceMemory({ spaceId: "s1", expectedRevisionId: null, markdown: "# before clear", requestId: "req-0" });

    const before = await control.getLifecycle("space:s1");
    const result = await admin.clearImplicitMemory({ scope: { kind: "space", id: "s1" } });
    assert.ok(result.generation > (before?.generation ?? 0));

    // 派生内容被清除；排除边界保留（c1 高水位 12 不得回填）。
    assert.equal(await documents.getActiveSpaceMemoryHead("space:s1"), undefined);
    const progress = await documents.getProgress("c1");
    assert.equal(progress.excludedThroughOrdinal, 12);
  }, {
    highWaters: [
      { conversationId: "c1", ownerKey: "space:s1", allocatedThroughOrdinal: 12 },
      { conversationId: "c2", ownerKey: "space:s2", allocatedThroughOrdinal: 30 },
    ],
  });
});

test("capability status reflects consent/participation/rollout without caching", async () => {
  await withHarness(async ({ admin }) => {
    await admin.setConsent({ globalConsent: true });
    await admin.setSpaceParticipation({ spaceId: "s1", enabled: true });
    await admin.setRollout({ rollout: "active" });
    const status = await admin.getCapabilityStatus({ owner: { kind: "space", id: "s1" } });
    assert.equal(status.globalConsent, true);
    assert.equal(status.spaceParticipation, true);
    assert.equal(status.rollout, "active");
    assert.equal(status.effective, "active");
  });
});
