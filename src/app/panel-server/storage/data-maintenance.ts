import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import {
  checkSqliteDatabaseFile,
  type SqliteAppliedMigration,
  type SqliteDatabaseBaseline,
  type SqliteRuntimeDatabase,
} from "../../../adapters/runtime-storage/index.js";
import { renameWithRetry } from "../../../kernel/fs/atomic-write.js";
import type { ProductPaths } from "../../../platform/storage/index.js";
import { PRODUCT_DATA_FORMAT_ID, PRODUCT_NAMESPACE } from "../../../platform/product-identity.js";

// v3 adds the durable memory-data root so user rules, agent notes and path
// dependencies travel with the SQLite state they reference.
const BACKUP_MANIFEST_VERSION = 3;
const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const OWNED_STORAGE_NAMES = ["knowledge-assets", "space-files", "memory-data"] as const;
const PENDING_RESTORE_BUNDLE_NAME = "pending-restore";
const ROLLBACK_BUNDLE_NAME = "restore-rollback";
const BUNDLE_DATABASE_FILE_NAME = "database.sqlite3";
const BUNDLE_MANIFEST_FILE_NAME = "manifest.json";

type DatabaseFileSuffix = typeof DATABASE_FILE_SUFFIXES[number];
type OwnedStorageName = typeof OWNED_STORAGE_NAMES[number];

type BackupManifest = {
  readonly version: typeof BACKUP_MANIFEST_VERSION;
  readonly namespace: typeof PRODUCT_NAMESPACE;
  readonly dataFormatId: typeof PRODUCT_DATA_FORMAT_ID;
  readonly database: string;
  readonly assets: string;
  readonly roots: readonly OwnedStorageName[];
  readonly createdAt: string;
  readonly schemaFingerprint: string;
  readonly migrations: readonly SqliteAppliedMigration[];
};

export type DataMaintenance = {
  health(): {
    readonly ok: boolean;
    readonly checks: readonly string[];
    readonly migrations: readonly { readonly owner: string; readonly version: number; readonly checksum: string; readonly appliedAt: string }[];
    readonly pendingRestore: boolean;
  };
  createBackup(): Promise<{ readonly filePath: string; readonly byteLength: number; readonly createdAt: string }>;
  selectAndStageRestore(): Promise<
    | { readonly status: "cancelled" }
    | { readonly status: "staged"; readonly sourcePath: string; readonly safetyBackupPath: string; readonly restartRequired: true }
  >;
};

export class DataMaintenanceError extends Error {
  readonly name = "DataMaintenanceError";

