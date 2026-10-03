import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { POLICY_KEY, createControlMemoryLifecycle, createSqliteMemoryControlRepository, createSqliteMemoryDocumentRepository } from "../dist/app/memory/composition.js";

const owner = { kind: "space", id: "s1" };
async function withHarness(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-lifecycle-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
  const lifecycle = createControlMemoryLifecycle(control, { documentRepository: documents });
  try { await run({ control, documents, lifecycle, database }); }
  finally { database.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}
async function seed(documents, control) {
  const job = await control.acceptConversationSignal({ conversationId: "c1", ownerKey: "space:s1", stableThroughOrdinal: 2,
    sourceFingerprint: "fp", eligibleAt: 100, now: 0, generation: 0, policyRevision: "g1:r1:gen0", conversationGeneration: 0 });
  await control.claimJob({ jobId: job.jobId, claimToken: "seed", now: 100 });
  await documents.indexTranscriptRange({ conversationId: "c1", ownerKey: "space:s1", now: 100,
    publication: { policyRevision: "g1:r1:gen0", generation: 0, conversationGeneration: 0 },
    entries: [{ ordinal: 1, text: "prefix", sourceRevision: 1 }, { ordinal: 2, text: "suffix", sourceRevision: 2 }] });
  const common = { applicability: null, occurredAt: null, reportedAt: "2026-10-03T00:00:00.000Z", reason: null, topicIds: [], related: [],
    operation: "create", expectedRevisionId: null, kind: "initial", retractsRevisionIds: [] };
  const batch = { jobId: job.jobId, claimToken: "seed", conversationId: "c1", ownerKey: "space:s1", expectedPolicyRevision: "g1:r1:gen0",
    expectedGeneration: 0, expectedConversationGeneration: 0, expectedSummaryRevisionId: null, expectedMemoryHeadRevisionId: null,
    summary: { markdown: "summary", coveredThroughOrdinal: 2 }, batchRange: { fromOrdinal: 1, toOrdinal: 2, sourceRevision: 2 },
    advanceProgressTo: { ordinal: 2, sourceFingerprint: "fp" }, topics: [], readSet: [], entryReadSet: [],
    sources: [1, 2].map(n => ({ sourceId: `source-${n}`, owner, locator: { kind: "conversation_range", conversationId: "c1",
      fromOrdinal: n, toOrdinal: n, sourceRevision: n, conversationGeneration: 0 }, lifecycle: "present", branch: "selected", createdAt: 100 })),
    mutations: [1, 2].map(n => ({ ...common, entryId: `entry-${n}`, revisionId: `revision-${n}`, markdown: `recognition ${n}`, sourceIds: [`source-${n}`] })),
    overview: { markdown: "both recognitions", entries: [1, 2].map(n => ({ entryId: `entry-${n}`, revisionId: `revision-${n}` })) } };
  const result = await documents.commitMaintenanceBatch(batch);
  assert.equal(result.status, "committed"); return { result, batch };
}
const supply = (documents, revisionId) => documents.getSupplyableMemoryRevision({ ownerKey: "space:s1", revisionId, generation: 0 });
const entryView = (documents, n) => documents.getEntryRevision({ ownerKey: "space:s1", entryId: `entry-${n}`, revisionId: `revision-${n}` });

test("conversation removal fences late work but retains published recognition and projects deleted sources", async () => {
  await withHarness(async ({ documents, control, lifecycle }) => {
    const { result } = await seed(documents, control);
    const ticket = await lifecycle.prepareConversationRemoval("c1");
    assert.ok(await supply(documents, result.memoryRevisionId));
    assert.equal((await entryView(documents, 1)).role, "current");
    await lifecycle.finalizeConversationRemoval(ticket);
    assert.equal((await entryView(documents, 1)).sources[0].lifecycle, "deleted");
    assert.equal((await supply(documents, result.memoryRevisionId)).sourceStates.every(state => state.readback === "deleted"), true);
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    assert.equal(await documents.getTranscriptCoverage("c1"), undefined);
    assert.equal(await documents.getProgress("c1"), undefined);
  });
});

test("conversation finalization retries after auxiliary purge failure with durable tombstone", async () => {
  await withHarness(async ({ documents, control }) => {
    await seed(documents, control);
    let fail = true;
    const retryable = createControlMemoryLifecycle(control, { documentRepository: { ...documents,
      async purgeConversationAuxiliaries(...args) { if (fail) { fail = false; throw new Error("purge failure"); } return documents.purgeConversationAuxiliaries(...args); } } });
    const ticket = await retryable.prepareConversationRemoval("c1");
    await assert.rejects(() => retryable.finalizeConversationRemoval(ticket), /purge failure/);
    assert.equal((await control.getLifecycle("conversation:c1")).fenceState, "tombstone");
    await retryable.finalizeConversationRemoval(ticket);
    await retryable.finalizeConversationRemoval(ticket);
    assert.equal(await documents.getProgress("c1"), undefined);
    assert.equal((await entryView(documents, 1)).role, "current");
    const next = await control.fenceForRemoval("conversation:c1");
    assert.ok(next.generation > ticket.fencedGeneration);
    await assert.rejects(() => retryable.finalizeConversationRemoval(ticket), error => error.code === "memory_generation_fenced");
  });
});

test("owner removal purges facts and keeps its exclusion boundary and generation fence", async () => {
  await withHarness(async ({ documents, control, lifecycle }) => {
    await seed(documents, control);
    await documents.setExcludedThrough({ conversationId: "other", ownerKey: "space:s1", excludedThroughOrdinal: 7, now: 10 });
    const ticket = await lifecycle.prepareOwnerRemoval(owner);
    await lifecycle.finalizeOwnerRemoval(ticket);
    assert.equal(await documents.getActiveOwnerMemoryHead("space:s1"), undefined);
    assert.equal(await documents.getEntry({ ownerKey: "space:s1", entryId: "entry-1" }), undefined);
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    assert.equal((await documents.getProgress("other")).excludedThroughOrdinal, 7);
    assert.equal((await control.getLifecycle("space:s1")).fenceState, "tombstone");
  });
});

test("late claimed publication is discarded after removal preparation", async () => {
  await withHarness(async ({ documents, control, lifecycle }) => {
    const { batch } = await seed(documents, control);
    const job = await control.acceptConversationSignal({ conversationId: "c1", ownerKey: "space:s1", stableThroughOrdinal: 3,
      sourceFingerprint: "fp3", eligibleAt: 100, now: 101, generation: 0, policyRevision: "g1:r1:gen0" });
    await control.claimJob({ jobId: job.jobId, claimToken: "late", now: 101 });
    const ticket = await lifecycle.prepareConversationRemoval("c1");
    const late = await documents.commitMaintenanceBatch({ ...batch, jobId: job.jobId, claimToken: "late" });
    assert.equal(late.status, "discarded");
    await lifecycle.finalizeConversationRemoval(ticket);
  });
});

test("branch replacement preserves selected prefix, retires suffix and never revives it at the same ordinal", async () => {
  await withHarness(async ({ documents, control, lifecycle }) => {
    const { result } = await seed(documents, control);
    await lifecycle.supersedeConversationSources({ conversationId: "c1", owner, retainedThroughOrdinal: 1 });
    assert.equal((await entryView(documents, 1)).role, "current");
    assert.equal((await entryView(documents, 2)).role, "historical");
    assert.equal((await entryView(documents, 2)).currentRevisionId, null);
    assert.equal(await supply(documents, result.memoryRevisionId), undefined);
    assert.equal((await documents.getOwnerMemoryRevision(result.memoryRevisionId)).validity, "valid");
    const state = await control.getLifecycle("conversation:c1");
    assert.equal(state.fenceState, "none");
    await documents.indexTranscriptRange({ conversationId: "c1", ownerKey: "space:s1", now: 200,
      publication: { policyRevision: "g1:r1:gen0", generation: 0, conversationGeneration: state.generation },
      entries: [{ ordinal: 2, text: "replacement", sourceRevision: 99 }] });
    assert.equal((await entryView(documents, 2)).sources[0].branch, "superseded");
    assert.equal((await entryView(documents, 2)).role, "historical");
    await lifecycle.supersedeConversationSources({ conversationId: "c1", owner, retainedThroughOrdinal: 2 });
    assert.equal((await entryView(documents, 2)).sources[0].branch, "superseded");
  });
});

test("branch retry after completed auxiliary purge cannot lose a larger prior clear exclusion", async () => {
  await withHarness(async ({ documents, control, lifecycle }) => {
    await seed(documents, control);
    await documents.setExcludedThrough({ conversationId: "c1", ownerKey: "space:s1", excludedThroughOrdinal: 9, now: 10 });
    const interrupted = createControlMemoryLifecycle(control, { documentRepository: { ...documents,
      async setExcludedThrough() { throw new Error("interrupted after purge"); } } });
    await assert.rejects(() => interrupted.supersedeConversationSources({ conversationId: "c1", owner, retainedThroughOrdinal: 1 }), /interrupted after purge/);
    assert.equal((await documents.getProgress("c1")).excludedThroughOrdinal, 9);
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    assert.equal((await control.getLifecycle("conversation:c1")).fenceState, "fenced");
    await lifecycle.supersedeConversationSources({ conversationId: "c1", owner, retainedThroughOrdinal: 1 });
    assert.equal((await documents.getProgress("c1")).excludedThroughOrdinal, 9);
    assert.equal((await control.getLifecycle("conversation:c1")).fenceState, "none");
  });
});
