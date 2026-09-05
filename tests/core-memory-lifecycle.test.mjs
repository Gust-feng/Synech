import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  POLICY_KEY,
  createControlMemoryLifecycle,
  createSqliteMemoryControlRepository,
  createSqliteMemoryDocumentRepository,
  spaceParticipationKey,
} from "../dist/app/memory/index.js";

/**
 * 两阶段删除生命周期（正式设计 §11.4，E09）：
 * - prepare：fence + 依赖被删来源的全部版本（含已绑定版本）立即失效；
 * - finalize：tombstone + 物理清理（总结/依赖文档/来源/进度/索引/任务）；
 * - 物理清理失败时 fence 保持有效，重试恢复同一生命周期。
 */

async function withHarness(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-lifecycle-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  void control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  void control.setPolicy({ key: spaceParticipationKey("s1"), kind: "space_participation", scopeOwnerKey: "space:s1", enabled: true });
  void control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
  const lifecycle = createControlMemoryLifecycle(control, { documentRepository: documents });
  try {
    await run({ control, documents, lifecycle, database });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function seedSummaryAndDoc(documents, control) {
  // 直接用提交边界构造：c1 的总结 + 依赖 c1 来源的 Space 文档。
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
    summary: { markdown: "c1 的累计总结", coveredThroughOrdinal: 2 },
    longTermUpdate: { markdown: "# Space Memory\n依赖 c1 的长期文档。" },
    batchRange: { fromOrdinal: 1, toOrdinal: 2, sourceRevision: 2 },
    advanceProgressTo: { ordinal: 2, sourceFingerprint: "rev:2" },
  });
  assert.equal(committed.status, "committed");
  return committed;
}

test("conversation removal invalidates dependent doc revisions and bound summaries at prepare, purges at finalize", async () => {
  await withHarness(async ({ control, documents, lifecycle }) => {
    const committed = await seedSummaryAndDoc(documents, control);
    const head = await documents.getActiveSpaceMemoryHead("space:s1");
    assert.equal(head.revisionId, committed.memoryRevisionId);

    const ticket = await lifecycle.prepareConversationRemoval("c1");
    // prepare：依赖 c1 的文档 revision 失效（即使它仍是 head）、c1 总结失效。
    assert.equal((await documents.getActiveSpaceMemoryHead("space:s1")), undefined);
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    const doc = await documents.getSpaceMemoryRevision(head.revisionId);
    assert.equal(doc.validity, "invalidated");

    // finalize：物理清理。
    await lifecycle.finalizeConversationRemoval(ticket);
    assert.equal(await documents.getSpaceMemoryRevision(head.revisionId), undefined);
    assert.equal(await documents.getProgress("c1"), undefined);
    const coverage = await documents.getTranscriptCoverage("c1");
    assert.equal(coverage, undefined);
  });
});

test("finalize is idempotent for retry (tombstone) and generation stays monotonic", async () => {
  await withHarness(async ({ control, documents, lifecycle }) => {
    await seedSummaryAndDoc(documents, control);
    const ticket = await lifecycle.prepareConversationRemoval("c1");
    await lifecycle.finalizeConversationRemoval(ticket);
    // 重试同一 ticket（journal 重放语义）：tombstone 下幂等收敛，不误报失败。
    await lifecycle.finalizeConversationRemoval(ticket);
    assert.equal(await documents.getProgress("c1"), undefined);
    const lifecycleRow = await control.getLifecycle("conversation:c1");
    const after = await control.fenceForRemoval("conversation:c1");
    assert.ok(after.generation > (lifecycleRow?.generation ?? 0));
  });
});

test("owner removal purges all derived data and keeps fence semantics", async () => {
  await withHarness(async ({ control, documents, lifecycle }) => {
    await seedSummaryAndDoc(documents, control);
    await documents.setExcludedThrough({
      conversationId: "c-other", ownerKey: "space:s1", excludedThroughOrdinal: 7, now: 5,
    });
    const ticket = await lifecycle.prepareOwnerRemoval({ kind: "space", id: "s1" });
    await lifecycle.finalizeOwnerRemoval(ticket);
    assert.equal(await documents.getActiveSpaceMemoryHead("space:s1"), undefined);
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    assert.equal(await documents.getTranscriptCoverage("c1"), undefined);
    // Space 删除不保留排除边界（整个 owner 消失）。
    assert.equal(await documents.getProgress("c-other"), undefined);
  });
});

test("late in-flight commits are rejected after the fence (generation mismatch)", async () => {
  await withHarness(async ({ control, documents, lifecycle }) => {
    // 批次在 fence 前领取。
    await control.acceptConversationSignal({
      conversationId: "c1", ownerKey: "space:s1", stableThroughOrdinal: 2,
      sourceFingerprint: "fp", eligibleAt: 100, now: 0,
      generation: 0, policyRevision: "g1:r1:s1:gen0",
    });
    const [queued] = await control.listJobsByStatus("queued");
    const claimToken = "claim-late";
    await control.claimJob({ jobId: queued.jobId, claimToken, now: 100 });

    // 删除流程先建立 fence。
    const ticket = await lifecycle.prepareConversationRemoval("c1");

    // 迟到的整理提交被拒绝（fence/generation 不符），不留半态。
    const late = await documents.commitMaintenanceBatch({
      jobId: queued.jobId,
      claimToken,
      conversationId: "c1",
      ownerKey: "space:s1",
      expectedPolicyRevision: "g1:r1:s1:gen0",
      expectedGeneration: 0,
      expectedSummaryRevisionId: null,
      expectedMemoryHeadRevisionId: null,
      summary: { markdown: "迟到结果", coveredThroughOrdinal: 2 },
      longTermUpdate: null,
      batchRange: { fromOrdinal: 1, toOrdinal: 2, sourceRevision: 2 },
      advanceProgressTo: { ordinal: 2, sourceFingerprint: "rev:2" },
    });
    assert.equal(late.status, "discarded");
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);

    await lifecycle.finalizeConversationRemoval(ticket);
  });
});
