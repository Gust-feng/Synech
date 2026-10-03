import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { MemoryError } from "../dist/app/memory/index.js";
import { POLICY_KEY, createControlMemoryLifecycle, createMemoryAdminApplication, createSqliteMemoryControlRepository, createSqliteMemoryDocumentRepository } from "../dist/app/memory/composition.js";

/**
 * Memory Admin（ADR 0019）：
 * - 单条目 CAS、幂等、owner admission 与精确撤销；
 * - setEnabled(true)：按 Ordinary 高水位排除 Space 与 Workspace 两类 owner 的
 *   已分配范围（关闭期间与排队轮次不回填）；同值设置幂等，不重复排除；
 * - clearMemory：高水位排除 → fence/generation → purge（保留排除边界）。
 */

const HIGH_WATERS = [
  { conversationId: "c1", ownerKey: "space:s1", allocatedThroughOrdinal: 12 },
  { conversationId: "c2", ownerKey: "space:s2", allocatedThroughOrdinal: 30 },
  { conversationId: "s2-c1", ownerKey: "space:s2", allocatedThroughOrdinal: 7 },
];

async function withHarness(run, options = {}) {
  const ref = {};
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-admin-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  let clock = 1_000;
  // 深拷贝：测试会改写高水位，不能让一个用例污染另一个用例。
  const highWaters = (options.highWaters ?? HIGH_WATERS).map((entry) => ({ ...entry }));
  const onHighWaterRead = options.onHighWaterRead;
  const admin = createMemoryAdminApplication({
    controlRepository: control,
    documentRepository: documents,
    lifecycle: createControlMemoryLifecycle(control, { documentRepository: documents }),
    spaceAdmission: { admit: async (_spaceId, operation) => await operation() },
    workspaceAdmission: { admit: async (_workspaceId, operation) => await operation() },
    ownerExistsQuery: {
      isSpaceAvailable: async (spaceId) => !spaceId.startsWith("s-deleted"),
      isWorkspaceAvailable: async (workspaceId) => workspaceId !== "w-deleted",
    },
    conversationHighWaterQuery: {
      listConversationHighWaters: async () => {
        if (onHighWaterRead !== undefined) await onHighWaterRead({ ref });
        return highWaters;
      },
    },
    now: () => clock,
  });
  ref.admin = admin;
  try {
    await run({
      admin, control, documents, database, highWaters, ref,
      advanceClock: (delta) => { clock += delta; },
    });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const SPACE = { kind: "space", id: "s1" };
const SPACE_2 = { kind: "space", id: "s2" };

function createEdit(owner, entryId, markdown, requestId) {
  return { owner, requestId, edit: { entryId, operation: "create", expectedRevisionId: null, kind: "initial",
    markdown, applicability: null, occurredAt: null, reason: null, topicIds: [], related: [], retractsRevisionIds: [] } };
}
function reviseEdit(owner, entryId, head, markdown, requestId, kind = "supplement", affected = []) {
  return { ...createEdit(owner, entryId, markdown, requestId), edit: {
    ...createEdit(owner, entryId, markdown, requestId).edit, operation: "revise", expectedRevisionId: head,
    kind, retractsRevisionIds: affected,
  } };
}

test("entry CAS and request idempotency preserve exact immutable revision history", async () => {
  await withHarness(async ({ admin, documents, advanceClock }) => {
    const command = createEdit(SPACE, "entry-1", "第一版认识", "req-1");
    const first = await admin.updateMemory(command);
    advanceClock(100);
    assert.deepEqual(await admin.updateMemory(command), first);
    await assert.rejects(admin.updateMemory({ ...command, edit: { ...command.edit, markdown: "changed payload" } }), { code: "memory_request_conflict" });
    const page = await admin.getMemoryView({ owner: SPACE });
    assert.equal(page.entries[0].revision.origin, "user_edit");
    assert.equal(page.entries[0].revision.revisionId, first.revisionId);
    assert.equal(page.entries[0].sources.length, 1);
    assert.deepEqual(page.entries[0].sources[0].locator, { kind: "user_edit", requestId: "req-1" });
    assert.equal(page.entries[0].sources[0].readback, "not_applicable");
    assert.equal((await admin.getStatus()).enabled, false);
    assert.equal((await admin.getStatus({ owner: SPACE_2 })).hasContent, false);
    await assert.rejects(admin.updateMemory(createEdit(SPACE, "entry-1", "stale create", "req-2")), { code: "memory_revision_stale" });
    const second = await admin.updateMemory(reviseEdit(SPACE, "entry-1", first.revisionId, "状态已改变", "req-3", "change"));
    assert.equal(second.revision, 2);
    assert.equal((await documents.getOwnerMemoryRevision(first.overviewRevisionId)).validity, "valid");
    assert.equal((await documents.getEntryRevision({ ownerKey: "space:s1", entryId: "entry-1", revisionId: first.revisionId })).supplyState, "eligible");
    await assert.rejects(admin.updateMemory(reviseEdit(SPACE, "entry-1", first.revisionId, "过期草稿", "req-stale")), { code: "memory_revision_stale" });
    const third = await admin.updateMemory(reviseEdit(SPACE, "entry-1", second.revisionId, "明确纠正第一版", "req-4", "correction", [first.revisionId]));
    assert.equal((await documents.getOwnerMemoryRevision(first.overviewRevisionId)).validity, "invalidated");
    assert.equal((await documents.getOwnerMemoryRevision(second.overviewRevisionId)).validity, "valid");
    const history = await admin.getMemoryView({ owner: SPACE, entryId: "entry-1", limit: 2 });
    assert.equal(history.entries.length, 2);
    assert.equal(history.entries[0].role, "current");
    assert.equal(history.entries[1].role, "historical");
    assert.ok(history.nextCursor);
    const tail = await admin.getMemoryView({ owner: SPACE, entryId: "entry-1", limit: 2, cursor: history.nextCursor });
    assert.equal(tail.entries[0].revision.revisionId, first.revisionId);
    assert.equal(tail.entries[0].supplyState, "revoked");
    assert.equal(tail.entries[0].currentRevisionId, third.revisionId);
    const withdrawn = await admin.updateMemory(reviseEdit(SPACE, "entry-1", third.revisionId, "", "req-withdraw", "withdrawal", [third.revisionId]));
    const after = await admin.getMemoryView({ owner: SPACE });
    assert.equal(after.entries[0].revision.revisionId, withdrawn.revisionId);
    assert.equal(after.entries[0].role, "withdrawn");
    assert.equal(after.entries[0].currentRevisionId, null);
  });
});

test("updateMemory enforces the token capacity cap", async () => {
  await withHarness(async ({ admin }) => {
    const oversized = "很长的正文。".repeat(6_000 * 2);
    await assert.rejects(() => admin.updateMemory({
      ...createEdit(SPACE, "entry-cap", oversized, "req-cap"),
    }), (error) => error instanceof MemoryError && error.code === "memory_capacity_exceeded");
  });
});

test("updateMemory on an unavailable (deleted) owner is rejected for two Space owners", async () => {
  await withHarness(async ({ admin }) => {
    for (const owner of [{ kind: "space", id: "s-deleted" }, { kind: "space", id: "s-deleted-2" }]) {
      await assert.rejects(() => admin.updateMemory({
        ...createEdit(owner, "entry-deleted", "# x", "req-x"),
      }), (error) => error instanceof MemoryError && error.code === "memory_owner_deleted");
    }
  });
});

test("two Space owners memories stay isolated per owner", async () => {
  await withHarness(async ({ admin, documents }) => {
    await admin.updateMemory(createEdit(SPACE, "entry-space", "# space", "r1"));
    await admin.updateMemory(createEdit(SPACE_2, "entry-workspace", "# workspace", "r2"));
    assert.equal((await admin.getMemoryView({ owner: SPACE })).entries[0].revision.markdown, "# space");
    assert.equal((await admin.getMemoryView({ owner: SPACE_2 })).entries[0].revision.markdown, "# workspace");

    await admin.clearMemory({ scope: SPACE_2 });
    assert.equal((await admin.getStatus({ owner: SPACE_2 })).hasContent, false);
    assert.equal((await admin.getStatus()).hasContent, true);
    assert.equal(await documents.getActiveOwnerMemoryHead("space:s2"), undefined);
    assert.equal((await admin.getMemoryView({ owner: SPACE })).entries[0].revision.markdown, "# space");
  });
});

test("enabling writes exclusions for two Space owners high-waters (no backfill on re-enable)", async () => {
  await withHarness(async ({ admin, documents, highWaters }) => {
    await admin.setEnabled({ enabled: true });
    assert.equal((await documents.getProgress("c1")).excludedThroughOrdinal, 12);
    assert.equal((await documents.getProgress("c2")).excludedThroughOrdinal, 30);
    assert.equal((await documents.getProgress("s2-c1")).excludedThroughOrdinal, 7);

    // 关闭期间新分配的范围不得在重新开启时回填。
    await admin.setEnabled({ enabled: false });
    highWaters.find((entry) => entry.conversationId === "c1").allocatedThroughOrdinal = 44;
    await admin.setEnabled({ enabled: true });
    assert.equal((await documents.getProgress("c1")).excludedThroughOrdinal, 44);
  });
});

test("setting the same enabled value is idempotent and does not re-exclude or bump policy revision", async () => {
  await withHarness(async ({ admin, documents, advanceClock }) => {
    const first = await admin.setEnabled({ enabled: true });
    const progressAfterEnable = await documents.getProgress("c1");
    advanceClock(500);
    const second = await admin.setEnabled({ enabled: true });
    assert.equal(second.policyRevision, first.policyRevision);
    const progressAfterRepeat = await documents.getProgress("c1");
    assert.equal(progressAfterRepeat.excludedThroughOrdinal, 12);
    assert.equal(progressAfterRepeat.updatedAt, progressAfterEnable.updatedAt);
  });
});

test("clearMemory persists exclusions for the scope, bumps generation, and preserves the exclusion boundary", async () => {
  await withHarness(async ({ admin, control, documents }) => {
    await admin.setEnabled({ enabled: true });
    await admin.updateMemory(createEdit(SPACE, "entry-clear", "# before clear", "req-0"));

    const before = await control.getLifecycle("space:s1");
    const result = await admin.clearMemory({ scope: SPACE });
    assert.ok(result.generation > (before?.generation ?? 0));

    assert.equal(await documents.getActiveOwnerMemoryHead("space:s1"), undefined);
    assert.equal((await documents.getProgress("c1")).excludedThroughOrdinal, 12);
    // Space clear 只作用于该 owner：workspace 的边界不受影响。
    assert.equal((await documents.getProgress("s2-c1")).excludedThroughOrdinal, 7);
  });
});

test("global clear keeps the switch untouched but bumps the policy revision (late results cannot commit)", async () => {
  await withHarness(async ({ admin, control }) => {
    await admin.setEnabled({ enabled: true });
    await admin.updateMemory(createEdit(SPACE, "entry-clear", "记忆", "global-clear"));
    assert.equal((await admin.getStatus()).hasContent, true);
    const consentBefore = (await control.readAllPolicy()).find((row) => row.key === POLICY_KEY.consent);

    await admin.clearMemory({ scope: { kind: "global" } });

    assert.equal((await admin.getStatus()).enabled, true);
    assert.equal((await admin.getStatus()).hasContent, false);
    const consentAfter = (await control.readAllPolicy()).find((row) => row.key === POLICY_KEY.consent);
    assert.ok(consentAfter.revision > consentBefore.revision);
  });
});

test("enable interleaved with a concurrent global clear fails the policy CAS instead of clobbering it", async () => {
  let fired = false;
  await withHarness(async ({ admin, control }) => {
    await assert.rejects(() => admin.setEnabled({ enabled: true }),
      (error) => error instanceof MemoryError && error.code === "memory_policy_revision_stale");
    // clear 已经把 consent revision 推进；启用不得把旧 revision 写回。
    assert.equal((await admin.getStatus()).enabled, false);
    const consent = (await control.readAllPolicy()).find((row) => row.key === POLICY_KEY.consent);
    assert.ok(consent.revision >= 1);
  }, {
    onHighWaterRead: async ({ ref }) => {
      if (fired) return;
      fired = true;
      await ref.admin.clearMemory({ scope: { kind: "global" } });
    },
  });
});

test("status reflects the enabled switch and rollout without caching", async () => {
  await withHarness(async ({ admin }) => {
    await admin.setEnabled({ enabled: true });
    await admin.setRollout({ rollout: "active" });
    const spaceStatus = await admin.getStatus({ owner: SPACE });
    assert.equal(spaceStatus.enabled, true);
    assert.equal(spaceStatus.rollout, "active");
    assert.equal(spaceStatus.effective, "active");
    const workspaceStatus = await admin.getStatus({ owner: SPACE_2 });
    assert.equal(workspaceStatus.effective, "active");

    await admin.setEnabled({ enabled: false });
    assert.equal((await admin.getStatus({ owner: SPACE_2 })).effective, "off");
  });
});

test("R09: rollout off -> active writes exclusions; active -> shadow does not", async () => {
  await withHarness(async ({ admin, documents }) => {
    await admin.setRollout({ rollout: "active" });
    assert.equal((await documents.getProgress("c1")).excludedThroughOrdinal, 12);
    await admin.setRollout({ rollout: "shadow" });
    assert.equal((await documents.getProgress("c1")).excludedThroughOrdinal, 12);
  }, { highWaters: [{ conversationId: "c1", ownerKey: "space:s1", allocatedThroughOrdinal: 12 }] });
});

test("management pages are read-only, owner-isolated and reject invalid edits or unavailable owners", async () => {
  await withHarness(async ({ admin, database }) => {
    await admin.updateMemory(createEdit(SPACE, "entry-a", "认识 A", "page-a"));
    await admin.updateMemory(createEdit(SPACE, "entry-b", "认识 B", "page-b"));
    await admin.updateMemory(createEdit(SPACE_2, "entry-c", "工作区认识", "page-c"));
    const before = database.connection.prepare("SELECT total_changes() AS count").get().count;
    const first = await admin.getMemoryView({ owner: SPACE, limit: 1 });
    const next = await admin.getMemoryView({ owner: SPACE, limit: 1, cursor: first.nextCursor });
    assert.notEqual(first.entries[0].entry.entryId, next.entries[0].entry.entryId);
    assert.ok([...first.entries, ...next.entries].every(item => item.entry.owner.id === SPACE.id));
    assert.equal(database.connection.prepare("SELECT total_changes() AS count").get().count, before);
    await assert.rejects(admin.getMemoryView({ owner: SPACE_2, entryId: "entry-a" }), { code: "memory_entry_not_found" });
    await assert.rejects(admin.getMemoryView({ owner: { kind: "space", id: "s-deleted" } }), { code: "memory_owner_deleted" });
    const invalid = createEdit(SPACE, "empty", "", "empty");
    await assert.rejects(admin.updateMemory(invalid), { code: "memory_invalid_edit" });
    await assert.rejects(admin.updateMemory({ ...invalid, edit: { ...invalid.edit, markdown: "body", sourceIds: ["forged"] } }), { code: "memory_invalid_edit" });
    assert.equal(database.connection.prepare("SELECT total_changes() AS count").get().count, before);
  });
});
