import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  checkSqliteDatabaseFile,
  type SqliteRuntimeDatabase,
} from "../../adapters/runtime-storage/index.js";
import type { ProductPaths } from "../../platform/storage/index.js";
import { PRODUCT_DATA_FORMAT_ID, PRODUCT_NAMESPACE } from "../../platform/product-identity.js";

const PENDING_RESTORE_FILE_NAME = "synech.restore-pending.sqlite3";
const PENDING_RESTORE_ASSETS_NAME = "synech.restore-pending.assets";
const RESTORE_JOURNAL_FILE_NAME = "synech.restore-journal.json";
const RESTORE_COMMIT_FILE_NAME = "synech.restore-commit.json";
const RESTORE_METADATA_VERSION = 1;
const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const OWNED_STORAGE_NAMES = ["knowledge-assets", "space-files"] as const;

type DatabaseFileSuffix = typeof DATABASE_FILE_SUFFIXES[number];
type OwnedStorageName = typeof OWNED_STORAGE_NAMES[number];

type SynechRestoreJournal = {
  readonly version: typeof RESTORE_METADATA_VERSION;
  readonly namespace: typeof PRODUCT_NAMESPACE;
  readonly dataFormatId: typeof PRODUCT_DATA_FORMAT_ID;
  readonly restoreId: string;
  readonly backupStem: string;
  readonly originalDatabaseSuffixes: readonly DatabaseFileSuffix[];
  readonly originalStorageNames: readonly OwnedStorageName[];
};

type SynechRestoreCommit = {
  readonly version: typeof RESTORE_METADATA_VERSION;
  readonly namespace: typeof PRODUCT_NAMESPACE;
  readonly dataFormatId: typeof PRODUCT_DATA_FORMAT_ID;
  readonly restoreId: string;
};

export type SynechDataMaintenance = {
  health(): {
    readonly ok: boolean;
    readonly checks: readonly string[];
    readonly migrations: readonly { readonly owner: string; readonly version: number; readonly appliedAt: string }[];
    readonly pendingRestore: boolean;
  };
  createBackup(): Promise<{ readonly filePath: string; readonly byteLength: number; readonly createdAt: string }>;
  selectAndStageRestore(): Promise<
    | { readonly status: "cancelled" }
    | { readonly status: "staged"; readonly sourcePath: string; readonly safetyBackupPath: string; readonly restartRequired: true }
  >;
};

export class SynechDataMaintenanceError extends Error {
  readonly name = "SynechDataMaintenanceError";

