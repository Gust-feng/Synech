import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  POLICY_KEY,
  createMemoryBackgroundPort,
  createSqliteMemoryControlRepository,
  createSqliteMemoryDocumentRepository,
  spaceParticipationKey,
} from "../dist/app/memory/index.js";

/**
 * 背景供给冻结复核边界（正式设计 §9.3，E09/E11 的端口级不变量）：
 * - effective=active 且 revision/generation 有效 → 供给；
 * - shadow → 不供给（只整理不注入）；
 * - 用户编辑替换/来源删除失效/clear 后 generation 变化 → 停止供给，不自动换绑。
 */

async function withHarness(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-bg-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: spaceParticipationKey("s1"), kind: "space_participation", scopeOwnerKey: "space:s1", enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
  const port = createMemoryBackgroundPort({ controlRepository: control, documentRepository: documents });
  try {
    await run({ control, documents, port });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const OWNER = { kind: "space", id: "s1" };

async function publishHead(documents) {
  return await documents.recordUserSpaceMemoryEdit({
    ownerKey: "space:s1",
    markdown: "# Space Memory\n\n用户确认的长期背景。",
    requestId: `req-${Math.random()}`,
    expectedRevisionId: null,
    now: 100,
  });
}

test("active policy + valid revision + matching generation supplies the background", async () => {
  await withHarness(async ({ documents, port }) => {
    const head = await publishHead(documents);
    const supplied = await port.resolveSupplyableBackground({
      owner: OWNER, revisionId: head.revisionId, generation: head.generation,
    });
    assert.ok(supplied !== undefined);
    assert.equal(supplied.revisionId, head.revisionId);
    // 新会话绑定读取同一 head。
    const rebound = await port.getActiveSpaceMemoryHead(OWNER);
    assert.equal(rebound.revisionId, head.revisionId);
  });
});

test("shadow rollout does not inject", async () => {
  await withHarness(async ({ control, documents, port }) => {
    const head = await publishHead(documents);
    await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "shadow", enabled: true });
    const supplied = await port.resolveSupplyableBackground({
      owner: OWNER, revisionId: head.revisionId, generation: head.generation,
    });
    assert.equal(supplied, undefined);
  });
});

test("a user edit that replaces the bound revision stops supply without rebinding", async () => {
  await withHarness(async ({ documents, port }) => {
    const v1 = await publishHead(documents);
    // 会话绑定 v1；随后用户编辑发布 v2 并撤销 v1。
    const v2 = await documents.recordUserSpaceMemoryEdit({
      ownerKey: "space:s1",
      markdown: "# Space Memory\n\nv2 修订。",
      requestId: "req-v2",
      expectedRevisionId: v1.revisionId,
      now: 200,
    });
    const boundSupply = await port.resolveSupplyableBackground({
      owner: OWNER, revisionId: v1.revisionId, generation: v1.generation,
    });
    assert.equal(boundSupply, undefined);
    // 不自动换绑：绑定复核仍然拒绝旧版本；新会话才读取 v2。
    const newHead = await port.getActiveSpaceMemoryHead(OWNER);
    assert.equal(newHead.revisionId, v2.revisionId);
  });
});

test("clear bumps the owner generation so bound revisions stop supplying", async () => {
  await withHarness(async ({ control, documents, port }) => {
    const head = await publishHead(documents);
    // clear：fence（generation+1）→ purge（排除边界保留）→ 恢复。
    await control.fenceForRemoval("space:s1");
    await documents.purgeOwner("space:s1", { preserveExclusions: true });
    await control.setLifecycleFence("space:s1", "none", null, 1);
    const supplied = await port.resolveSupplyableBackground({
      owner: OWNER, revisionId: head.revisionId, generation: head.generation,
    });
    assert.equal(supplied, undefined);
    assert.equal(await port.getActiveSpaceMemoryHead(OWNER), undefined);
  });
});

test("memory off stops supply entirely", async () => {
  await withHarness(async ({ control, documents, port }) => {
    const head = await publishHead(documents);
    await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: false });
    const supplied = await port.resolveSupplyableBackground({
      owner: OWNER, revisionId: head.revisionId, generation: head.generation,
    });
    assert.equal(supplied, undefined);
  });
});

test("a source conversation fence stops supply even before dependent revisions are invalidated (R05)", async () => {
  await withHarness(async ({ control, documents, port }) => {
    await control.acceptConversationSignal({
      conversationId: "c1", ownerKey: "space:s1", stableThroughOrdinal: 2,
      sourceFingerprint: "fp", eligibleAt: 100, now: 0,
      generation: 0, policyRevision: "g1:r1:s1:gen0",
    });
    const [queued] = await control.listJobsByStatus("queued");
    const claimToken = "claim-seed";
    await control.claimJob({ jobId: queued.jobId, claimToken, now: 100 });
    const committed = await documents.commitMaintenanceBatch({
      jobId: queued.jobId,
      claimToken,
      conversationId: "c1",
      ownerKey: "space:s1",
      expectedPolicyRevision: "g1:r1:s1:gen0",
      expectedGeneration: 0,
      expectedSummaryRevisionId: null,
      expectedMemoryHeadRevisionId: null,
      summary: { markdown: "总结", coveredThroughOrdinal: 2 },
      longTermUpdate: { markdown: "# Space Memory\n依赖 c1。" },
      batchRange: { fromOrdinal: 1, toOrdinal: 2, sourceRevision: 2 },
      advanceProgressTo: { ordinal: 2, sourceFingerprint: "rev:2" },
    });
    assert.equal(committed.status, "committed");
    const head = await documents.getActiveSpaceMemoryHead("space:s1");
    assert.ok(head !== undefined);
    // 来源会话删除 fence 建立（依赖失效尚未执行）：供给必须立即停止。
    await control.fenceForRemoval("conversation:c1");
    const supplied = await port.resolveSupplyableBackground({
      owner: { kind: "space", id: "s1" },
      revisionId: head.revisionId,
      generation: head.generation,
    });
    assert.equal(supplied, undefined);
  });
});