  constructor(
    readonly code: "restore_picker_unavailable" | "restore_source_invalid" | "data_maintenance_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type WorkbenchBackupDatabase = Pick<SqliteRuntimeDatabase, "filePath" | "health" | "backupTo">;

export function createDataMaintenance(input: {
  readonly database: WorkbenchBackupDatabase;
  readonly productPaths: ProductPaths;
  readonly restorePicker?: () => Promise<string | undefined>;
  readonly beforeRestoreStage?: () => Promise<void>;
  readonly runOwnedStorageSnapshot?: <T>(operation: () => Promise<T>) => Promise<T>;
}): DataMaintenance {
  let queue = Promise.resolve();
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return await result;
  };
  const createBackup = async () => await withOwnedStorageSnapshot(input, async () => {
    const createdAt = new Date().toISOString();
    const filePath = path.join(
      input.productPaths.backups,
      `synech-${fileTimestamp(createdAt)}-${randomUUID().slice(0, 8)}.sqlite3`,
    );
    return await writeBackup(input, filePath, createdAt);
  });

  return {
    health() {
      return {
        ...input.database.health(),
        pendingRestore: existsSync(pendingRestoreBundlePath(input.productPaths)),
      };
    },
    createBackup: () => run(createBackup),
    selectAndStageRestore: () => run(async () => {
      if (input.restorePicker === undefined) {
        throw new DataMaintenanceError("restore_picker_unavailable", "当前运行方式不支持选择应用数据备份。");
      }
      const selectedPath = await input.restorePicker();
      if (selectedPath === undefined) return { status: "cancelled" };
      if (path.resolve(selectedPath) === path.resolve(input.database.filePath)) {
        throw new DataMaintenanceError("restore_source_invalid", "不能把当前正在使用的数据库作为恢复来源。");
      }
      await validateSelectedBackup(selectedPath, databaseBaseline(input.database.filePath));
      try {
        await input.beforeRestoreStage?.();
      } catch (error) {
        throw new DataMaintenanceError(
          "data_maintenance_failed",
          "恢复前无法停止当前数据写入，请重启后重试。",
          { cause: error },
        );
      }
      const safetyBackup = await createBackup().catch((error: unknown) => {
        if (error instanceof DataMaintenanceError) throw error;
        throw new DataMaintenanceError("data_maintenance_failed", "恢复前的安全备份失败，请重启后重试。", { cause: error });
      });
      await stageRestoreBundle(input.productPaths, selectedPath);
      return {
        status: "staged",
        sourcePath: selectedPath,
        safetyBackupPath: safetyBackup.filePath,
        restartRequired: true,
      };
    }),
  };
}

async function withOwnedStorageSnapshot<T>(
  input: {
    readonly runOwnedStorageSnapshot?: <R>(operation: () => Promise<R>) => Promise<R>;
  },
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return input.runOwnedStorageSnapshot === undefined
      ? await operation()
      : await input.runOwnedStorageSnapshot(operation);
  } catch (error) {
    if (error instanceof DataMaintenanceError) throw error;
    throw new DataMaintenanceError("data_maintenance_failed", "应用数据备份失败。", { cause: error });
  }
}