  constructor(
    readonly code: "restore_picker_unavailable" | "restore_source_invalid" | "data_maintenance_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type WorkbenchBackupDatabase = Pick<SqliteRuntimeDatabase, "filePath" | "health" | "backupTo">;

export function createSynechDataMaintenance(input: {
  readonly database: WorkbenchBackupDatabase;
  readonly productPaths: ProductPaths;
  readonly restorePicker?: () => Promise<string | undefined>;
  readonly beforeRestoreStage?: () => Promise<void>;
  readonly runOwnedStorageSnapshot?: <T>(operation: () => Promise<T>) => Promise<T>;
}): SynechDataMaintenance {
  const pendingRestorePath = path.join(input.productPaths.state.restoreMarkers, PENDING_RESTORE_FILE_NAME);
  const pendingRestoreAssetsPath = path.join(input.productPaths.state.restoreMarkers, PENDING_RESTORE_ASSETS_NAME);
  let queue = Promise.resolve();
  let restoreState: "running" | "quiescing" | "staged" | "failed_requires_restart" = "running";
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return await result;
  };
  const createBackup = async () => {
    const createdAt = new Date().toISOString();
    const filePath = path.join(
      input.productPaths.backups,
      `synech-${fileTimestamp(createdAt)}-${randomUUID().slice(0, 8)}.sqlite3`,
    );
    const temporarySuffix = `.pending-${randomUUID()}`;
    const temporaryFilePath = `${filePath}${temporarySuffix}`;
    const assetsPath = backupAssetsPath(filePath);
    const temporaryAssetsPath = `${assetsPath}${temporarySuffix}`;
    const manifestPath = backupManifestPath(filePath);
    const temporaryManifestPath = `${manifestPath}${temporarySuffix}`;
    try {
      const databaseBackup = await input.database.backupTo(temporaryFilePath);
      await mkdir(temporaryAssetsPath, { recursive: true });
      for (const storageName of OWNED_STORAGE_NAMES) {
        const source = storagePath(input.productPaths, storageName);
        const destination = path.join(temporaryAssetsPath, storageName);
        if (existsSync(source)) await cp(source, destination, { recursive: true });
        else await mkdir(destination, { recursive: true });
      }
      await writeFile(temporaryManifestPath, JSON.stringify({
        version: 1,
        namespace: PRODUCT_NAMESPACE,
        dataFormatId: PRODUCT_DATA_FORMAT_ID,
        database: path.basename(filePath),
        assets: path.basename(assetsPath),
        roots: OWNED_STORAGE_NAMES,
        createdAt,
      }), "utf8");
      await rename(temporaryFilePath, filePath);
      await rename(temporaryAssetsPath, assetsPath);
      await rename(temporaryManifestPath, manifestPath);
      return { filePath, byteLength: databaseBackup.byteLength, createdAt };
    } catch (error) {
      await Promise.allSettled([
        rm(temporaryFilePath, { force: true }),
        rm(temporaryAssetsPath, { recursive: true, force: true }),
        rm(temporaryManifestPath, { force: true }),
        rm(filePath, { force: true }),
        rm(assetsPath, { recursive: true, force: true }),
        rm(manifestPath, { force: true }),
      ]);
      throw new SynechDataMaintenanceError("data_maintenance_failed", "应用数据备份失败。", { cause: error });
    }
  };
  const createOwnedStorageSnapshot = async () => {
    try {
      return input.runOwnedStorageSnapshot === undefined
        ? await createBackup()
        : await input.runOwnedStorageSnapshot(createBackup);
    } catch (error) {
      if (error instanceof SynechDataMaintenanceError) throw error;
      throw new SynechDataMaintenanceError(
        "data_maintenance_failed",
        "应用数据快照前无法收口当前持久化状态。",
        { cause: error },
      );
    }
  };
  return {
    health() {
      return { ...input.database.health(), pendingRestore: existsSync(pendingRestorePath) };
    },
    createBackup() {
      return run(async () => {
        assertRestoreAdmission(restoreState);
        return await createOwnedStorageSnapshot();
      });
    },
    selectAndStageRestore() {
      return run(async () => {
        assertRestoreAdmission(restoreState);
        if (input.restorePicker === undefined) {
          throw new SynechDataMaintenanceError("restore_picker_unavailable", "当前运行方式不支持选择 应用数据备份。");
        }
        const selectedPath = await input.restorePicker();
        if (selectedPath === undefined) return { status: "cancelled" };
        if (path.resolve(selectedPath) === path.resolve(input.database.filePath)) {
          throw new SynechDataMaintenanceError("restore_source_invalid", "不能把当前正在使用的数据库作为恢复来源。");
        }
        await validateBackupCompanions(selectedPath);
        let selectedHealth: ReturnType<typeof checkSqliteDatabaseFile>;
        try {
          selectedHealth = checkSqliteDatabaseFile(selectedPath);
        } catch (error) {
          throw new SynechDataMaintenanceError("restore_source_invalid", "所选文件不是可读取的 SQLite 数据库。", { cause: error });
        }
        if (!selectedHealth.ok) {
          throw new SynechDataMaintenanceError("restore_source_invalid", `所选数据库未通过完整性检查：${selectedHealth.checks.join("；")}`);
        }
  if (!isSynechDatabase(selectedHealth)) {
          throw new SynechDataMaintenanceError("restore_source_invalid", "所选数据库不包含 Synech 的 Space 与 Personal Knowledge 数据表。");
        }
        restoreState = "quiescing";
        try {
          await input.beforeRestoreStage?.();
        } catch (error) {
          restoreState = "failed_requires_restart";
          throw new SynechDataMaintenanceError(
            "data_maintenance_failed",
            "应用恢复暂存前无法收口当前运行数据；当前 Panel 已停止接受新工作，请重启后重试。",
            { cause: error },
          );
        }
        let safetyBackup: Awaited<ReturnType<typeof createOwnedStorageSnapshot>>;
        try {
          safetyBackup = await createOwnedStorageSnapshot();
        } catch (error) {
          restoreState = "failed_requires_restart";
          throw new SynechDataMaintenanceError(
            "data_maintenance_failed",
            "应用恢复暂存前的安全备份失败；当前 Panel 已停止接受新工作，请重启后重试。",
            { cause: error },
          );
        }
        const stagingPath = `${pendingRestorePath}.tmp`;
        const stagingAssetsPath = `${pendingRestoreAssetsPath}.tmp`;
        let pendingDatabasePublished = false;
        try {
          await rm(stagingPath, { force: true });
          await rm(stagingAssetsPath, { recursive: true, force: true });
          await copyFile(selectedPath, stagingPath);
          await cp(backupAssetsPath(selectedPath), stagingAssetsPath, { recursive: true });
          const stagedHealth = checkSqliteDatabaseFile(stagingPath);
          if (!stagedHealth.ok) throw new Error(stagedHealth.checks.join("; "));
          await rm(pendingRestorePath, { force: true });
          await rm(pendingRestoreAssetsPath, { recursive: true, force: true });
          // The pending database is the commit marker. Publish the complete
          // owned-storage tree first so observing the database always implies
          // that the whole restore bundle is available.
          await rename(stagingAssetsPath, pendingRestoreAssetsPath);
          fsyncDirectory(input.productPaths.state.restoreMarkers);
          await rename(stagingPath, pendingRestorePath);
          pendingDatabasePublished = true;
          fsyncDirectory(input.productPaths.state.restoreMarkers);
        } catch (error) {
          await rm(stagingPath, { force: true }).catch(() => undefined);
          await rm(stagingAssetsPath, { recursive: true, force: true }).catch(() => undefined);
          if (!pendingDatabasePublished) {
            await rm(pendingRestoreAssetsPath, { recursive: true, force: true }).catch(() => undefined);
          }
          restoreState = "failed_requires_restart";
          throw new SynechDataMaintenanceError("data_maintenance_failed", "应用恢复文件暂存失败。", { cause: error });
        }
        restoreState = "staged";
        return {
          status: "staged",
          sourcePath: selectedPath,
          safetyBackupPath: safetyBackup.filePath,
          restartRequired: true,
        };
      });
    },
  };
}

/** Applies a validated pending restore before any feature opens the shared database. */
export function applyPendingSynechRestore(
  runtimePaths: ProductPaths,
  input: { readonly assertSpaceDeletionIdle: () => void },
): void {
  if (hasSynechRestoreState(runtimePaths)) {
    try {
      input.assertSpaceDeletionIdle();
    } catch (error) {
      throw new SynechDataMaintenanceError(
        "data_maintenance_failed",
        "仍有 Space 文件删除等待恢复，应用恢复未修改当前数据。",
        { cause: error },
      );
    }
  }
  try {
    recoverInterruptedSynechRestore(runtimePaths);
  } catch (error) {
    if (error instanceof SynechDataMaintenanceError) throw error;
    throw new SynechDataMaintenanceError(
      "data_maintenance_failed",
      "应用恢复中断状态无法收口，当前数据库尚未打开。",
      { cause: error },
    );
  }

  const pendingPath = pendingRestorePath(runtimePaths);
  if (!existsSync(pendingPath)) return;
  validatePendingSynechRestore(runtimePaths);
  const journal = createRestoreJournal(runtimePaths);
  try {
    writeRestoreJournal(runtimePaths, journal);
  } catch (error) {
    throw new SynechDataMaintenanceError("data_maintenance_failed", "应用恢复日志写入失败，原数据库未变更。", { cause: error });
  }

  try {
    installPendingSynechRestore(runtimePaths, journal);
    writeRestoreCommit(runtimePaths, journal.restoreId);
    finalizeCommittedSynechRestore(runtimePaths);
  } catch (error) {
    if (restoreCommitMatches(runtimePaths, journal.restoreId)) {
      try {
        finalizeCommittedSynechRestore(runtimePaths);
        return;
      } catch (finalizeError) {
        throw new SynechDataMaintenanceError(
          "data_maintenance_failed",
          "应用恢复数据已完整安装，但收尾失败；下次启动将继续收口。",
          { cause: new AggregateError([error, finalizeError]) },
        );
      }
    }
    try {
      rollbackPreparedSynechRestore(runtimePaths, journal);
    } catch (rollbackError) {
      throw new SynechDataMaintenanceError(
        "data_maintenance_failed",
        "应用数据恢复失败且回滚未完成；恢复日志已保留供下次启动继续收口。",
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw new SynechDataMaintenanceError("data_maintenance_failed", "应用数据库恢复失败，原数据库已保留。", { cause: error });
  }
}

export function hasUnappliedPendingSynechRestore(runtimePaths: ProductPaths): boolean {
  return existsSync(pendingRestorePath(runtimePaths)) &&
    !existsSync(restoreJournalPath(runtimePaths)) &&
    !existsSync(restoreCommitPath(runtimePaths));
}

function hasSynechRestoreState(runtimePaths: ProductPaths): boolean {
  return [
    pendingRestorePath(runtimePaths),
    restoreJournalPath(runtimePaths),
    restoreCommitPath(runtimePaths),
  ].some((filePath) => existsSync(filePath));
}

function recoverInterruptedSynechRestore(runtimePaths: ProductPaths): void {
  const journalPath = restoreJournalPath(runtimePaths);
  const commitPath = restoreCommitPath(runtimePaths);
  rmSync(`${journalPath}.tmp`, { force: true });
  rmSync(`${commitPath}.tmp`, { force: true });
  if (!existsSync(journalPath)) {
    if (existsSync(commitPath)) {
      readRestoreCommit(runtimePaths);
      assertInstalledSynechRestore(runtimePaths);
      rmSync(commitPath, { force: true });
      fsyncDirectory(runtimePaths.state.restoreMarkers);
    }
    return;
  }
  const journal = readRestoreJournal(runtimePaths);
  if (existsSync(commitPath)) {
    const commit = readRestoreCommit(runtimePaths);
    if (commit.restoreId !== journal.restoreId) throw new Error("Synech restore commit does not match restore journal.");
    finalizeCommittedSynechRestore(runtimePaths);
    return;
  }
  rollbackPreparedSynechRestore(runtimePaths, journal);
  rmSync(journalPath, { force: true });
  rmSync(commitPath, { force: true });
  fsyncDirectory(runtimePaths.state.restoreMarkers);
}

function validatePendingSynechRestore(runtimePaths: ProductPaths): void {
  const pendingPath = pendingRestorePath(runtimePaths);
  const pendingAssetsPath = pendingRestoreAssetsPath(runtimePaths);
  if (!existsSync(pendingAssetsPath)) throw new SynechDataMaintenanceError("restore_source_invalid", "待恢复备份缺少知识资产目录。");
  for (const storageName of OWNED_STORAGE_NAMES) {
    const storagePath = path.join(pendingAssetsPath, storageName);
    if (!existsSync(storagePath) || !statSync(storagePath).isDirectory()) {
      throw new SynechDataMaintenanceError("restore_source_invalid", "待恢复备份缺少完整的软件自管文件目录。");
    }
  }
  const health = checkSqliteDatabaseFile(pendingPath);
  if (!health.ok) {
    throw new SynechDataMaintenanceError("restore_source_invalid", `待恢复数据库未通过完整性检查：${health.checks.join("；")}`);
  }
  if (!isSynechDatabase(health)) {
    throw new SynechDataMaintenanceError("restore_source_invalid", "待恢复数据库不包含 应用数据表。");
  }
}

function createRestoreJournal(runtimePaths: ProductPaths): SynechRestoreJournal {
  const restoreId = randomUUID();
  if (!existsSync(databaseFilePath(runtimePaths, ""))) {
    throw new SynechDataMaintenanceError("data_maintenance_failed", "当前 应用数据库不存在，无法安全建立恢复日志。");
  }
  const backupStem = path.join(runtimePaths.backups, `replaced-${fileTimestamp(new Date().toISOString())}-${restoreId.slice(0, 8)}`);
  return {
    version: RESTORE_METADATA_VERSION,
    namespace: PRODUCT_NAMESPACE,
    dataFormatId: PRODUCT_DATA_FORMAT_ID,
    restoreId,
    backupStem,
    originalDatabaseSuffixes: DATABASE_FILE_SUFFIXES.filter((suffix) => existsSync(databaseFilePath(runtimePaths, suffix))),
    originalStorageNames: OWNED_STORAGE_NAMES.filter((storageName) => existsSync(storagePath(runtimePaths, storageName))),
  };
}

function installPendingSynechRestore(runtimePaths: ProductPaths, journal: SynechRestoreJournal): void {
  const backupRoot = path.dirname(journal.backupStem);
  mkdirSync(backupRoot, { recursive: true });
  fsyncDirectory(runtimePaths.state.restoreMarkers);
  for (const suffix of journal.originalDatabaseSuffixes) {
    moveCurrentToBackup(databaseFilePath(runtimePaths, suffix), databaseBackupPath(journal, suffix));
  }
  for (const storageName of journal.originalStorageNames) {
    moveCurrentToBackup(storagePath(runtimePaths, storageName), storageBackupPath(journal, storageName));
  }
  fsyncDirectory(runtimePaths.state.restoreMarkers);
  fsyncDirectory(backupRoot);
  movePendingToCurrent(pendingRestorePath(runtimePaths), databaseFilePath(runtimePaths, ""));
  for (const storageName of OWNED_STORAGE_NAMES) {
    movePendingToCurrent(pendingStoragePath(runtimePaths, storageName), storagePath(runtimePaths, storageName));
  }
  fsyncDirectory(pendingRestoreAssetsPath(runtimePaths));
  fsyncDirectory(runtimePaths.state.restoreMarkers);
}

function moveCurrentToBackup(current: string, backup: string): void {
  if (existsSync(backup)) throw new Error(`Cannot prepare Synech restore over an existing backup: ${backup}`);
  if (!existsSync(current)) throw new Error(`Cannot prepare Synech restore backup; current path missing: ${current}`);
  renameSync(current, backup);
}

function movePendingToCurrent(pending: string, current: string): void {
  if (!existsSync(pending)) throw new Error(`Cannot install Synech restore item; pending path missing: ${pending}`);
  if (existsSync(current)) throw new Error(`Cannot install Synech restore item over existing path: ${current}`);
  renameSync(pending, current);
}

function rollbackPreparedSynechRestore(runtimePaths: ProductPaths, journal: SynechRestoreJournal): void {
  mkdirSync(pendingRestoreAssetsPath(runtimePaths), { recursive: true });
  for (const storageName of [...OWNED_STORAGE_NAMES].reverse()) {
    const current = storagePath(runtimePaths, storageName);
    const pending = pendingStoragePath(runtimePaths, storageName);
    if (existsSync(current) && !existsSync(pending)) renameSync(current, pending);
  }
  if (existsSync(databaseFilePath(runtimePaths, "")) && !existsSync(pendingRestorePath(runtimePaths))) {
    renameSync(databaseFilePath(runtimePaths, ""), pendingRestorePath(runtimePaths));
  }
  for (const storageName of [...journal.originalStorageNames].reverse()) {
    restoreBackupToCurrent(storageBackupPath(journal, storageName), storagePath(runtimePaths, storageName));
  }
  for (const suffix of [...journal.originalDatabaseSuffixes].reverse()) {
    restoreBackupToCurrent(databaseBackupPath(journal, suffix), databaseFilePath(runtimePaths, suffix));
  }
  fsyncDirectory(pendingRestoreAssetsPath(runtimePaths));
  const backupRoot = path.dirname(journal.backupStem);
  if (existsSync(backupRoot)) fsyncDirectory(backupRoot);
  fsyncDirectory(runtimePaths.state.restoreMarkers);
  assertRolledBackSynechRestore(runtimePaths, journal);
  validatePendingSynechRestore(runtimePaths);
}

function restoreBackupToCurrent(backup: string, current: string): void {
  if (!existsSync(backup)) {
    if (existsSync(current)) return;
    throw new Error(`Cannot restore missing Synech backup: ${backup}`);
  }
  if (existsSync(current)) throw new Error(`Cannot restore Synech backup over existing path: ${current}`);
  renameSync(backup, current);
}

function finalizeCommittedSynechRestore(runtimePaths: ProductPaths): void {
  const journal = readRestoreJournal(runtimePaths);
  const commit = readRestoreCommit(runtimePaths);
  if (commit.restoreId !== journal.restoreId) throw new Error("Synech restore commit does not match restore journal.");
  assertInstalledSynechRestore(runtimePaths);
  rmSync(pendingRestorePath(runtimePaths), { force: true });
  rmSync(pendingRestoreAssetsPath(runtimePaths), { recursive: true, force: true });
  rmSync(restoreJournalPath(runtimePaths), { force: true });
  rmSync(restoreCommitPath(runtimePaths), { force: true });
  fsyncDirectory(runtimePaths.state.restoreMarkers);
}

function assertInstalledSynechRestore(runtimePaths: ProductPaths): void {
  if (existsSync(pendingRestorePath(runtimePaths))) {
    throw new Error("Installed Synech restore still has a pending database.");
  }
  const health = checkSqliteDatabaseFile(databaseFilePath(runtimePaths, ""));
  if (!health.ok || !isSynechDatabase(health)) {
    throw new Error(`Installed Synech restore database is invalid: ${health.checks.join("; ")}`);
  }
  for (const storageName of OWNED_STORAGE_NAMES) {
    const current = storagePath(runtimePaths, storageName);
    if (existsSync(pendingStoragePath(runtimePaths, storageName))) {
      throw new Error(`Installed Synech restore still has pending storage: ${storageName}`);
    }
    if (!existsSync(current) || !statSync(current).isDirectory()) {
      throw new Error(`Installed Synech restore storage is missing: ${storageName}`);
    }
  }
}

function assertRolledBackSynechRestore(runtimePaths: ProductPaths, journal: SynechRestoreJournal): void {
  const health = checkSqliteDatabaseFile(databaseFilePath(runtimePaths, ""));
  if (!health.ok || !isSynechDatabase(health)) {
    throw new Error(`Rolled-back Synech database is invalid: ${health.checks.join("; ")}`);
  }
  for (const storageName of OWNED_STORAGE_NAMES) {
    const current = storagePath(runtimePaths, storageName);
    const shouldExist = journal.originalStorageNames.includes(storageName);
    if (shouldExist !== existsSync(current)) {
      throw new Error(`Rolled-back Synech storage does not match journal: ${storageName}`);
    }
    if (shouldExist && !statSync(current).isDirectory()) {
      throw new Error(`Rolled-back Synech storage is not a directory: ${storageName}`);
    }
  }
}

function writeRestoreJournal(runtimePaths: ProductPaths, journal: SynechRestoreJournal): void {
  writeJsonAtomicallySync(restoreJournalPath(runtimePaths), journal);
}

function writeRestoreCommit(runtimePaths: ProductPaths, restoreId: string): void {
  writeJsonAtomicallySync(restoreCommitPath(runtimePaths), {
    version: RESTORE_METADATA_VERSION,
    namespace: PRODUCT_NAMESPACE,
    dataFormatId: PRODUCT_DATA_FORMAT_ID,
    restoreId,
  } satisfies SynechRestoreCommit);
}

function restoreCommitMatches(runtimePaths: ProductPaths, restoreId: string): boolean {
  if (!existsSync(restoreCommitPath(runtimePaths))) return false;
  const commit = readRestoreCommit(runtimePaths);
  if (commit.restoreId !== restoreId) throw new Error("Synech restore commit does not match restore journal.");
  return true;
}

function readRestoreJournal(runtimePaths: ProductPaths): SynechRestoreJournal {
  const value = JSON.parse(readFileSync(restoreJournalPath(runtimePaths), "utf8")) as Partial<SynechRestoreJournal>;
  if (value.version !== RESTORE_METADATA_VERSION
    || value.namespace !== PRODUCT_NAMESPACE
    || value.dataFormatId !== PRODUCT_DATA_FORMAT_ID
    || typeof value.restoreId !== "string"
    || value.restoreId.length === 0
    || typeof value.backupStem !== "string"
    || !Array.isArray(value.originalDatabaseSuffixes)
    || !Array.isArray(value.originalStorageNames)
    || !pathIsInside(runtimePaths.backups, value.backupStem)
    || !value.originalDatabaseSuffixes.includes("")
    || new Set(value.originalDatabaseSuffixes).size !== value.originalDatabaseSuffixes.length
    || new Set(value.originalStorageNames).size !== value.originalStorageNames.length
    || value.originalDatabaseSuffixes.some((suffix) => !isDatabaseFileSuffix(suffix))
    || value.originalStorageNames.some((storageName) => !isOwnedStorageName(storageName))) {
    throw new SynechDataMaintenanceError("data_maintenance_failed", "应用恢复日志无效，当前数据库尚未打开。");
  }
  return value as SynechRestoreJournal;
}

function readRestoreCommit(runtimePaths: ProductPaths): SynechRestoreCommit {
  const value = JSON.parse(readFileSync(restoreCommitPath(runtimePaths), "utf8")) as Partial<SynechRestoreCommit>;
  if (value.version !== RESTORE_METADATA_VERSION
    || value.namespace !== PRODUCT_NAMESPACE
    || value.dataFormatId !== PRODUCT_DATA_FORMAT_ID
    || typeof value.restoreId !== "string" || value.restoreId.length === 0) {
    throw new SynechDataMaintenanceError("data_maintenance_failed", "应用恢复提交标记无效，当前数据库尚未打开。");
  }
  return value as SynechRestoreCommit;
}

function writeJsonAtomicallySync(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) throw new Error(`Synech restore metadata already exists: ${filePath}`);
  const temporaryPath = `${filePath}.tmp`;
  rmSync(temporaryPath, { force: true });
  const fd = openSync(temporaryPath, "wx");
  let writeFailure: unknown;
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
      fsyncSync(fd);
    } catch (error) {
      writeFailure = error;
      throw error;
    } finally {
      try {
        closeSync(fd);
      } catch (error) {
        if (writeFailure === undefined) throw error;
      }
    }
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  fsyncDirectory(path.dirname(filePath));
}

function fsyncDirectory(directoryPath: string): void {
  let fd: number | undefined;
  let primaryFailure: unknown;
  try {
    fd = openSync(directoryPath, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!isUnsupportedWindowsDirectoryFsync(error)) {
      primaryFailure = error;
      throw error;
    }
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } catch (error) {
      if (primaryFailure === undefined) throw error;
    }
  }
}

