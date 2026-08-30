import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/sqlite-runtime-database.js";
import {
  applyPendingRestore,
  createDataMaintenance,
} from "../dist/app/panel-server/storage/data-maintenance.js";
import { startLocalPanelServer } from "../dist/app/panel-server/request-handler.js";
import {
  initializeProductStorage,
  resolveProductPaths,
} from "../dist/platform/storage/index.js";

test("backup, stage, and startup restore preserve the complete owned-data bundle", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-data-maintenance-"));
  t.after(async () => await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const sourcePaths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "source") });
  const currentPaths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "current") });
  await initializeProductStorage(sourcePaths);
  await initializeProductStorage(currentPaths);

  const sourceDatabase = await createTestDatabase(sourcePaths, "restored");
  await fs.writeFile(path.join(sourcePaths.data.knowledge.assets, "knowledge.txt"), "restored knowledge", "utf8");
  await fs.writeFile(path.join(sourcePaths.data.spaces.files, "space.txt"), "restored space", "utf8");
  const sourceMaintenance = createDataMaintenance({ database: sourceDatabase, productPaths: sourcePaths });
  const backup = await sourceMaintenance.createBackup();
  sourceDatabase.close();

  assert.equal((await fs.stat(backup.filePath)).isFile(), true);
  assert.equal((await fs.stat(`${backup.filePath}.manifest.json`)).isFile(), true);
  assert.equal((await fs.stat(`${backup.filePath}.assets/knowledge-assets`)).isDirectory(), true);
  assert.equal((await fs.stat(`${backup.filePath}.assets/space-files`)).isDirectory(), true);

  const currentDatabase = await createTestDatabase(currentPaths, "current");
  await fs.writeFile(path.join(currentPaths.data.knowledge.assets, "knowledge.txt"), "current knowledge", "utf8");
  await fs.writeFile(path.join(currentPaths.data.spaces.files, "space.txt"), "current space", "utf8");
  let stoppedWrites = 0;
  const currentMaintenance = createDataMaintenance({
    database: currentDatabase,
    productPaths: currentPaths,
    restorePicker: async () => backup.filePath,
    beforeRestoreStage: async () => { stoppedWrites += 1; },
  });

  const staged = await currentMaintenance.selectAndStageRestore();
  assert.equal(staged.status, "staged");
  assert.equal(stoppedWrites, 1);
  assert.equal(readProbe(currentDatabase), "current");
  assert.equal(await fs.readFile(path.join(currentPaths.data.knowledge.assets, "knowledge.txt"), "utf8"), "current knowledge");
  assert.equal(await fs.readFile(path.join(currentPaths.data.spaces.files, "space.txt"), "utf8"), "current space");
  assert.equal(currentMaintenance.health().pendingRestore, true);
  assert.equal((await fs.stat(staged.safetyBackupPath)).isFile(), true);

  currentDatabase.close();
  let deletionIdleChecks = 0;
  applyPendingRestore(currentPaths, {
    assertSpaceDeletionIdle: () => { deletionIdleChecks += 1; },
  });
  assert.equal(deletionIdleChecks, 1);

  const restoredDatabase = new SqliteRuntimeDatabase(currentPaths.data.database);
  assert.equal(readProbe(restoredDatabase), "restored");
  restoredDatabase.close();
  assert.equal(await fs.readFile(path.join(currentPaths.data.knowledge.assets, "knowledge.txt"), "utf8"), "restored knowledge");
  assert.equal(await fs.readFile(path.join(currentPaths.data.spaces.files, "space.txt"), "utf8"), "restored space");
  assert.equal(await pathExists(path.join(currentPaths.state.restoreMarkers, "pending-restore")), false);
  assert.equal(await pathExists(path.join(currentPaths.state.restoreMarkers, "restore-rollback")), false);
});

test("invalid backup is rejected before stopping writes or changing current data", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-invalid-restore-"));
  t.after(async () => await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const paths = resolveProductPaths({ productHome: temporaryDirectory });
  await initializeProductStorage(paths);
  const database = await createTestDatabase(paths, "current");
  const invalidBackup = path.join(temporaryDirectory, "invalid.sqlite3");
  await fs.writeFile(invalidBackup, "not sqlite", "utf8");
  let stoppedWrites = 0;
  const maintenance = createDataMaintenance({
    database,
    productPaths: paths,
    restorePicker: async () => invalidBackup,
    beforeRestoreStage: async () => { stoppedWrites += 1; },
  });

  await assert.rejects(
    maintenance.selectAndStageRestore(),
    (error) => error?.code === "restore_source_invalid",
  );
  assert.equal(stoppedWrites, 0);
  assert.equal(readProbe(database), "current");
  assert.equal(maintenance.health().pendingRestore, false);
  database.close();
});

test("restore rejects a backup whose schema no longer matches the v1 baseline", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-schema-restore-"));
  t.after(async () => await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const sourcePaths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "source") });
  const currentPaths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "current") });
  await Promise.all([initializeProductStorage(sourcePaths), initializeProductStorage(currentPaths)]);
  const sourceDatabase = await createTestDatabase(sourcePaths, "source");
  const backup = await createDataMaintenance({ database: sourceDatabase, productPaths: sourcePaths }).createBackup();
  sourceDatabase.close();
  const corrupted = new DatabaseSync(backup.filePath);
  corrupted.exec("DROP TABLE knowledge_links");
  corrupted.close();

  const currentDatabase = await createTestDatabase(currentPaths, "current");
  let stoppedWrites = 0;
  const maintenance = createDataMaintenance({
    database: currentDatabase,
    productPaths: currentPaths,
    restorePicker: async () => backup.filePath,
    beforeRestoreStage: async () => { stoppedWrites += 1; },
  });
  await assert.rejects(
    maintenance.selectAndStageRestore(),
    (error) => error?.code === "restore_source_invalid",
  );
  assert.equal(stoppedWrites, 0);
  assert.equal(readProbe(currentDatabase), "current");
  currentDatabase.close();
});

async function createTestDatabase(paths, value) {
  const server = await startLocalPanelServer({ productHome: paths.productHome, port: 0 });
  await server.close();
  const database = new SqliteRuntimeDatabase(paths.data.database);
  database.connection.prepare(
    "INSERT INTO runtime_initializations(initialization_key, initialized_at) VALUES (?, ?)",
  ).run(`restore-probe:${value}`, new Date().toISOString());
  return database;
}

function readProbe(database) {
  const key = database.connection.prepare(
    "SELECT initialization_key AS initializationKey FROM runtime_initializations WHERE initialization_key LIKE 'restore-probe:%' LIMIT 1",
  ).get().initializationKey;
  return key.slice("restore-probe:".length);
}

async function pathExists(filePath) {
  return await fs.stat(filePath).then(() => true, () => false);
}
