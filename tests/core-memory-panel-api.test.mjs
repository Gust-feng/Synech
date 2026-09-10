import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalPanelServer } from "../dist/app/panel-server/request-handler.js";

test("panel host exposes scoped memory controls through the production HTTP boundary", async () => {
  const productHome = await mkdtemp(path.join(os.tmpdir(), "synech-memory-panel-api-"));
  const server = await startLocalPanelServer({ host: "127.0.0.1", port: 0, productHome });
  try {
    const initial = await request(server, "/api/memory/capability");
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.status.globalConsent, false);
    assert.equal(initial.body.status.rollout, "active");

    const created = await request(server, "/api/spaces", {
      method: "POST",
      body: { title: "Memory API integration" },
    });
    assert.equal(created.response.status, 201);
    const spaceId = created.body.space.id;

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

    const createdDependency = await request(server, "/api/memory/path-dependencies", {
      method: "POST",
      body: {
        scope: "owner",
        ownerKind: "space",
        ownerId: spaceId,
        title: "发布前检查",
        methodology: "修改完成后先运行定向验证，再检查差异。",
        tags: ["release", "verification"],
      },
    });
    assert.equal(createdDependency.response.status, 201);
    const dependency = createdDependency.body.result.dependency;

    const updatedDependency = await request(
      server,
      `/api/memory/path-dependencies/${encodeURIComponent(dependency.id)}`,
      {
        method: "PATCH",
        body: {
          scope: "owner",
          ownerKind: "space",
          ownerId: spaceId,
          expectedRevision: dependency.revision,
          title: "发布前验证",
          methodology: "修改完成后运行定向验证、构建和差异检查。",
          tags: ["release"],
        },
      },
    );
    assert.equal(updatedDependency.response.status, 200);

    const backup = await request(server, "/api/data/backups", { method: "POST" });
    assert.equal(backup.response.status, 201);
    const backupMemoryRules = path.join(
      `${backup.body.backup.filePath}.assets`,
      "memory-data",
      "collaboration-rules",
      "spaces",
    );
    assert.equal((await readdir(backupMemoryRules)).length, 1);

    const consent = await request(server, "/api/memory", {
      method: "POST",
      body: { op: "setConsent", globalConsent: true },
    });
    assert.equal(consent.response.status, 200);
    assert.equal(consent.body.ok, true);

    const participation = await request(server, "/api/memory", {
      method: "POST",
      body: { op: "setSpaceParticipation", spaceId, enabled: true },
    });
    assert.equal(participation.response.status, 200);
    assert.equal(participation.body.ok, true);

    const scoped = await request(
      server,
      `/api/memory/capability?ownerKind=space&ownerId=${encodeURIComponent(spaceId)}`,
    );
    assert.equal(scoped.response.status, 200);
    assert.equal(scoped.body.status.spaceParticipation, true);
    assert.equal(scoped.body.status.effective, "active");

    const rejectedConversationScope = await request(server, "/api/memory", {
      method: "POST",
      body: { op: "setConversationParticipation", conversationId: "not-supported", excluded: true },
    });
    assert.equal(rejectedConversationScope.response.status, 400);

    const shadow = await request(server, "/api/memory", {
      method: "POST",
      body: { op: "setRollout", rollout: "shadow" },
    });
    assert.equal(shadow.response.status, 200);
    const shadowStatus = await request(
      server,
      `/api/memory/capability?ownerKind=space&ownerId=${encodeURIComponent(spaceId)}`,
    );
    assert.equal(shadowStatus.body.status.rollout, "shadow");
    assert.equal(shadowStatus.body.status.effective, "shadow");

    const active = await request(server, "/api/memory", {
      method: "POST",
      body: { op: "setRollout", rollout: "active" },
    });
    assert.equal(active.response.status, 200);

    const cleared = await request(server, "/api/memory", {
      method: "POST",
      body: { op: "clearImplicitMemory", scope: { kind: "space", id: spaceId } },
    });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.body.generation, 1);

    const rulesAfterMemoryClear = await request(
      server,
      `/api/collaboration-rules?scopeKind=space&scopeId=${encodeURIComponent(spaceId)}`,
    );
    assert.equal(rulesAfterMemoryClear.body.document.content, "这个 Space 的修改完成前必须经过验证。");
    const dependenciesAfterMemoryClear = await request(
      server,
      `/api/memory/path-dependencies?ownerKind=space&ownerId=${encodeURIComponent(spaceId)}`,
    );
    assert.equal(dependenciesAfterMemoryClear.body.pathDependencies.length, 1);
    assert.equal(dependenciesAfterMemoryClear.body.pathDependencies[0].title, "发布前验证");

    const diagnostics = await request(server, "/api/memory/diagnostics");
    assert.equal(diagnostics.response.status, 200);
    assert.equal(diagnostics.body.diagnostics.jobs.queued, 0);

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
