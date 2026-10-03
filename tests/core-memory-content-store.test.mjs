import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { MemoryError } from "../dist/app/memory/index.js";
import { POLICY_KEY, createSqliteMemoryDocumentRepository, createSqliteMemoryControlRepository } from "../dist/app/memory/composition.js";

const owner = { kind: "space", id: "s1" };
const content = { markdown: "SQLite 是本地存储。", applicability: null, occurredAt: null,
  reportedAt: "2026-10-03T00:00:00.000Z", reason: null, topicIds: [], related: [] };
const userInput = (entryId, overrides = {}) => ({ owner, requestId: `create-${entryId}`, now: 250, expectedGeneration: 0,
  edit: { ...content, reason: null, operation: "create", entryId, expectedRevisionId: null, kind: "initial", retractsRevisionIds: [] }, ...overrides });
async function withStore(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-doc-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const documents = createSqliteMemoryDocumentRepository(database);
  const control = createSqliteMemoryControlRepository(database);
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
  try { await run({ documents, control, database }); }
  finally { database.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}
async function claimJob(control, overrides = {}) {
  const job = await control.acceptConversationSignal({ conversationId: "c1", ownerKey: "space:s1", stableThroughOrdinal: 3,
    sourceFingerprint: "fp", eligibleAt: 100, now: 0, generation: 0, conversationGeneration: 0, policyRevision: "g1:r1:gen0", ...overrides });
  const claimToken = `claim-${job.jobId}`;
  const claimed = await control.claimJob({ jobId: job.jobId, claimToken, now: 200 });
  return { job: claimed, claimToken };
}
const commitInput = (overrides = {}) => ({
  conversationId: "c1", ownerKey: "space:s1", expectedPolicyRevision: "g1:r1:gen0", expectedGeneration: 0,
  expectedConversationGeneration: 0, expectedSummaryRevisionId: null, expectedMemoryHeadRevisionId: null,
  summary: { markdown: "确认 SQLite", coveredThroughOrdinal: 3 },
  batchRange: { fromOrdinal: 1, toOrdinal: 3, sourceRevision: 3 }, advanceProgressTo: { ordinal: 3, sourceFingerprint: "rev:3" },
  readSet: [], entryReadSet: [], topics: [],
  sources: [{ sourceId: "source-c1", owner, locator: { kind: "conversation_range", conversationId: "c1", fromOrdinal: 1,
    toOrdinal: 3, sourceRevision: 3, conversationGeneration: 0 }, lifecycle: "present", branch: "selected", createdAt: 200 }],
  mutations: [{ ...content, operation: "create", entryId: "entry-1", revisionId: "entry-1-r1", expectedRevisionId: null,
    kind: "initial", retractsRevisionIds: [], sourceIds: ["source-c1"] }],
  overview: { markdown: "SQLite 是本地存储。", entries: [{ entryId: "entry-1", revisionId: "entry-1-r1" }] }, ...overrides,
});
async function publish(documents, control, overrides = {}) {
  const { job, claimToken } = await claimJob(control);
  await documents.indexTranscriptRange({ conversationId: "c1", ownerKey: "space:s1", now: 100,
    publication: { policyRevision: "g1:r1:gen0", generation: 0, conversationGeneration: 0 },
    entries: [{ ordinal: 3, text: "SQLite", sourceRevision: 3 }] });
  const result = await documents.commitMaintenanceBatch(commitInput({ jobId: job.jobId, claimToken, ...overrides }));
  assert.equal(result.status, "committed"); return result;
}
const getRevision = (documents, ref) => documents.getEntryRevision({ ownerKey: "space:s1", ...ref });
const supply = (documents, revisionId) => documents.getSupplyableMemoryRevision({ ownerKey: "space:s1", revisionId, generation: 0 });

test("entry + sources + overview + summary + progress + job publish atomically and stay owner isolated", async () => {
  await withStore(async ({ documents, control }) => {
    const result = await publish(documents, control);
    assert.deepEqual(result.entries, [{ entryId: "entry-1", revisionId: "entry-1-r1" }]);
    assert.equal((await documents.getLatestValidSummary("c1")).revisionId, result.summaryRevisionId);
    assert.equal((await documents.getProgress("c1")).processedThroughOrdinal, 3);
    assert.equal(result.jobStatus, "done");
    assert.equal((await supply(documents, result.memoryRevisionId)).sourceStates[0].readback, "available");
    assert.equal((await documents.searchSummaries({ ownerKey: "space:s1", match: '"SQLite"', limit: 8 })).length, 1);
    assert.equal((await documents.searchEntryCandidates({ ownerKey: "space:s1", match: '"SQLite"', includeHistory: false, limit: 8 })).candidates.length, 1);
    assert.equal((await documents.searchEntryCandidates({ ownerKey: "space:other", match: '"SQLite"', includeHistory: true, limit: 8 })).candidates.length, 0);
    assert.equal(await documents.getEntry({ ownerKey: "space:other", entryId: "entry-1" }), undefined);
  });
});

test("user edit makes an in-flight overview CAS stale without publishing auxiliary outputs", async () => {
  await withStore(async ({ documents, control }) => {
    const { job, claimToken } = await claimJob(control);
    await documents.recordUserMemoryEdit(userInput("user-entry"));
    await documents.indexTranscriptRange({ conversationId: "c1", ownerKey: "space:s1", now: 100,
      publication: { policyRevision: "g1:r1:gen0", generation: 0, conversationGeneration: 0 },
      entries: [{ ordinal: 3, text: "SQLite", sourceRevision: 3 }] });
    const result = await documents.commitMaintenanceBatch(commitInput({ jobId: job.jobId, claimToken }));
    assert.deepEqual(result, { status: "discarded", reason: "memory_head_superseded" });
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    assert.equal(await documents.getEntry({ ownerKey: "space:s1", entryId: "entry-1" }), undefined);
  });
});

test("single-entry CAS and request payload idempotency preserve other entries", async () => {
  await withStore(async ({ documents }) => {
    const input = userInput("a");
    const first = await documents.recordUserMemoryEdit(input);
    const other = await documents.recordUserMemoryEdit(userInput("b"));
    assert.deepEqual(await documents.recordUserMemoryEdit({ ...input, now: 300 }), first);
    await assert.rejects(() => documents.recordUserMemoryEdit({ ...input, edit: { ...input.edit, markdown: "different" } }),
      error => error instanceof MemoryError && error.code === "memory_request_conflict");
    const edited = await documents.recordUserMemoryEdit({ ...input, requestId: "change-a", edit: { ...input.edit,
      operation: "revise", kind: "change", expectedRevisionId: first.revisionId, markdown: "新状态" } });
    assert.equal((await getRevision(documents, first)).supplyState, "eligible");
    assert.equal((await getRevision(documents, first)).role, "historical");
    assert.equal((await documents.getEntry({ ownerKey: "space:s1", entryId: "b" })).headRevisionId, other.revisionId);
    await assert.rejects(() => documents.recordUserMemoryEdit({ ...input, requestId: "stale", edit: { ...input.edit,
      operation: "revise", kind: "supplement", expectedRevisionId: first.revisionId } }), error => error.code === "memory_revision_stale");
    assert.equal((await documents.getEntry({ ownerKey: "space:s1", entryId: "a" })).headRevisionId, edited.revisionId);
  });
});

test("explicit correction revokes only named old revisions and their bound overviews; withdrawal never falls back", async () => {
  await withStore(async ({ documents }) => {
    const input = userInput("a");
    const first = await documents.recordUserMemoryEdit(input);
    const second = await documents.recordUserMemoryEdit({ ...input, requestId: "supplement", edit: { ...input.edit,
      operation: "revise", kind: "supplement", expectedRevisionId: first.revisionId, markdown: "更多条件" } });
    const corrected = await documents.recordUserMemoryEdit({ ...input, requestId: "correction", edit: { ...input.edit,
      operation: "revise", kind: "correction", expectedRevisionId: second.revisionId, retractsRevisionIds: [second.revisionId], markdown: "纠正" } });
    assert.equal((await getRevision(documents, first)).supplyState, "eligible");
    assert.ok(await supply(documents, first.overviewRevisionId));
    assert.equal((await getRevision(documents, second)).supplyState, "revoked");
    assert.equal(await supply(documents, second.overviewRevisionId), undefined);
    const withdrawn = await documents.recordUserMemoryEdit({ ...input, requestId: "withdraw", edit: { ...input.edit,
      operation: "revise", kind: "withdrawal", expectedRevisionId: corrected.revisionId, retractsRevisionIds: [corrected.revisionId], markdown: "" } });
    const current = await getRevision(documents, withdrawn);
    assert.equal(current.role, "withdrawn"); assert.equal(current.currentRevisionId, null);
    assert.equal((await getRevision(documents, first)).currentRevisionId, null);
    assert.equal((await documents.getEntry({ ownerKey: "space:s1", entryId: "a" })).headRevisionId, withdrawn.revisionId);
  });
});

test("ordinary source deletion keeps published entries and overview supply while purging auxiliaries", async () => {
  await withStore(async ({ documents, control }) => {
    const result = await publish(documents, control);
    await control.fenceForRemoval("conversation:c1");
    await documents.markConversationSourcesDeleted("c1");
    await documents.purgeConversationAuxiliaries("c1");
    assert.equal((await getRevision(documents, result.entries[0])).role, "current");
    assert.equal((await supply(documents, result.memoryRevisionId)).sourceStates[0].readback, "deleted");
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    assert.equal((await documents.listSummarySources(result.summaryRevisionId)).length, 0);
    assert.equal(await documents.getProgress("c1"), undefined);
  });
});

test("branch retirement and deletion stay independent and the head never falls back", async () => {
  await withStore(async ({ documents, control }) => {
    const result = await publish(documents, control);
    await documents.supersedeConversationSources({ conversationId: "c1", owner, retainedThroughOrdinal: 1 });
    await documents.markConversationSourcesDeleted("c1");
    const historical = await getRevision(documents, result.entries[0]);
    assert.equal(historical.role, "historical"); assert.equal(historical.currentRevisionId, null);
    assert.equal(historical.sources[0].lifecycle, "deleted"); assert.equal(historical.sources[0].branch, "superseded");
    assert.equal(await supply(documents, result.memoryRevisionId), undefined);
    assert.equal((await documents.getOwnerMemoryRevision(result.memoryRevisionId)).validity, "valid");
    assert.equal((await documents.getEntry({ ownerKey: "space:s1", entryId: "entry-1" })).headRevisionId, "entry-1-r1");
  });
});

test("extra raw source generation is revalidated in the publication transaction", async () => {
  await withStore(async ({ documents, control }) => {
    const first = await publish(documents, control);
    const extra = (await getRevision(documents, first.entries[0])).sources[0];
    await documents.indexTranscriptRange({ ownerKey: "space:s1", conversationId: "c1", now: 210,
      publication: { policyRevision: "g1:r1:gen0", generation: 0, conversationGeneration: 0 }, entries: [{ ordinal: 3, text: "SQLite", sourceRevision: 3 }] });
    const { job, claimToken } = await claimJob(control, { conversationId: "c2" });
    await control.fenceForRemoval("conversation:c1");
    const result = await documents.commitMaintenanceBatch(commitInput({ jobId: job.jobId, claimToken, conversationId: "c2",
      expectedMemoryHeadRevisionId: first.memoryRevisionId, readSet: [{ sourceId: extra.sourceId, conversationGeneration: 0 }],
      sources: [], mutations: [], overview: null }));
    assert.deepEqual(result, { status: "discarded", reason: "source_changed" });
    assert.equal(await documents.getLatestValidSummary("c2"), undefined);
  });
});

test("excluded high water rejects overlap, remains monotonic, and owner/global purge removes all facts", async () => {
  await withStore(async ({ documents, control, database }) => {
    await publish(documents, control);
    await documents.setExcludedThrough({ conversationId: "c1", ownerKey: "space:s1", excludedThroughOrdinal: 2, now: 10 });
    assert.equal((await documents.setExcludedThrough({ conversationId: "c1", ownerKey: "space:s1", excludedThroughOrdinal: 1, now: 20 })).excludedThroughOrdinal, 2);
    const { job, claimToken } = await claimJob(control, { stableThroughOrdinal: 6 });
    const conflict = await documents.commitMaintenanceBatch(commitInput({ jobId: job.jobId, claimToken, sources: [], mutations: [], overview: null }));
    assert.equal(conflict.reason, "range_excluded");
    await documents.purgeOwner("space:s1", { preserveExclusions: true });
    assert.equal((await documents.getProgress("c1")).excludedThroughOrdinal, 2);
    assert.equal((await documents.getProgress("c1")).processedThroughOrdinal, 0);
    for (const table of ["memory_entry", "memory_entry_revision", "memory_source", "memory_entry_fts", "memory_overview_dependency", "memory_doc_source", "memory_conversation_summary"]) {
      assert.equal(database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
    await documents.recordUserMemoryEdit(userInput("new"));
    await documents.purgeAll({ preserveExclusions: true });
    assert.equal((await documents.getProgress("c1")).excludedThroughOrdinal, 2);
    assert.equal(await documents.hasContent(), false);
  });
});

test("progress regression and invalid overview references discard the entire batch", async () => {
  await withStore(async ({ documents, control }) => {
    const first = await publish(documents, control, { advanceProgressTo: { ordinal: 2, sourceFingerprint: "rev:2" } });
    const { job, claimToken } = await claimJob(control, { stableThroughOrdinal: 6 });
    const regressed = await documents.commitMaintenanceBatch(commitInput({ jobId: job.jobId, claimToken,
      expectedSummaryRevisionId: first.summaryRevisionId, expectedMemoryHeadRevisionId: first.memoryRevisionId,
      advanceProgressTo: { ordinal: 1, sourceFingerprint: "old" }, sources: [], mutations: [], overview: null }));
    assert.equal(regressed.reason, "progress_regressed");
    const invalid = await documents.commitMaintenanceBatch(commitInput({ jobId: job.jobId, claimToken,
      expectedSummaryRevisionId: first.summaryRevisionId, expectedMemoryHeadRevisionId: first.memoryRevisionId,
      sources: [], mutations: [], overview: { markdown: "bad", entries: [{ entryId: "other", revisionId: "unknown" }] } }));
    assert.equal(invalid.status, "discarded");
    assert.equal((await documents.getLatestValidSummary("c1")).revisionId, first.summaryRevisionId);
  });
});

test("cross-owner retraction is rejected without replacing entry or invalidating unrelated overview", async () => {
  await withStore(async ({ documents }) => {
    const first = await documents.recordUserMemoryEdit(userInput("a"));
    const other = await documents.recordUserMemoryEdit({ ...userInput("other"), owner: { kind: "space", id: "s2" } });
    const input = userInput("a");
    await assert.rejects(() => documents.recordUserMemoryEdit({ ...input, requestId: "wrong-retract", edit: { ...input.edit,
      operation: "revise", kind: "correction", expectedRevisionId: first.revisionId, retractsRevisionIds: [other.revisionId] } }), error => error.code === "memory_invalid_edit");
    assert.equal((await documents.getEntry({ ownerKey: "space:s1", entryId: "a" })).headRevisionId, first.revisionId);
    assert.ok(await supply(documents, first.overviewRevisionId));
  });
});
