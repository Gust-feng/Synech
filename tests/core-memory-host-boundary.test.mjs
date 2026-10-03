import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { renderMemoryBackgroundBlock } from "../dist/app/memory/index.js";
import { POLICY_KEY, createMemoryBackgroundPort, createSqliteMemoryControlRepository, createSqliteMemoryDocumentRepository } from "../dist/app/memory/composition.js";

const OWNER = { kind: "space", id: "s1" };
async function withHarness(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-bg-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
  const port = createMemoryBackgroundPort({ documentRepository: documents });
  try { await run({ control, documents, port }); }
  finally { database.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}
async function edit(documents, { owner = OWNER, entryId = "entry-1", expectedRevisionId = null, kind = "initial", markdown = "用户确认的长期背景。", retractsRevisionIds = [], requestId = `req-${Math.random()}` } = {}) {
  const result = await documents.recordUserMemoryEdit({ owner, requestId, expectedGeneration: 0, now: 100,
    edit: { operation: expectedRevisionId === null ? "create" : "revise", entryId, expectedRevisionId, kind,
      markdown, retractsRevisionIds, applicability: null, occurredAt: null, reason: null, topicIds: [], related: [] } });
  return { ...result, overview: await documents.getOwnerMemoryRevision(result.overviewRevisionId) };
}
const binding = head => ({ owner: OWNER, revisionId: head.revisionId, generation: head.generation });

test("active published overview supplies; shadow/off block both initial binding and frozen supply", async () => {
  await withHarness(async ({ documents, port, control }) => {
    const first = await edit(documents);
    assert.equal((await port.getActiveOwnerMemoryHead(OWNER)).revisionId, first.overviewRevisionId);
    assert.equal((await port.resolveSupplyableBackground(binding(first.overview))).revisionId, first.overviewRevisionId);
    await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "shadow", enabled: true });
    assert.equal(await port.getActiveOwnerMemoryHead(OWNER), undefined);
    assert.equal(await port.resolveSupplyableBackground(binding(first.overview)), undefined);
    await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
    await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: false });
    assert.equal(await port.resolveSupplyableBackground(binding(first.overview)), undefined);
  });
});

test("ordinary change preserves the exact old overview; correction revokes only explicitly referenced revisions", async () => {
  await withHarness(async ({ documents, port }) => {
    const first = await edit(documents, { markdown: "旧时段预算 18000。" });
    const second = await edit(documents, { expectedRevisionId: first.revisionId, kind: "change", markdown: "新时段预算 22000。" });
    assert.equal((await port.resolveSupplyableBackground(binding(first.overview))).markdown, first.overview.markdown);
    const corrected = await edit(documents, { expectedRevisionId: second.revisionId, kind: "correction", markdown: "旧时段预算应为 19000。", retractsRevisionIds: [first.revisionId] });
    assert.equal(await port.resolveSupplyableBackground(binding(first.overview)), undefined);
    assert.ok(await port.resolveSupplyableBackground(binding(second.overview)), "unretracted revision stays bound even when no longer the head");
    assert.equal((await port.getActiveOwnerMemoryHead(OWNER)).revisionId, corrected.overviewRevisionId);
    const withdrawn = await edit(documents, { expectedRevisionId: corrected.revisionId, kind: "withdrawal", markdown: "", retractsRevisionIds: [corrected.revisionId] });
    assert.equal(await port.resolveSupplyableBackground(binding(corrected.overview)), undefined);
    assert.equal(renderMemoryBackgroundBlock({ ...withdrawn.overview }), "");
  });
});

test("clear generation and cross-owner identities reject opaque overview bindings", async () => {
  await withHarness(async ({ documents, port, control }) => {
    const first = await edit(documents);
    const other = await edit(documents, { owner: { kind: "space", id: "s2" }, entryId: "entry-w1" });
    assert.equal(await port.resolveSupplyableBackground(binding(other.overview)), undefined);
    assert.equal(await port.resolveSupplyableBackground({ ...binding(first.overview), owner: { kind: "space", id: "s2" } }), undefined);
    assert.ok(await port.resolveSupplyableBackground({ ...binding(other.overview), owner: { kind: "space", id: "s2" } }));
    await control.fenceForRemoval("space:s1");
    await documents.purgeOwner("space:s1", { preserveExclusions: true });
    await control.setLifecycleFence("space:s1", "none", null, 1);
    assert.equal(await port.resolveSupplyableBackground(binding(first.overview)), undefined);
    assert.equal(await port.getActiveOwnerMemoryHead(OWNER), undefined);
  });
});