async function writeBackup(
  input: {
    readonly database: WorkbenchBackupDatabase;
    readonly productPaths: ProductPaths;
  },
  filePath: string,
  createdAt: string,
): Promise<{ readonly filePath: string; readonly byteLength: number; readonly createdAt: string }> {
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
    const baseline = databaseBaseline(temporaryFilePath);
    await writeFile(temporaryManifestPath, JSON.stringify(backupManifest({
      database: path.basename(filePath),
      assets: path.basename(assetsPath),
      createdAt,
      baseline,
    })), "utf8");
    await renameWithRetry(temporaryFilePath, filePath);
    await renameWithRetry(temporaryAssetsPath, assetsPath);
    await renameWithRetry(temporaryManifestPath, manifestPath);
    return { filePath, byteLength: databaseBackup.byteLength, createdAt };
  } catch (error) {
    await Promise.allSettled([
      rm(temporaryFilePath, { force: true }),
      rm(temporaryAssetsPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
      rm(temporaryManifestPath, { force: true }),
      rm(filePath, { force: true }),
      rm(assetsPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
      rm(manifestPath, { force: true }),
    ]);
    throw new DataMaintenanceError("data_maintenance_failed", "应用数据备份失败。", { cause: error });
  }
}

async function stageRestoreBundle(runtimePaths: ProductPaths, selectedPath: string): Promise<void> {
  const pendingPath = pendingRestoreBundlePath(runtimePaths);
  const temporaryPath = path.join(
    runtimePaths.state.restoreMarkers,
    `.pending-restore-${randomUUID()}`,
  );
  try {
    await mkdir(temporaryPath, { recursive: true });
    await copyFile(selectedPath, path.join(temporaryPath, BUNDLE_DATABASE_FILE_NAME));
    for (const storageName of OWNED_STORAGE_NAMES) {
      await cp(
        path.join(backupAssetsPath(selectedPath), storageName),
        path.join(temporaryPath, storageName),
        { recursive: true },
      );
    }
    await writeFile(path.join(temporaryPath, BUNDLE_MANIFEST_FILE_NAME), JSON.stringify(backupManifest({
      database: BUNDLE_DATABASE_FILE_NAME,
      assets: ".",
      createdAt: new Date().toISOString(),
      baseline: databaseBaseline(selectedPath),
    })), "utf8");
    await rm(pendingPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    await renameWithRetry(temporaryPath, pendingPath);
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => undefined);
    throw new DataMaintenanceError("data_maintenance_failed", "应用恢复文件暂存失败。", { cause: error });
  }
}

/** Applies the complete staged bundle before the shared database is opened. */
export function applyPendingRestore(
  runtimePaths: ProductPaths,
  input: { readonly assertSpaceDeletionIdle: () => void },
): void {
  const pendingPath = pendingRestoreBundlePath(runtimePaths);
  const rollbackPath = rollbackBundlePath(runtimePaths);
  if (existsSync(rollbackPath)) {
    throw new DataMaintenanceError(
      "data_maintenance_failed",
      `上次恢复在文件替换期间中断，请人工检查 ${rollbackPath} 后重试。`,
    );
  }
  if (!existsSync(pendingPath)) return;
  try {
    input.assertSpaceDeletionIdle();
    const currentDatabasePath = databaseFilePath(runtimePaths, "");
    if (!existsSync(currentDatabasePath)) {
      throw new DataMaintenanceError("data_maintenance_failed", "当前应用数据库不存在，恢复未执行。");
    }
    validateRestoreBundle(pendingPath, databaseBaseline(currentDatabasePath));
  } catch (error) {
    if (error instanceof DataMaintenanceError) throw error;
    throw new DataMaintenanceError("data_maintenance_failed", "待恢复数据无法应用，当前数据未修改。", { cause: error });
  }

  const originalDatabaseSuffixes = DATABASE_FILE_SUFFIXES.filter((suffix) =>
    existsSync(databaseFilePath(runtimePaths, suffix))
  );
  if (!originalDatabaseSuffixes.includes("")) throw new Error("Current database disappeared after restore validation.");
  const originalStorageNames = OWNED_STORAGE_NAMES.filter((storageName) =>
    existsSync(storagePath(runtimePaths, storageName))
  );
  const installedStorageNames = new Set<OwnedStorageName>();
  let installedDatabase = false;
  mkdirSync(rollbackPath, { recursive: false });
  try {
    for (const suffix of originalDatabaseSuffixes) {
      renameSync(databaseFilePath(runtimePaths, suffix), rollbackDatabasePath(rollbackPath, suffix));
    }
    for (const storageName of originalStorageNames) {
      renameSync(storagePath(runtimePaths, storageName), path.join(rollbackPath, storageName));
    }
    renameSync(path.join(pendingPath, BUNDLE_DATABASE_FILE_NAME), databaseFilePath(runtimePaths, ""));
    installedDatabase = true;
    for (const storageName of OWNED_STORAGE_NAMES) {
      renameSync(path.join(pendingPath, storageName), storagePath(runtimePaths, storageName));
      installedStorageNames.add(storageName);
    }
    rmSync(pendingPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(rollbackPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  } catch (error) {
    try {
      rollbackRestore({
        runtimePaths,
        pendingPath,
        rollbackPath,
        originalDatabaseSuffixes,
        originalStorageNames,
        installedDatabase,
        installedStorageNames,
      });
    } catch (rollbackError) {
      throw new DataMaintenanceError(
        "data_maintenance_failed",
        `应用恢复失败且回滚未完成，请人工检查 ${rollbackPath}。`,
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw new DataMaintenanceError("data_maintenance_failed", "应用恢复失败，原数据已恢复。", { cause: error });
  }
}

export function hasUnappliedPendingRestore(runtimePaths: ProductPaths): boolean {
  return existsSync(pendingRestoreBundlePath(runtimePaths));
}

function rollbackRestore(input: {
  readonly runtimePaths: ProductPaths;
  readonly pendingPath: string;
  readonly rollbackPath: string;
  readonly originalDatabaseSuffixes: readonly DatabaseFileSuffix[];
  readonly originalStorageNames: readonly OwnedStorageName[];
  readonly installedDatabase: boolean;
  readonly installedStorageNames: ReadonlySet<OwnedStorageName>;
}): void {
  mkdirSync(input.pendingPath, { recursive: true });
  if (input.installedDatabase) {
    renameSync(databaseFilePath(input.runtimePaths, ""), path.join(input.pendingPath, BUNDLE_DATABASE_FILE_NAME));
  }
  for (const storageName of input.installedStorageNames) {
    renameSync(storagePath(input.runtimePaths, storageName), path.join(input.pendingPath, storageName));
  }
  for (const storageName of input.originalStorageNames) {
    const backup = path.join(input.rollbackPath, storageName);
    if (existsSync(backup)) renameSync(backup, storagePath(input.runtimePaths, storageName));
  }
  for (const suffix of input.originalDatabaseSuffixes) {
    const backup = rollbackDatabasePath(input.rollbackPath, suffix);
    if (existsSync(backup)) renameSync(backup, databaseFilePath(input.runtimePaths, suffix));
  }
  rmSync(input.rollbackPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

async function validateSelectedBackup(databasePath: string, expected: SqliteDatabaseBaseline): Promise<void> {
  try {
    const manifest = parseManifest(await readFile(backupManifestPath(databasePath), "utf8"));
    assertManifest(manifest, {
      database: path.basename(databasePath),
      assets: path.basename(backupAssetsPath(databasePath)),
    });
    for (const storageName of OWNED_STORAGE_NAMES) {
      const directoryPath = path.join(backupAssetsPath(databasePath), storageName);
      if (!existsSync(directoryPath) || !statSync(directoryPath).isDirectory()) throw new Error(`${storageName} missing`);
    }
    assertWorkbenchDatabase(databasePath, manifest, expected);
  } catch (error) {
    if (error instanceof DataMaintenanceError) throw error;
    throw new DataMaintenanceError("restore_source_invalid", "所选备份不完整或不是有效的应用数据备份。", { cause: error });
  }
}

function validateRestoreBundle(bundlePath: string, expected: SqliteDatabaseBaseline): void {
  try {
    const manifest = parseManifest(readFileSync(path.join(bundlePath, BUNDLE_MANIFEST_FILE_NAME), "utf8"));
    assertManifest(manifest, { database: BUNDLE_DATABASE_FILE_NAME, assets: "." });
    for (const storageName of OWNED_STORAGE_NAMES) {
      const directoryPath = path.join(bundlePath, storageName);
      if (!existsSync(directoryPath) || !statSync(directoryPath).isDirectory()) throw new Error(`${storageName} missing`);
    }
    assertWorkbenchDatabase(path.join(bundlePath, BUNDLE_DATABASE_FILE_NAME), manifest, expected);
  } catch (error) {
    if (error instanceof DataMaintenanceError) throw error;
    throw new DataMaintenanceError("restore_source_invalid", "待恢复数据不完整或已损坏。", { cause: error });
  }
}

function assertWorkbenchDatabase(
  databasePath: string,
  manifest: BackupManifest,
  expected: SqliteDatabaseBaseline,
): void {
  const health = checkSqliteDatabaseFile(databasePath);
  const actual = { schemaFingerprint: health.schemaFingerprint, migrations: health.migrations };
  if (!health.ok || !isWorkbenchDatabase(health) ||
      !sameDatabaseBaseline(actual, manifest) ||
      !sameDatabaseBaseline(actual, expected)) {
    throw new Error(health.checks.join("; ") || "database identity mismatch");
  }
}

function backupManifest(input: {
  readonly database: string;
  readonly assets: string;
  readonly createdAt: string;
  readonly baseline: SqliteDatabaseBaseline;
}): BackupManifest {
  return {
    version: BACKUP_MANIFEST_VERSION,
    namespace: PRODUCT_NAMESPACE,
    dataFormatId: PRODUCT_DATA_FORMAT_ID,
    database: input.database,
    assets: input.assets,
    roots: OWNED_STORAGE_NAMES,
    createdAt: input.createdAt,
    schemaFingerprint: input.baseline.schemaFingerprint,
    migrations: input.baseline.migrations,
  };
}

const backupManifestSchema = z.object({
  version: z.literal(BACKUP_MANIFEST_VERSION),
  namespace: z.literal(PRODUCT_NAMESPACE),
  dataFormatId: z.literal(PRODUCT_DATA_FORMAT_ID),
  database: z.string().min(1),
  assets: z.string().min(1),
  roots: z.tuple([z.literal("knowledge-assets"), z.literal("space-files"), z.literal("memory-data")]),
  createdAt: z.string().min(1),
  schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  migrations: z.array(z.object({
    owner: z.string().min(1),
    version: z.number().int().positive(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()),
}).strict();

function parseManifest(value: string): BackupManifest {
  return backupManifestSchema.parse(JSON.parse(value));
}

function assertManifest(
  manifest: BackupManifest,
  expected: { readonly database: string; readonly assets: string },
): void {
  if (manifest.version !== BACKUP_MANIFEST_VERSION ||
    manifest.namespace !== PRODUCT_NAMESPACE ||
    manifest.dataFormatId !== PRODUCT_DATA_FORMAT_ID ||
    manifest.database !== expected.database ||
    manifest.assets !== expected.assets ||
    !Array.isArray(manifest.roots) ||
    manifest.roots.length !== OWNED_STORAGE_NAMES.length ||
    manifest.roots.some((value, index) => value !== OWNED_STORAGE_NAMES[index])) {
    throw new Error("backup manifest mismatch");
  }
}

function databaseBaseline(databasePath: string): SqliteDatabaseBaseline {
  const health = checkSqliteDatabaseFile(databasePath);
  if (!health.ok || !isWorkbenchDatabase(health)) {
    throw new Error(health.checks.join("; ") || "database identity mismatch");
  }
  return { schemaFingerprint: health.schemaFingerprint, migrations: health.migrations };
}

function sameDatabaseBaseline(
  left: SqliteDatabaseBaseline,
  right: SqliteDatabaseBaseline,
): boolean {
  return left.schemaFingerprint === right.schemaFingerprint &&
    JSON.stringify(left.migrations) === JSON.stringify(right.migrations);
}

function databaseFilePath(runtimePaths: ProductPaths, suffix: DatabaseFileSuffix): string {
  return `${runtimePaths.data.database}${suffix}`;
}

function storagePath(runtimePaths: ProductPaths, storageName: OwnedStorageName): string {
  switch (storageName) {
    case "knowledge-assets": return runtimePaths.data.knowledge.assets;
    case "space-files": return runtimePaths.data.spaces.files;
    case "memory-data": return runtimePaths.data.memory.root;
  }
}

function pendingRestoreBundlePath(runtimePaths: ProductPaths): string {
  return path.join(runtimePaths.state.restoreMarkers, PENDING_RESTORE_BUNDLE_NAME);
}

function rollbackBundlePath(runtimePaths: ProductPaths): string {
  return path.join(runtimePaths.state.restoreMarkers, ROLLBACK_BUNDLE_NAME);
}

function rollbackDatabasePath(rollbackPath: string, suffix: DatabaseFileSuffix): string {
  return path.join(rollbackPath, `${BUNDLE_DATABASE_FILE_NAME}${suffix}`);
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

function isWorkbenchDatabase(input: {
  readonly tables: readonly string[];
  readonly productNamespace?: string;
  readonly dataFormatId?: string;
}): boolean {
  const names = new Set(input.tables);
  return names.has("spaces") && names.has("personal_notes") &&
    input.productNamespace === PRODUCT_NAMESPACE &&
    input.dataFormatId === PRODUCT_DATA_FORMAT_ID;
}
