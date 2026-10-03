import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { createSqliteMemoryControlRepository, createSqliteMemoryDocumentRepository, createControlMemoryLifecycle } from "../dist/app/memory/composition.js";
import { resolveAdmissionFromPolicy } from "../dist/app/memory/policy/policy-snapshot.js";

import { startLocalPanelServer } from "../dist/app/panel-server/request-handler.js";

test("panel host exposes owner-scoped memory controls through the production HTTP boundary", async () => {
  const productHome = await mkdtemp(path.join(os.tmpdir(), "synech-memory-panel-api-"));
  let selectedBackup;
  const start = () => startLocalPanelServer({ host: "127.0.0.1", port: 0, productHome, restorePicker: async () => selectedBackup });
  let server = await start();
  try {
    const initial = await request(server, "/api/memory/status");
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.status.enabled, false);
    assert.equal(typeof initial.body.status.rollout, "string");
    assert.equal(typeof initial.body.status.health, "string");

    // The real composition must expose the replacement rule commands and must
    // never recreate the retired memory tools in its catalog.
    const config = await request(server, "/api/config");
    assert.equal(config.response.status, 200);
    const tools = config.body.capabilities.toolCatalog.allowedTools;
    assert.ok(tools.includes("CollaborationRulesRead"));
    assert.ok(tools.includes("CollaborationRulesUpdate"));
    for (const retired of ["NoteWrite", "MemorySearch", "MemoryRead", "MemoryReference", "PathDependencySave"]) {
      assert.equal(tools.includes(retired), false);
    }

    const created = await request(server, "/api/spaces", {
      method: "POST",
      body: { title: "Memory API integration" },
    });
    assert.equal(created.response.status, 201);
    const spaceId = created.body.space.id;
    const ownerQuery = `ownerKind=space&ownerId=${encodeURIComponent(spaceId)}`;

    const globalRules = await request(server, "/api/collaboration-rules");
    assert.equal(globalRules.response.status, 200);
    const savedGlobalRules = await request(server, "/api/collaboration-rules", {
      method: "PUT",
      body: {
        scope: { kind: "global" },
        content: "优先给出可执行的结论。",
        expectedVersion: globalRules.body.document.version,
      },
    });
    assert.equal(savedGlobalRules.response.status, 200);
    assert.equal(savedGlobalRules.body.document.content, "优先给出可执行的结论。");

    const scopedRules = await request(
      server,
      `/api/collaboration-rules?scopeKind=space&scopeId=${encodeURIComponent(spaceId)}`,
    );
    const savedScopedRules = await request(server, "/api/collaboration-rules", {
      method: "PUT",
      body: {
        scope: { kind: "space", id: spaceId },
        content: "这个 Space 的修改完成前必须经过验证。",
        expectedVersion: scopedRules.body.document.version,
      },
    });
    assert.equal(savedScopedRules.response.status, 200);
    assert.equal(savedScopedRules.body.document.scope.id, spaceId);

    const backup = await request(server, "/api/data/backups", { method: "POST" });
    assert.equal(backup.response.status, 201);
    const backupMemoryRules = path.join(
      `${backup.body.backup.filePath}.assets`,
      "memory-data",
      "collaboration-rules",
      "spaces",
    );
    assert.equal((await readdir(backupMemoryRules)).length, 1);

    const enabled = await request(server, "/api/memory", {
      method: "POST",
      body: { op: "setEnabled", enabled: true },
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.body.ok, true);

    const scopedStatus = await request(server, `/api/memory/status?${ownerQuery}`);
    assert.equal(scopedStatus.response.status, 200);
    assert.equal(scopedStatus.body.status.enabled, true);

    const emptyView = await request(server, `/api/memory/document?${ownerQuery}`);
    assert.equal(emptyView.response.status, 200);
    assert.equal(emptyView.body.view.document, undefined);
    assert.equal(emptyView.body.view.summaryCount, 0);

    await request(server, "/api/memory", { method: "POST", body: { op: "setRollout", rollout: "active" } });
    await server.close();
    await seedSourceHistory(productHome, { kind: "space", id: spaceId });
    server = await start();
    const owner = { kind: "space", id: spaceId };
    const createBody = { op: "updateMemory", owner, requestId: "test-memory-update-1", edit: {
      operation: "create", entryId: "entry-user", expectedRevisionId: null, kind: "initial", markdown: "用户直接维护的长期记忆。",
      applicability: null, occurredAt: null, reason: null, topicIds: [], related: [], retractsRevisionIds: [],
    } };
    const updated = await request(server, "/api/memory", { method: "POST", body: createBody });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.entryId, "entry-user");
    const repeated = await request(server, "/api/memory", { method: "POST", body: createBody });
    assert.deepEqual(repeated.body, updated.body);
    const conflict = await request(server, "/api/memory", { method: "POST", body: { ...createBody, edit: { ...createBody.edit, markdown: "different" } } });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "memory_request_conflict");
    const changed = await request(server, "/api/memory", { method: "POST", body: { ...createBody, requestId: "change", edit: {
      ...createBody.edit, operation: "revise", expectedRevisionId: updated.body.revisionId, kind: "change", markdown: "后来状态改变。",
    } } });
    assert.equal(changed.response.status, 200);
    const corrected = await request(server, "/api/memory", { method: "POST", body: { ...createBody, requestId: "correction", edit: {
      ...createBody.edit, operation: "revise", expectedRevisionId: changed.body.revisionId, kind: "correction", markdown: "纠正旧理解。", retractsRevisionIds: [updated.body.revisionId],
    } } });
    assert.equal(corrected.response.status, 200);
    const stale = await request(server, "/api/memory", { method: "POST", body: { ...createBody, requestId: "stale", edit: {
      ...createBody.edit, operation: "revise", expectedRevisionId: updated.body.revisionId, kind: "supplement",
    } } });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, "memory_revision_stale");
    const writtenView = await request(server, `/api/memory/document?${ownerQuery}`);
    assert.equal(writtenView.response.status, 200);
    assert.ok(writtenView.body.view.document.markdown.includes("纠正旧理解。"));
    const historyQuery = `/api/memory/document?${ownerQuery}&entryId=entry-user`;
    const history = await request(server, historyQuery);
    assert.deepEqual(history.body.view.entries.map(item => item.revision.kind), ["correction", "change", "initial"]);
    assert.equal(history.body.view.entries[2].supplyState, "revoked");
    const deleted = writtenView.body.view.entries.find(item => item.entry.entryId === "entry-prefix");
    assert.equal(deleted.role, "current");
    assert.equal(deleted.sources[0].readback, "deleted");
    const retired = writtenView.body.view.entries.find(item => item.entry.entryId === "entry-suffix");
    assert.equal(retired.role, "historical");
    assert.equal(retired.currentRevisionId, null);
    assert.equal(retired.sources[0].lifecycle, "deleted");
    assert.equal(retired.sources[0].branch, "superseded");
    const entryBackup = await request(server, "/api/data/backups", { method: "POST" });
    assert.equal(entryBackup.response.status, 201);
    selectedBackup = entryBackup.body.backup.filePath;

    const cleared = await request(server, "/api/memory", {
      method: "POST",
      body: { op: "clearMemory", scope: { kind: "space", id: spaceId } },
    });
    assert.equal(cleared.response.status, 200);
    assert.equal(typeof cleared.body.generation, "number");

    const rulesAfterMemoryClear = await request(
      server,
      `/api/collaboration-rules?scopeKind=space&scopeId=${encodeURIComponent(spaceId)}`,
    );
    assert.equal(rulesAfterMemoryClear.body.document.content, "这个 Space 的修改完成前必须经过验证。");
    const documentAfterClear = await request(server, `/api/memory/document?${ownerQuery}`);
    assert.equal(documentAfterClear.body.view.document, undefined);

    const diagnostics = await request(server, "/api/memory/diagnostics");
    assert.equal(diagnostics.response.status, 200);
    assert.equal(diagnostics.body.diagnostics.jobs.queued, 0);

    const ownerDiagnostics = await request(server, `/api/memory/diagnostics?${ownerQuery}`);
    assert.equal(ownerDiagnostics.response.status, 200);

    const staged = await request(server, "/api/data/restore/select", { method: "POST" });
    assert.equal(staged.response.status, 200);
    assert.equal(staged.body.result.status, "staged");
    assert.equal(staged.body.result.restartRequired, true);
    await server.close();
    server = await start();
    const restored = await request(server, `/api/memory/document?${ownerQuery}`);
    const restoredHistory = await request(server, historyQuery);
    assert.deepEqual(restored.body.view, writtenView.body.view);
    assert.deepEqual(restoredHistory.body.view, history.body.view);
    assert.deepEqual((await request(server, "/api/memory", { method: "POST", body: createBody })).body, updated.body);

    const removed = await request(server, `/api/spaces/${encodeURIComponent(spaceId)}`, { method: "DELETE" });
    assert.equal(removed.response.status, 200);
    assert.deepEqual(
      await readdir(path.join(productHome, "data", "memory", "collaboration-rules", "spaces")),
      [],
    );
  } finally {
    await server.close();
    await rm(productHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test("restore rejects a pre-v3 manifest instead of silently dropping memory-data", async () => {
  const productHome = await mkdtemp(path.join(os.tmpdir(), "synech-memory-restore-format-"));
  let server;
  try {
    server = await startLocalPanelServer({ host: "127.0.0.1", port: 0, productHome });
    const backup = await request(server, "/api/data/backups", { method: "POST" });
    assert.equal(backup.response.status, 201);
    await server.close();
    server = undefined;

    const manifestPath = `${backup.body.backup.filePath}.manifest.json`;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 2 }), "utf8");

    server = await startLocalPanelServer({
      host: "127.0.0.1",
      port: 0,
      productHome,
      restorePicker: async () => backup.body.backup.filePath,
    });
    const restore = await request(server, "/api/data/restore/select", { method: "POST" });
    assert.equal(restore.response.status, 400);
    assert.equal(restore.body.error.code, "restore_source_invalid");
  } finally {
    await server?.close();
    await rm(productHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

async function request(server, pathname, options = {}) {
  const response = await fetch(new URL(pathname, server.url), {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() };
}
// Host is closed before opening its temporary database. Use the real publication and
// lifecycle commands, with bounded evidence fixtures, rather than fabricated SQL rows.
async function seedSourceHistory(productHome, owner) {
  const database = new SqliteRuntimeDatabase(path.join(productHome, "data", "synech.sqlite3"));
  try {
    const control = createSqliteMemoryControlRepository(database);
    const documents = createSqliteMemoryDocumentRepository(database);
    const lifecycle = createControlMemoryLifecycle(control, { documentRepository: documents });
    const ownerKey = `space:${owner.id}`;
    const conversationId = "backup-evidence";
    const admission = resolveAdmissionFromPolicy({ owner, conversationId, policyRows: await control.readAllPolicy(),
      ownerLifecycle: await control.getLifecycle(ownerKey), conversationLifecycle: undefined });
    await documents.indexTranscriptRange({ conversationId, ownerKey, now: 0,
      publication: { policyRevision: admission.policyRevision, generation: admission.generation, conversationGeneration: 0 },
      entries: [1, 2, 3, 4].map(ordinal => ({ ordinal, text: `备份证据轮次 ${ordinal}`, sourceRevision: 4 })),
    });
    const queued = await control.acceptConversationSignal({ conversationId, ownerKey, stableThroughOrdinal: 4,
      sourceFingerprint: "backup-fixture", eligibleAt: 0, now: 0, generation: admission.generation,
      conversationGeneration: 0, policyRevision: admission.policyRevision });
    const claimed = await control.claimJob({ jobId: queued.jobId, claimToken: "backup-claim", now: 1 });
    assert.ok(claimed);
    const sources = [
      { sourceId: "source-prefix", owner, locator: { kind: "conversation_range", conversationId, fromOrdinal: 1,
        toOrdinal: 2, sourceRevision: 4, conversationGeneration: 0 }, lifecycle: "present", branch: "selected", createdAt: 1 },
      { sourceId: "source-suffix", owner, locator: { kind: "conversation_range", conversationId, fromOrdinal: 3,
        toOrdinal: 4, sourceRevision: 4, conversationGeneration: 0 }, lifecycle: "present", branch: "selected", createdAt: 1 },
    ];
    const mutations = sources.map((source, index) => ({ operation: "create", entryId: index === 0 ? "entry-prefix" : "entry-suffix",
      revisionId: index === 0 ? "revision-prefix" : "revision-suffix", expectedRevisionId: null, kind: "initial", retractsRevisionIds: [],
      markdown: index === 0 ? "保留前缀认识" : "已替换分支认识", applicability: null, occurredAt: null,
      reportedAt: "2026-10-03T00:00:00.000Z", reason: null, topicIds: ["topic-backup"], related: [], sourceIds: [source.sourceId] }));
    const result = await documents.commitMaintenanceBatch({ jobId: queued.jobId, claimToken: "backup-claim", conversationId,
      ownerKey, expectedPolicyRevision: admission.policyRevision, expectedGeneration: admission.generation, expectedConversationGeneration: 0,
      expectedSummaryRevisionId: null, expectedMemoryHeadRevisionId: null,
      summary: { markdown: "备份证据摘要", coveredThroughOrdinal: 4 }, batchRange: { fromOrdinal: 1, toOrdinal: 4, sourceRevision: 4 },
      advanceProgressTo: { ordinal: 4, sourceFingerprint: "backup-fixture" },
      readSet: sources.map(source => ({ sourceId: source.sourceId, conversationGeneration: 0 })), entryReadSet: [], sources, mutations,
      topics: [{ topicId: "topic-backup", owner, name: "备份主题", aliases: [] }],
      overview: { markdown: "备份认识概览", entries: mutations.map(item => ({ entryId: item.entryId, revisionId: item.revisionId })) },
    });
    assert.equal(result.status, "committed", JSON.stringify(result));
    await lifecycle.supersedeConversationSources({ conversationId, owner, retainedThroughOrdinal: 2 });
    const ticket = await lifecycle.prepareConversationRemoval(conversationId);
    await lifecycle.finalizeConversationRemoval(ticket);
  } finally { database.close(); }
}
