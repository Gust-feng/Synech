import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  MemoryError,
  POLICY_KEY,
  createControlMemoryLifecycle,
  createMemoryAdminApplication,
  createMemoryFeature,
  createSqliteMemoryContentRepository,
  createSqliteMemoryControlRepository,
  conversationExclusionKey,
  participationKey,
} from "../dist/app/memory/index.js";

let seq = 0;
function deterministicIds() {
  return (prefix) => `${prefix}-${++seq}`;
}

async function withAdmin(run, { existingSpaces = [], conversationMap = new Map() } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-admin-"));
  const filePath = path.join(dir, "synech.sqlite3");
  const database = new SqliteRuntimeDatabase(filePath);
  seq = 0;
  const ids = deterministicIds();
  const controlRepository = createSqliteMemoryControlRepository(database, { idFactory: ids });
  const contentRepository = createSqliteMemoryContentRepository(database, { idFactory: ids });
  const lifecycle = createControlMemoryLifecycle(controlRepository, { idFactory: ids });
  const deleting = new Set();
  const spaceExists = new Map();
  for (const space of existingSpaces) {
    spaceExists.set(space.id, true);
    if (space.deleting) deleting.add(space.id);
  }
  const isLifecycleFenced = async (ownerKey) => {
    const row = await controlRepository.getLifecycle(ownerKey);
    if (row === undefined) return false;
    return row.fenceState === "fenced" || row.fenceState === "tombstone";
  };
  const ownerExistsQuery = {
    isSpaceAvailable: async (spaceId) => {
      if (deleting.has(spaceId)) return false;
      if (!(spaceExists.has(spaceId))) return false;
      return !(await isLifecycleFenced(`space:${spaceId}`));
    },
    isWorkspaceAvailable: async () => true,
    getConversationOwner: async (conversationId) => {
      const conversation = conversationMap.get(conversationId);
      if (conversation === undefined) return undefined;
      const { owner, exists: convExists = true } = conversation;
      const ownerFenced = owner.kind === "space" && (deleting.has(owner.id) || await isLifecycleFenced(`space:${owner.id}`));
      if (ownerFenced) return { exists: false, owner };
      return { exists: convExists, owner };
    },
  };
  let lane = Promise.resolve();
  const spaceAdmission = {
    admit: async (_spaceId, operation) => {
      const next = lane.then(() => operation(), () => operation());
      lane = next.then(() => undefined, () => undefined);
      return await next;
    },
    assertAvailable: (spaceId) => {
      if (deleting.has(spaceId)) {
        throw new MemoryError("memory_owner_deleted", `Space ${spaceId} is being deleted.`);
      }
    },
  };
  const admin = createMemoryAdminApplication({
    controlRepository,
    lifecycle,
    contentRepository,
    spaceAdmission,
    ownerExistsQuery,
  });
  const feature = createMemoryFeature({ adminApplication: admin });
  try {
    await run({
      admin,
      feature,
      controlRepository,
      contentRepository,
      lifecycle,
      database,
      deleting,
      spaceExists,
    });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("setConsent writes the global consent row and getStatus reflects it", async () => {
  await withAdmin(async ({ admin }) => {
    const before = await admin.getCapabilityStatus();
    assert.equal(before.globalConsent, false);
    assert.equal(before.rollout, "off");
    assert.equal(before.effective, "off");

    const result = await admin.setConsent({ globalConsent: true });
    assert.equal(typeof result.policyRevision, "string");
    assert.ok(result.policyRevision.startsWith("g1:"));

    const after = await admin.getCapabilityStatus();
    assert.equal(after.globalConsent, true);
    // rollout 仍为 off，effective 必须维持 off（manual 12.2：effective 是更具体
    // 拒绝的并集，rollout off 不能被 global consent 跳过）。
    assert.equal(after.effective, "off");
  });
});

test("setSpaceParticipation rejects when the space is fenced (fail-closed)", async () => {
  await withAdmin(
    async ({ admin, controlRepository }) => {
      // fenceForRemoval 把 generation+1 并立 fenced；ownerExistsQuery 报告不可用。
      await controlRepository.fenceForRemoval("space:s1");
      await assert.rejects(
        () => admin.setSpaceParticipation({ spaceId: "s1", enabled: true }),
        (error) => error instanceof MemoryError && error.code === "memory_owner_deleted",
      );
      const rows = await controlRepository.readAllPolicy();
      assert.equal(rows.find((row) => row.key === participationKey("space:s1")), undefined);
    },
    { existingSpaces: [{ id: "s1" }] },
  );
});

test("setSpaceParticipation rejects when the space does not exist", async () => {
  await withAdmin(async ({ admin, controlRepository }) => {
    await assert.rejects(
      () => admin.setSpaceParticipation({ spaceId: "missing", enabled: true }),
      (error) => error instanceof MemoryError && error.code === "memory_owner_deleted",
    );
    const rows = await controlRepository.readAllPolicy();
    assert.equal(rows.find((row) => row.key === participationKey("space:missing")), undefined);
  });
});

test("clearImplicitMemory advances generation and tombstone prevents further participation writes", async () => {
  await withAdmin(
    async ({ admin, controlRepository, contentRepository, lifecycle }) => {
      await controlRepository.setPolicy({
        key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true,
      });
      await controlRepository.setPolicy({
        key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true,
      });
      await controlRepository.setPolicy({
        key: participationKey("space:s1"), kind: "scope_participation", scopeOwnerKey: "space:s1", enabled: true,
      });
      // 写一条 active record 作为可清除目标；listActiveByOwner 仍返回 1，但 recall
      // 在 fence 后会自动按 generation 过滤掉旧记录（手册 7.1）。
      await contentRepository.commitConsolidation({
        conversationId: "c-clear",
        ownerKey: "space:s1",
        records: [{
          kind: "decision",
          modelText: "Initial decision before clear.",
          evidenceClass: "quoted_user_evidence",
          confirmation: "unconfirmed",
          contentHash: "hash-clear-1",
          generation: 0,
          sources: [{ conversationId: "c-clear", sourceRevision: 1 }],
        }],
        advanceCursorTo: { coveredThroughOrdinal: 2, sourceFingerprint: "fp-clear-1" },
      });
      assert.equal((await contentRepository.listActiveByOwner("space:s1")).length, 1);

      const result = await admin.clearImplicitMemory({ scope: { kind: "space", id: "s1" } });
      assert.equal(result.generation, 1);

      const lifecycleRow = await controlRepository.getLifecycle("space:s1");
      assert.equal(lifecycleRow.fenceState, "tombstone");
      assert.equal(lifecycleRow.generation, 1);

      // 清除后再尝试 participation 写入：owner 已 tombstone，ownerExistsQuery 报告不可用。
      await assert.rejects(
        () => admin.setSpaceParticipation({ spaceId: "s1", enabled: true }),
        (error) => error instanceof MemoryError && error.code === "memory_owner_deleted",
      );

      // generation 单调 +1：再次 prepare 应生成 generation=2 的新 ticket。
      const nextTicket = await lifecycle.prepareOwnerRemoval({ kind: "space", id: "s1" });
      assert.equal(nextTicket.fencedGeneration, 2);
      assert.equal((await controlRepository.getLifecycle("space:s1")).generation, 2);

      // recall 不会再返回旧 records：FTS5 投影搜索要求 generation 与 lifecycle 一致，
      // 当前 lifecycle.generation=2，旧 records 带 generation=0 被丢弃。
      const hits = await contentRepository.searchActiveByProjection({
        ownerKey: "space:s1",
        match: "decision",
        generation: 2,
        limit: 5,
      });
      assert.equal(hits.length, 0);
    },
    { existingSpaces: [{ id: "s1" }] },
  );
});

test("memory-feature facade forwards setConsent and getCapabilityStatus to the admin application", async () => {
  await withAdmin(
    async ({ admin, feature }) => {
      // facade 转发一致性：facade 应当把 setConsent / getCapabilityStatus 真实地
      // 转发到 admin（不是写空结果、不是返回 undefined）。policyRevision 每次
      // 调用都会 bump，所以只验证 facade 写入后的 capability status 与直接
      // admin 写入后的 capability status 完全一致。
      const before = await admin.getCapabilityStatus();
      await feature.commands.setConsent({ globalConsent: true });
      const facadeStatus = await feature.queries.getCapabilityStatus();
      const directStatus = await admin.getCapabilityStatus();
      assert.deepEqual(facadeStatus, directStatus);
      assert.notEqual(facadeStatus.globalConsent, before.globalConsent);
      assert.equal(facadeStatus.globalConsent, true);
    },
    { existingSpaces: [{ id: "s1" }] },
  );
});

test("setConversationParticipation rejects when conversation is absent", async () => {
  await withAdmin(
    async ({ admin }) => {
      await assert.rejects(
        () => admin.setConversationParticipation({ conversationId: "missing", excluded: true }),
        (error) => error instanceof MemoryError && error.code === "memory_owner_deleted",
      );
    },
    { existingSpaces: [{ id: "s1" }] },
  );
});

test("setConversationParticipation writes exclusion row when conversation exists", async () => {
  await withAdmin(
    async ({ admin, controlRepository }) => {
      const conversationMap = new Map([
        ["c-ok", { owner: { kind: "space", id: "s1" } }],
      ]);
      const result = await admin.setConversationParticipation({
        conversationId: "c-ok",
        excluded: true,
      });
      assert.equal(typeof result.policyRevision, "string");
      const rows = await controlRepository.readAllPolicy();
      const row = rows.find((candidate) => candidate.key === conversationExclusionKey("c-ok"));
      assert.equal(row?.enabled, true);
    },
    { existingSpaces: [{ id: "s1" }], conversationMap: new Map([
      ["c-ok", { owner: { kind: "space", id: "s1" } }],
    ]) },
  );
});

test("setConversationParticipation rejects when owner is fenced mid-flight", async () => {
  await withAdmin(
    async ({ admin }) => {
      const conversationMap = new Map([
        ["c-fenced", { owner: { kind: "space", id: "s2" } }],
      ]);
      await assert.rejects(
        () => admin.setConversationParticipation({ conversationId: "c-fenced", excluded: true }),
        (error) => error instanceof MemoryError && error.code === "memory_owner_deleted",
      );
    },
    { existingSpaces: [{ id: "s1" }, { id: "s2", deleting: true }], conversationMap: new Map([
      ["c-fenced", { owner: { kind: "space", id: "s2" } }],
    ]) },
  );
});