async function publishFromConversation(control, documents) {
  await documents.indexTranscriptRange({ conversationId: "c1", ownerKey: "space:s1",
    publication: { policyRevision: "g1:r1:gen0", generation: 0, conversationGeneration: 0 },
    entries: [1, 2].map(ordinal => ({ ordinal, text: "合法稳定证据。", sourceRevision: 2 })), now: 10 });
  await control.acceptConversationSignal({ conversationId: "c1", ownerKey: "space:s1", stableThroughOrdinal: 2, sourceFingerprint: "fp", eligibleAt: 100, now: 0, generation: 0, policyRevision: "g1:r1:gen0" });
  const [queued] = await control.listJobsByStatus("queued");
  await control.claimJob({ jobId: queued.jobId, claimToken: "claim", now: 100 });
  const result = await documents.commitMaintenanceBatch({ jobId: queued.jobId, claimToken: "claim", conversationId: "c1", ownerKey: "space:s1",
    expectedPolicyRevision: "g1:r1:gen0", expectedGeneration: 0, expectedConversationGeneration: 0,
    expectedSummaryRevisionId: null, expectedMemoryHeadRevisionId: null, readSet: [], entryReadSet: [], topics: [],
    summary: { markdown: "依赖 c1 的辅助总结。", coveredThroughOrdinal: 2 },
    batchRange: { fromOrdinal: 1, toOrdinal: 2, sourceRevision: 2 }, advanceProgressTo: { ordinal: 2, sourceFingerprint: "rev:2" },
    sources: [{ sourceId: "source-c1", owner: OWNER, locator: { kind: "conversation_range", conversationId: "c1", fromOrdinal: 1, toOrdinal: 2, sourceRevision: 2, conversationGeneration: 0 }, lifecycle: "present", branch: "selected", createdAt: 100 }],
    mutations: [{ operation: "create", entryId: "entry-c1", revisionId: "revision-c1", expectedRevisionId: null, kind: "initial", markdown: "此前合法形成的认识。", applicability: null, occurredAt: null, reportedAt: "2026-09-05T00:00:00.000Z", reason: null, topicIds: [], related: [], sourceIds: ["source-c1"], retractsRevisionIds: [] }],
    overview: { markdown: "此前合法形成的认识。", entries: [{ entryId: "entry-c1", revisionId: "revision-c1" }] } });
  assert.equal(result.status, "committed");
  return documents.getActiveOwnerMemoryHead("space:s1");
}

test("ordinary source deletion retains immutable overview and dynamically reports unavailable readback", async () => {
  await withHarness(async ({ control, documents, port }) => {
    const head = await publishFromConversation(control, documents);
    await control.fenceForRemoval("conversation:c1");
    await documents.markConversationSourcesDeleted("c1");
    await documents.purgeConversationAuxiliaries("c1");
    const supplied = await port.resolveSupplyableBackground(binding(head));
    assert.equal(supplied.markdown, head.markdown);
    assert.deepEqual(supplied.sourceStates, [{ sourceId: "source-c1", readback: "deleted" }]);
    assert.ok(renderMemoryBackgroundBlock(supplied).includes('"readback":"deleted"'));
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
  });
});

test("superseded source keeps historical content but stops overview; later deletion does not revive it", async () => {
  await withHarness(async ({ control, documents, port }) => {
    const head = await publishFromConversation(control, documents);
    await control.fenceForRemoval("conversation:c1");
    await documents.supersedeConversationSources({ owner: OWNER, conversationId: "c1", retainedThroughOrdinal: 1 });
    assert.equal(await port.resolveSupplyableBackground(binding(head)), undefined);
    await documents.markConversationSourcesDeleted("c1");
    assert.equal(await port.resolveSupplyableBackground(binding(head)), undefined);
    const view = await documents.getEntryRevision({ ownerKey: "space:s1", entryId: "entry-c1", revisionId: "revision-c1" });
    assert.equal(view.role, "historical");
    assert.equal(view.sources[0].branch, "superseded");
  });
});

test("concurrent disable or exact correction is decided by the final repository transaction", async () => {
  await withHarness(async ({ control, documents }) => {
    const first = await edit(documents);
    const bound = binding(first.overview);
    async function supplyAfter(change) {
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const port = createMemoryBackgroundPort({ documentRepository: {
        getActiveOwnerMemoryHead: documents.getActiveOwnerMemoryHead,
        async getSupplyableMemoryRevision(input) { entered(); await gate; return documents.getSupplyableMemoryRevision(input); },
      } });
      const pending = port.resolveSupplyableBackground(bound);
      await started;
      try { await change(); } finally { release(); }
      assert.equal(await pending, undefined);
    }
    await supplyAfter(() => control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: false }));
    await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
    await supplyAfter(() => edit(documents, { expectedRevisionId: first.revisionId, kind: "correction", markdown: "纠正。", retractsRevisionIds: [first.revisionId] }));
  });
});
