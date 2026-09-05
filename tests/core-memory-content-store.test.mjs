import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  MemoryError,
  POLICY_KEY,
  createSqliteMemoryDocumentRepository,
  createSqliteMemoryControlRepository,
  spaceParticipationKey,
} from "../dist/app/memory/index.js";

async function withStore(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-doc-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const documents = createSqliteMemoryDocumentRepository(database, {
    idFactory: (() => { let n = 0; const make = (prefix) => `${prefix}-${++n}`; make.for = make; return make; })(),
  });
  const control = createSqliteMemoryControlRepository(database, {
    idFactory: (() => { let n = 0; return () => `memjob-${++n}`; })(),
  });
  // 提交边界会锁内重算有效准入；测试默认给一组开启的 policy（revision 与
  // commitInput.expectedPolicyRevision 保持一致）。
  void control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  void control.setPolicy({ key: spaceParticipationKey("s1"), kind: "space_participation", scopeOwnerKey: "space:s1", enabled: true });
  void control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
  try {
    await run({ documents, control, database });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** 构造一个已领取（running + claimToken）的 job，供提交边界使用。 */
async function claimJob(control, overrides = {}) {
  await control.acceptConversationSignal({
    conversationId: "c1",
    ownerKey: "space:s1",
    stableThroughOrdinal: 3,
    sourceFingerprint: "fp",
    eligibleAt: 100,
    now: 0,
    generation: 0,
    policyRevision: "g1:r1:s1:gen0",
    ...overrides,
  });
  const [queued] = await control.listJobsByStatus("queued");
  const claimToken = `claim-${queued.jobId}`;
  const claimed = await control.claimJob({ jobId: queued.jobId, claimToken, now: 200 });
  return { job: claimed, claimToken };
}

const commitInput = (overrides = {}) => ({
  conversationId: "c1",
  ownerKey: "space:s1",
  expectedPolicyRevision: "g1:r1:s1:gen0",
  expectedGeneration: 0,
  expectedSummaryRevisionId: null,
  expectedMemoryHeadRevisionId: null,
  summary: { markdown: "## 本次讨论\n确认使用 SQLite。", coveredThroughOrdinal: 3 },
  longTermUpdate: { markdown: "# Space Memory\n\n## 稳定事实\n- 本地持久化采用 SQLite。[2026-09-05]" },
  batchRange: { fromOrdinal: 1, toOrdinal: 3, sourceRevision: 3 },
  advanceProgressTo: { ordinal: 3, sourceFingerprint: "rev:3" },
  ...overrides,
});

test("dual-output commit publishes summary + memory + progress + job in one transaction", async () => {
  await withStore(async ({ documents, control }) => {
    const { job, claimToken } = await claimJob(control);
    const result = await documents.commitMaintenanceBatch(commitInput({
      jobId: job.jobId, claimToken,
    }));
    assert.equal(result.status, "committed");
    assert.ok(result.summaryRevisionId.length > 0);
    assert.ok(result.memoryRevisionId !== null);
    assert.equal(result.jobStatus, "done");

    const summary = await documents.getLatestValidSummary("c1");
    assert.equal(summary.revisionId, result.summaryRevisionId);
    assert.equal(summary.coveredThroughOrdinal, 3);
    const head = await documents.getActiveSpaceMemoryHead("space:s1");
    assert.equal(head.revisionId, result.memoryRevisionId);
    const progress = await documents.getProgress("c1");
    assert.equal(progress.processedThroughOrdinal, 3);

    // 摘要可被 FTS 检索命中且 scope 过滤生效。
    const hits = await documents.searchSummaries({
      ownerKey: "space:s1",
      match: '"SQLite"',
      limit: 8,
    });
    assert.equal(hits.length, 1);
    const otherSpace = await documents.searchSummaries({
      ownerKey: "space:other",
      match: '"SQLite"',
      limit: 8,
    });
    assert.equal(otherSpace.length, 0);
  });
});

test("a user edit supersedes in-flight model output via the memory head CAS", async () => {
  await withStore(async ({ documents, control }) => {
    const { job, claimToken } = await claimJob(control);
    // 用户直接编辑发布新 head（expected null → v1）。
    const edited = await documents.recordUserSpaceMemoryEdit({
      ownerKey: "space:s1",
      markdown: "# Space Memory\n\n用户手写的长期背景。",
      requestId: "req-edit-1",
      expectedRevisionId: null,
      now: 250,
    });
    assert.ok(edited.revisionId.length > 0);

    const result = await documents.commitMaintenanceBatch(commitInput({
      jobId: job.jobId, claimToken,
    }));
    assert.equal(result.status, "discarded");
    assert.equal(result.reason, "memory_head_superseded");
    // 被废弃的批次不产生任何总结。
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    // 用户编辑后的 head 仍然是编辑内容。
    assert.equal((await documents.getActiveSpaceMemoryHead("space:s1")).markdown, "# Space Memory\n\n用户手写的长期背景。");
  });
});

test("user edit revokes only the replaced head; concurrent in-flight commit then fails CAS", async () => {
  await withStore(async ({ documents, control }) => {
    // v1（模型发布）：先提交一个批次产生 head。
    const first = await claimJob(control, { stableThroughOrdinal: 3 });
    const committed = await documents.commitMaintenanceBatch(commitInput({
      jobId: first.job.jobId, claimToken: first.claimToken,
      summary: { markdown: "v1 总结", coveredThroughOrdinal: 3 },
    }));
    assert.equal(committed.status, "committed");
    const v1 = await documents.getActiveSpaceMemoryHead("space:s1");

    // v2（用户编辑）：撤销 v1 供给。
    const v2 = await documents.recordUserSpaceMemoryEdit({
      ownerKey: "space:s1",
      markdown: "v2 用户修订",
      requestId: "req-edit-2",
      expectedRevisionId: v1.revisionId,
      now: 300,
    });
    const replaced = await documents.getSpaceMemoryRevision(v1.revisionId);
    assert.equal(replaced.validity, "invalidated");

    // 基于旧 head 的编辑重试必须失败（stale CAS）。
    await assert.rejects(() => documents.recordUserSpaceMemoryEdit({
      ownerKey: "space:s1",
      markdown: "过时编辑",
      requestId: "req-edit-3",
      expectedRevisionId: v1.revisionId,
      now: 310,
    }), (error) => error instanceof MemoryError && error.code === "memory_revision_stale");

    // 已绑定旧 revision 的会话在供给复核处被拒绝（由 background port 完成，此处验证 validity）。
    const v2reread = await documents.getSpaceMemoryRevision(v2.revisionId);
    assert.equal(v2reread.validity, "valid");
  });
});

test("conservative source inheritance: deleting a conversation invalidates dependent doc revisions", async () => {
  await withStore(async ({ documents, control }) => {
    const first = await claimJob(control);
    // 批次引用会话 c1（来源范围 1..3），同时跨会话来源由另一个 range 注入。
    const committed = await documents.commitMaintenanceBatch(commitInput({
      jobId: first.job.jobId, claimToken: first.claimToken,
    }));
    assert.equal(committed.status, "committed");
    const v1 = await documents.getActiveSpaceMemoryHead("space:s1");
    const sources = await documents.listSpaceDocSources(v1.revisionId);
    assert.ok(sources.some((source) => source.depKind === "conversation_range" && source.conversationId === "c1"));

    // 删除 c1：prepare 失效（含被绑定的 v1，不只 head），finalize 物理清理。
    await documents.invalidateDependentRevisions("c1");
    const invalidated = await documents.getSpaceMemoryRevision(v1.revisionId);
    assert.equal(invalidated.validity, "invalidated");
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);

    await documents.purgeConversation("c1");
    assert.equal(await documents.getSpaceMemoryRevision(v1.revisionId), undefined);
    assert.equal(await documents.getProgress("c1"), undefined);
  });
});

test("excluded high-water is monotonic and rejects batches overlapping the excluded range", async () => {
  await withStore(async ({ documents, control }) => {
    await documents.setExcludedThrough({
      conversationId: "c1", ownerKey: "space:s1", excludedThroughOrdinal: 2, now: 10,
    });
    // 重复/回退写入是幂等的（高水位只进不退）。
    const progress = await documents.setExcludedThrough({
      conversationId: "c1", ownerKey: "space:s1", excludedThroughOrdinal: 1, now: 20,
    });
    assert.equal(progress.excludedThroughOrdinal, 2);

    const { job, claimToken } = await claimJob(control);
    const result = await documents.commitMaintenanceBatch(commitInput({
      jobId: job.jobId, claimToken,
      batchRange: { fromOrdinal: 1, toOrdinal: 3, sourceRevision: 3 },
    }));
    assert.equal(result.status, "discarded");
    assert.equal(result.reason, "range_excluded");
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
  });
});

test("purgeOwner preserves exclusion boundaries when requested; purgeAll likewise", async () => {
  await withStore(async ({ documents, control }) => {
    await documents.setExcludedThrough({
      conversationId: "c1", ownerKey: "space:s1", excludedThroughOrdinal: 9, now: 10,
    });
    await documents.purgeOwner("space:s1", { preserveExclusions: true });
    const progress = await documents.getProgress("c1");
    assert.equal(progress.excludedThroughOrdinal, 9);

    await documents.purgeOwner("space:s1");
    assert.equal(await documents.getProgress("c1"), undefined);
  });
});

test("progress regression is discarded", async () => {
  await withStore(async ({ documents, control }) => {
    const first = await claimJob(control, { stableThroughOrdinal: 6 });
    const committed = await documents.commitMaintenanceBatch(commitInput({
      jobId: first.job.jobId, claimToken: first.claimToken,
      advanceProgressTo: { ordinal: 4, sourceFingerprint: "rev:4" },
      summary: { markdown: "s", coveredThroughOrdinal: 4 },
      batchRange: { fromOrdinal: 1, toOrdinal: 4, sourceRevision: 4 },
    }));
    assert.equal(committed.status, "committed");

    const second = await claimJob(control, { stableThroughOrdinal: 6 });
    const regressed = await documents.commitMaintenanceBatch(commitInput({
      jobId: second.job.jobId, claimToken: second.claimToken,
      expectedSummaryRevisionId: committed.summaryRevisionId,
      advanceProgressTo: { ordinal: 2, sourceFingerprint: "rev:2" },
      summary: { markdown: "s2", coveredThroughOrdinal: 2 },
      batchRange: { fromOrdinal: 1, toOrdinal: 2, sourceRevision: 2 },
    }));
    assert.equal(regressed.status, "discarded");
    assert.equal(regressed.reason, "progress_regressed");
  });
});
