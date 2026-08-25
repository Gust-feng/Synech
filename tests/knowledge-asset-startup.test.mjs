import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalPanelServer } from "../dist/app/panel-server/index.js";
import {
  observeKnowledgeAssetReadiness,
  reconcileKnowledgeAssets,
} from "../dist/app/panel-server/storage/knowledge-asset-store.js";
import { resolveProductPaths } from "../dist/platform/storage/index.js";

test("Knowledge readiness is observed immediately without changing consumer failure semantics", async () => {
  const failure = new Error("reconciliation failed");
  let observed;
  const readiness = Promise.reject(failure);

  const returned = observeKnowledgeAssetReadiness(readiness, (error) => {
    observed = error;
  });

  assert.equal(returned, readiness);
  await assert.rejects(returned, (error) => error === failure);
  assert.equal(observed, failure);
});

test("Knowledge asset reconciliation converges pending, deleting, and orphan directories", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synech-knowledge-reconcile-"));
  t.after(async () => await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const restoredId = "asset-restored";
  const existingId = "asset-existing";
  const restoredDirectory = encodedAssetDirectory(restoredId);
  const existingDirectory = encodedAssetDirectory(existingId);
  await Promise.all([
    fs.mkdir(path.join(root, `${restoredDirectory}.deleting-interrupted`, "content"), { recursive: true }),
    fs.mkdir(path.join(root, existingDirectory, "content"), { recursive: true }),
    fs.mkdir(path.join(root, `${existingDirectory}.deleting-duplicate`, "content"), { recursive: true }),
    fs.mkdir(path.join(root, "inactive.deleting-stale", "content"), { recursive: true }),
    fs.mkdir(path.join(root, "capture.pending-interrupted", "content"), { recursive: true }),
    fs.mkdir(path.join(root, "orphan", "content"), { recursive: true }),
  ]);

  await reconcileKnowledgeAssets(root, new Set([restoredId, existingId]));

  assert.equal(await pathExists(path.join(root, restoredDirectory, "content")), true);
  assert.equal(await pathExists(path.join(root, `${restoredDirectory}.deleting-interrupted`)), false);
  assert.equal(await pathExists(path.join(root, existingDirectory, "content")), true);
  assert.equal(await pathExists(path.join(root, `${existingDirectory}.deleting-duplicate`)), false);
  assert.equal(await pathExists(path.join(root, "inactive.deleting-stale")), false);
  assert.equal(await pathExists(path.join(root, "capture.pending-interrupted")), false);
  assert.equal(await pathExists(path.join(root, "orphan")), false);
});

test("Knowledge reconciliation retries transient rename failures and configures rm retries", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synech-knowledge-retry-"));
  t.after(async () => await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const activeId = "asset-retry";
  const activeDirectory = encodedAssetDirectory(activeId);
  const stagedDirectory = path.join(root, `${activeDirectory}.deleting-interrupted`);
  const pendingDirectory = path.join(root, "capture.pending-interrupted");
  await Promise.all([
    fs.mkdir(path.join(stagedDirectory, "content"), { recursive: true }),
    fs.mkdir(path.join(pendingDirectory, "content"), { recursive: true }),
  ]);

  const originalRename = fs.rename;
  const originalRm = fs.rm;
  let renameAttempts = 0;
  let pendingRmOptions;
  fs.rename = async (source, target) => {
    if (path.resolve(String(source)) === path.resolve(stagedDirectory)) {
      renameAttempts += 1;
      if (renameAttempts < 3) throw Object.assign(new Error("temporarily busy"), { code: "EBUSY" });
    }
    return await originalRename(source, target);
  };
  fs.rm = async (target, options) => {
    if (path.resolve(String(target)) === path.resolve(pendingDirectory)) pendingRmOptions = options;
    return await originalRm(target, options);
  };
  try {
    await reconcileKnowledgeAssets(root, new Set([activeId]));
  } finally {
    fs.rename = originalRename;
    fs.rm = originalRm;
  }

  assert.equal(renameAttempts, 3);
  assert.deepEqual(pendingRmOptions, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25,
  });
  assert.equal(await pathExists(path.join(root, activeDirectory, "content")), true);
});

test("A failed Knowledge reconciliation does not prevent ordinary Panel and Space APIs from starting", async () => {
  const productHome = await fs.mkdtemp(path.join(os.tmpdir(), "synech-knowledge-isolation-"));
  const paths = resolveProductPaths({ productHome });
  const blockedPendingDirectory = path.join(paths.data.knowledge.assets, "capture.pending-locked");
  await fs.mkdir(path.join(blockedPendingDirectory, "content"), { recursive: true });

  const originalRm = fs.rm;
  const originalConsoleError = console.error;
  const unhandled = [];
  const diagnostics = [];
  let server;
  fs.rm = async (target, options) => {
    if (path.resolve(String(target)) === path.resolve(blockedPendingDirectory)) {
      throw Object.assign(new Error("locked by another process"), { code: "EBUSY" });
    }
    return await originalRm(target, options);
  };
  console.error = (...values) => {
    diagnostics.push(values);
  };
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    server = await startLocalPanelServer({ productHome, port: 0 });
    await new Promise((resolve) => setImmediate(resolve));

    const [health, usage, spaces, managedKnowledge, backup] = await Promise.all([
      fetch(new URL("health", server.url)),
      fetch(new URL("api/runtime/usage-statistics", server.url)),
      fetch(new URL("api/spaces", server.url)),
      fetch(new URL("api/personal-knowledge/assets/missing/preview", server.url)),
      fetch(new URL("api/data/backups", server.url), { method: "POST" }),
    ]);

    assert.equal(health.status, 200);
    assert.equal(usage.status, 200);
    assert.equal(spaces.status, 200);
    assert.equal(managedKnowledge.status, 500);
    assert.equal(backup.status, 500);
    assert.deepEqual(unhandled, []);
    assert.equal(diagnostics.some((values) => String(values[0]).includes("Knowledge asset reconciliation failed")), true);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    if (server !== undefined) await server.close();
    fs.rm = originalRm;
    console.error = originalConsoleError;
    await originalRm(productHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function encodedAssetDirectory(assetId) {
  return Buffer.from(assetId, "utf8").toString("base64url");
}

async function pathExists(target) {
  return await fs.lstat(target).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}
