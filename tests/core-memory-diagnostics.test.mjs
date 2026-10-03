import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { createMemoryAdminApplication, createMemoryBackgroundPort, createMemoryDiagnostics, createMemoryFeature, createControlMemoryLifecycle, createSqliteMemoryControlRepository, createSqliteMemoryDocumentRepository, POLICY_KEY } from "../dist/app/memory/composition.js";
import { handleMemoryDiagnosticsRoute } from "../dist/app/panel-server/routes-memory.js";

async function withDiagnostics(run) {
  const temp = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temp, "synech-memory-diagnostics-"));
  const database = new SqliteRuntimeDatabase(path.join(root, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  const bindings = new Map();
  const searchCalls = [];
  const outcomes = [
    { at: 990, jobId: "job-a", conversationId: "a-0", ownerKey: "space:a", outcome: "failed", reason: "network", longTermUpdated: false },
    { at: 980, jobId: "job-b", conversationId: "b-0", ownerKey: "space:b", outcome: "committed", longTermUpdated: true },
  ];
  try {
    await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
    await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
    const admin = createMemoryAdminApplication({ controlRepository: control, documentRepository: documents,
      lifecycle: createControlMemoryLifecycle(control, { documentRepository: documents }),
      spaceAdmission: { admit: async (_id, fn) => fn(), assertAvailable() {} },
      workspaceAdmission: { admit: async (_id, fn) => fn() },
      ownerExistsQuery: { isSpaceAvailable: async id => ["a", "b"].includes(id), isWorkspaceAvailable: async () => false },
      conversationHighWaterQuery: { listConversationHighWaters: async () => [] },
    });
    const diagnostics = createMemoryDiagnostics({ control, documents, admin,
      background: createMemoryBackgroundPort({ controlRepository: control, documentRepository: documents }),
      history: { search: async input => { searchCalls.push(input); return { outcome: "no_hit", items: [], coverage: { summary: "available", transcript: "partial" } }; } },
      getConversation: async id => /^[ab]-\d+$/u.test(id) ? { title: `会话 ${id}`, owner: { kind: "space", id: id[0] }, active: id === "a-0" } : undefined,
      getBinding: async id => bindings.get(id),
      ownerQuery: {
        isOwnerAvailable: async owner => owner.kind === "space" && ["a", "b"].includes(owner.id),
        getOwnerTitle: async owner => owner.kind === "space" && ["a", "b"].includes(owner.id) ? `Space ${owner.id}` : undefined,
      },
      recentOutcomes: () => outcomes, now: () => 1000,
    });
    const seedJob = id => control.acceptConversationSignal({ conversationId: id, ownerKey: `space:${id[0]}`,
      stableThroughOrdinal: 4, sourceFingerprint: "rev:4", eligibleAt: 500, now: 100,
      generation: 0, policyRevision: "g1:r1:gen0" });
    await run({ database, control, documents, admin, diagnostics, bindings, searchCalls, seedJob });
  } finally {
    database.close();
    assert.equal(path.dirname(path.resolve(root)), temp);
    assert.ok(path.basename(root).startsWith("synech-memory-diagnostics-"));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

test("diagnostic jobs are bounded, scope-filtered and do not mutate stored progress", async () => {
  await withDiagnostics(async ({ diagnostics, database, seedJob }) => {
    for (let i = 0; i < 35; i++) await seedJob(`a-${i}`);
    await seedJob("b-0");
    const before = database.connection.prepare("SELECT total_changes() AS count").get().count;
    const snapshot = await diagnostics.getSnapshot({ owner: { kind: "space", id: "a" } });
    assert.equal(snapshot.jobs.queued, 35);
    assert.equal(snapshot.jobRows.length, 30);
    assert.equal(snapshot.jobRowsTruncated, true);
    assert.ok(snapshot.jobRows.every(row => row.ownerKey === "space:a"));
    assert.ok(snapshot.recentOutcomes.every(row => row.ownerKey === "space:a"));
    assert.equal(database.connection.prepare("SELECT total_changes() AS count").get().count, before);
    const active = await diagnostics.getSnapshot({ owner: { kind: "space", id: "a" }, conversationId: "a-0" });
    assert.equal(active.jobRows[0].waitReason, "active_conversation");
    assert.equal(active.context.binding.state, "unbound");
    assert.equal(database.connection.prepare("SELECT total_changes() AS count").get().count, before);
  });
});

test("binding inspection preserves none and stops exposing a revoked revision", async () => {
  await withDiagnostics(async ({ diagnostics, documents, bindings, searchCalls }) => {
    const owner = { kind: "space", id: "a" };
    const edit = { operation: "create", entryId: "entry-binding", expectedRevisionId: null, kind: "initial", markdown: "原来的背景",
      applicability: null, occurredAt: null, reason: null, topicIds: [], related: [], retractsRevisionIds: [] };
    const head = await documents.recordUserMemoryEdit({ owner, edit, requestId: "edit-1", expectedGeneration: 0, now: 10 });
    const overview = await documents.getOwnerMemoryRevision(head.overviewRevisionId);
    bindings.set("a-0", { kind: "none", boundAt: "2026-09-06T00:00:00Z" });
    assert.equal((await diagnostics.getSnapshot({ conversationId: "a-0" })).context.binding.state, "none");
    bindings.set("a-0", { kind: "revision", boundAt: "2026-09-06T00:00:00Z", revisionId: overview.revisionId, revision: overview.revision, generation: overview.generation });
    const allowed = await diagnostics.getSnapshot({ conversationId: "a-0" });
    assert.equal(allowed.context.binding.state, "available");
    assert.ok(allowed.context.binding.markdown.includes("原来的背景"));
    await documents.recordUserMemoryEdit({ owner, edit: { ...edit, operation: "revise", expectedRevisionId: head.revisionId,
      kind: "correction", markdown: "用户修订后的背景", retractsRevisionIds: [head.revisionId] }, requestId: "edit-2", expectedGeneration: 0, now: 20 });
    const revoked = await diagnostics.getSnapshot({ conversationId: "a-0" });
    assert.equal(revoked.context.binding.state, "unavailable");
    assert.equal(revoked.context.binding.markdown, null);
    assert.ok(revoked.context.memory.markdown.includes("用户修订后的背景"));
    assert.equal(bindings.get("a-0").revisionId, overview.revisionId);
    assert.equal(searchCalls.length, 0);
  });
});

test("diagnostic search uses the history port and rejects cross-space conversation selection", async () => {
  await withDiagnostics(async ({ diagnostics, searchCalls }) => {
    await assert.rejects(diagnostics.getSnapshot({ owner: { kind: "space", id: "a" }, conversationId: "b-0" }), { code: "memory_invalid_owner" });
    await assert.rejects(diagnostics.searchHistory({ owner: { kind: "space", id: "a" }, conversationId: "b-0", query: "预算", source: "all" }), { code: "memory_invalid_owner" });
    assert.equal(searchCalls.length, 0);
    await diagnostics.searchHistory({ owner: { kind: "space", id: "a" }, conversationId: "a-0", query: "预算", source: "all" });
    assert.deepEqual(searchCalls[0], { owner: { kind: "space", id: "a" }, conversationId: "a-0", query: "预算", sources: "all", limit: 8 });
  });
});

test("diagnostic HTTP routes validate input and delegate to the feature query", async () => {
  await withDiagnostics(async ({ diagnostics, admin }) => {
    const feature = createMemoryFeature({ adminApplication: admin, diagnostics });
    let payload;
    const response = { writeHead(status) { assert.equal(status, 200); }, end(text) { payload = JSON.parse(text); } };
    const request = { method: "GET" };
    await handleMemoryDiagnosticsRoute(feature, request, response, new URL("http://localhost/api/memory/diagnostics?ownerKind=space&ownerId=a&conversationId=a-0"));
    assert.deepEqual(payload.diagnostics.context.owner, { kind: "space", id: "a" });
    await handleMemoryDiagnosticsRoute(feature, request, response, new URL("http://localhost/api/memory/diagnostics/search?ownerKind=space&ownerId=a&query=test&source=all"));
    assert.equal(payload.result.outcome, "no_hit");
    await assert.rejects(handleMemoryDiagnosticsRoute(feature, request, response,
      new URL("http://localhost/api/memory/diagnostics/search?query=test")), { code: "memory_diagnostic_query_invalid" });
  });
});