function isUnsupportedWindowsDirectoryFsync(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "EPERM" || code === "ENOTSUP" || code === "EISDIR";
}

function assertRestoreAdmission(state: "running" | "quiescing" | "staged" | "failed_requires_restart"): void {
  if (state === "running") return;
  throw new SynechDataMaintenanceError(
    "data_maintenance_failed",
    "应用恢复已经停止当前 Panel 的数据写入；请重启后再执行数据维护。",
  );
}

function databaseFilePath(runtimePaths: ProductPaths, suffix: DatabaseFileSuffix): string {
  return `${runtimePaths.data.database}${suffix}`;
}

function pendingRestorePath(runtimePaths: ProductPaths): string {
  return path.join(runtimePaths.state.restoreMarkers, PENDING_RESTORE_FILE_NAME);
}

function pendingRestoreAssetsPath(runtimePaths: ProductPaths): string {
  return path.join(runtimePaths.state.restoreMarkers, PENDING_RESTORE_ASSETS_NAME);
}

function restoreJournalPath(runtimePaths: ProductPaths): string {
  return path.join(runtimePaths.state.restoreMarkers, RESTORE_JOURNAL_FILE_NAME);
}

function restoreCommitPath(runtimePaths: ProductPaths): string {
  return path.join(runtimePaths.state.restoreMarkers, RESTORE_COMMIT_FILE_NAME);
}

