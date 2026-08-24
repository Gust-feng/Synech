import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/sqlite-runtime-database.js";
import {
  applyPendingRestore,
  createDataMaintenance,
} from "../dist/app/panel-server/storage/data-maintenance.js";
import {
  initializeProductStorage,
  resolveProductPaths,
} from "../dist/platform/storage/index.js";

test("backup, stage, and startup restore preserve the complete owned-data bundle", async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-data-maintenance-"));
  t.after(async () => await fs.rm(temporaryDirectory, { recursive: true, force: true }));

  const sourcePaths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "source") });
  const currentPaths = resolveProductPaths({ productHome: path.join(temporaryDirectory, "current") });
  await initializeProductStorage(sourcePaths);
  await initializeProductStorage(currentPaths);

  const sourceDatabase = createTestDatabase(sourcePaths.data.database, "restored");
  await fs.writeFile(path.join(sourcePaths.data.knowledge.assets, "knowledge.txt"), "restored knowledge", "utf8");
  await fs.writeFile(path.join(sourcePaths.data.spaces.files, "space.txt"), "restored space", "utf8");
  const sourceMaintenance = createDataMaintenance({ database: sourceDatabase, productPaths: sourcePaths });
  const backup = await sourceMaintenance.createBackup();
  sourceDatabase.close();

  assert.equal((await fs.stat(backup.filePath)).isFile(), true);
  assert.equal((await fs.stat(`${backup.filePath}.manifest.json`)).isFile(), true);
  assert.equal((await fs.stat(`${backup.filePath}.assets/knowledge-assets`)).isDirectory(), true);
  assert.equal((await fs.stat(`${backup.filePath}.assets/space-files`)).isDirectory(), true);

  const currentDatabase = createTestDatabase(currentPaths.data.database, "current");
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
  t.after(async () => await fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const paths = resolveProductPaths({ productHome: temporaryDirectory });
  await initializeProductStorage(paths);
  const database = createTestDatabase(paths.data.database, "current");
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

function createTestDatabase(filePath, value) {
  const database = new SqliteRuntimeDatabase(filePath);
  database.connection.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE personal_notes (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE restore_probe (value TEXT NOT NULL) STRICT;
  `);
  database.connection.prepare("INSERT INTO restore_probe(value) VALUES (?)").run(value);
  return database;
}

function readProbe(database) {
  return database.connection.prepare("SELECT value FROM restore_probe LIMIT 1").get().value;
}

async function pathExists(filePath) {
  return await fs.stat(filePath).then(() => true, () => false);
}