function storagePath(runtimePaths: ProductPaths, storageName: OwnedStorageName): string {
  return storageName === "knowledge-assets"
    ? runtimePaths.data.workbench.knowledgeAssets
    : runtimePaths.data.workbench.spaceFiles;
}

function pendingStoragePath(runtimePaths: ProductPaths, storageName: OwnedStorageName): string {
  return path.join(pendingRestoreAssetsPath(runtimePaths), storageName);
}

function databaseBackupPath(journal: SynechRestoreJournal, suffix: DatabaseFileSuffix): string {
  return `${journal.backupStem}.sqlite3${suffix}`;
}

function storageBackupPath(journal: SynechRestoreJournal, storageName: OwnedStorageName): string {
  return `${journal.backupStem}.${storageName}`;
}

function isDatabaseFileSuffix(value: unknown): value is DatabaseFileSuffix {
  return typeof value === "string" && DATABASE_FILE_SUFFIXES.includes(value as DatabaseFileSuffix);
}

function isOwnedStorageName(value: unknown): value is OwnedStorageName {
  return typeof value === "string" && OWNED_STORAGE_NAMES.includes(value as OwnedStorageName);
}

function pathIsInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function validateBackupCompanions(databasePath: string): Promise<1> {
  try {
    const manifest = JSON.parse(await readFile(backupManifestPath(databasePath), "utf8")) as {
      version?: unknown;
      database?: unknown;
      assets?: unknown;
      roots?: unknown;
      namespace?: unknown;
      dataFormatId?: unknown;
    };
    if (manifest.database !== path.basename(databasePath)
      || manifest.assets !== path.basename(backupAssetsPath(databasePath))) {
      throw new Error("manifest mismatch");
    }
    if (manifest.version !== 1
      || manifest.namespace !== PRODUCT_NAMESPACE
      || manifest.dataFormatId !== PRODUCT_DATA_FORMAT_ID
      || !Array.isArray(manifest.roots)
      || manifest.roots.length !== OWNED_STORAGE_NAMES.length
      || manifest.roots.some((value, index) => value !== OWNED_STORAGE_NAMES[index])) {
      throw new Error("manifest mismatch");
    }
    for (const storageName of OWNED_STORAGE_NAMES) {
      if (!existsSync(path.join(backupAssetsPath(databasePath), storageName))) throw new Error("assets missing");
    }
    return 1;
  } catch (error) {
    throw new SynechDataMaintenanceError("restore_source_invalid", "所选备份缺少匹配的软件自管文件或清单文件。", { cause: error });
  }
}

function backupAssetsPath(databasePath: string): string {
  return `${databasePath}.assets`;
}

function backupManifestPath(databasePath: string): string {
  return `${databasePath}.manifest.json`;
}

function fileTimestamp(value: string): string {
  return value.replaceAll(":", "-");
}

function isSynechDatabase(input: {
  readonly tables: readonly string[];
  readonly productNamespace?: string;
  readonly dataFormatId?: string;
}): boolean {
  const names = new Set(input.tables);
  return names.has("spaces") && names.has("personal_notes") &&
    input.productNamespace === PRODUCT_NAMESPACE &&
    input.dataFormatId === PRODUCT_DATA_FORMAT_ID;
}
