import { existsSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { PRODUCT_DATA_FORMAT_ID, PRODUCT_NAMESPACE } from "../../platform/product-identity.js";

export type SqliteMigration = {
  readonly version: number;
  readonly sql: string;
};

const PRODUCT_IDENTITY_TABLE = "product_identity";

export class SqliteRuntimeDatabaseIdentityError extends Error {
  readonly code = "sqlite_product_identity_mismatch" as const;

  constructor(message: string) {
    super(message);
    this.name = "SqliteRuntimeDatabaseIdentityError";
  }
}

export class SqliteSchemaVersionError extends Error {
  readonly code = "sqlite_schema_version_unsupported" as const;

  constructor(
    readonly owner: string,
    readonly storedVersion: number,
    readonly supportedVersion: number,
  ) {
    super(`SQLite schema owner ${owner} is at version ${storedVersion}, but this build supports ${supportedVersion}.`);
    this.name = "SqliteSchemaVersionError";
  }
}

/** Host-owned SQLite connection shared by feature-specific repositories. */
export class SqliteRuntimeDatabase {
  readonly connection: DatabaseSync;
  #closed = false;

  constructor(readonly filePath: string) {
    const existedBeforeOpen = existsSync(filePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const connection = new DatabaseSync(filePath);
    try {
      const existingTables = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all();
      const hasIdentityTable = existingTables.some((row) =>
        String((row as Record<string, unknown>).name) === "product_identity");
      if (existingTables.length > 0 && !hasIdentityTable) {
        throw new Error("SQLite database is missing the product identity marker and belongs to an incompatible namespace.");
      }
      connection.exec("PRAGMA journal_mode = WAL");
      connection.exec("PRAGMA foreign_keys = ON");
      connection.exec("PRAGMA synchronous = NORMAL");
      connection.exec("PRAGMA busy_timeout = 5000");
      const identityTable = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(PRODUCT_IDENTITY_TABLE);
      if (existedBeforeOpen && identityTable === undefined) {
        throw new SqliteRuntimeDatabaseIdentityError(
          `SQLite database ${filePath} has no ${PRODUCT_IDENTITY_TABLE} marker and does not belong to the current Synech product identity.`,
        );
      }
      connection.exec(`
        CREATE TABLE IF NOT EXISTS ${PRODUCT_IDENTITY_TABLE} (
          product_namespace TEXT PRIMARY KEY,
          data_format_id TEXT NOT NULL
        ) STRICT
      `);
      if (!existedBeforeOpen) {
        connection.prepare(`
          INSERT INTO ${PRODUCT_IDENTITY_TABLE}(product_namespace, data_format_id)
          VALUES (?, ?)
        `).run(PRODUCT_NAMESPACE, PRODUCT_DATA_FORMAT_ID);
      } else {
        const identity = connection.prepare(`
          SELECT product_namespace AS productNamespace, data_format_id AS dataFormatId
          FROM ${PRODUCT_IDENTITY_TABLE}
          ORDER BY rowid LIMIT 1
        `).get() as { readonly productNamespace?: unknown; readonly dataFormatId?: unknown } | undefined;
        if (identity?.productNamespace !== PRODUCT_NAMESPACE || identity.dataFormatId !== PRODUCT_DATA_FORMAT_ID) {
          throw new SqliteRuntimeDatabaseIdentityError(
            `SQLite database ${filePath} belongs to a different product namespace or data format.`,
          );
        }
      }
      connection.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          owner TEXT PRIMARY KEY,
          version INTEGER NOT NULL,
          applied_at TEXT NOT NULL
        ) STRICT
      `);
      connection.exec(`
        CREATE TABLE IF NOT EXISTS runtime_initializations (
          initialization_key TEXT PRIMARY KEY,
          initialized_at TEXT NOT NULL
        ) STRICT
      `);
    } catch (initializationError) {
      try {
        connection.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [initializationError, cleanupError],
          "SQLite runtime database initialization and cleanup both failed.",
        );
      }
      throw initializationError;
    }
    this.connection = connection;
  }

  migrate(owner: string, migrations: readonly SqliteMigration[]): void {
    const ordered = [...migrations].sort((left, right) => left.version - right.version);
    const supportedVersion = ordered.at(-1)?.version ?? 0;
    const current = this.connection.prepare(
      "SELECT version FROM schema_migrations WHERE owner = ?",
    ).get(owner) as { readonly version: number } | undefined;
    let version = current?.version ?? 0;
    if (version > supportedVersion) {
      throw new SqliteSchemaVersionError(owner, version, supportedVersion);
    }
    for (const migration of ordered) {
      if (migration.version <= version) continue;
      this.transaction(() => {
        this.connection.exec(migration.sql);
        this.connection.prepare(`
          INSERT INTO schema_migrations(owner, version, applied_at)
          VALUES (?, ?, ?)
          ON CONFLICT(owner) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at
        `).run(owner, migration.version, new Date().toISOString());
      });
      version = migration.version;
    }
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  hasInitialization(initializationKey: string): boolean {
    return this.connection.prepare(
      "SELECT 1 AS found FROM runtime_initializations WHERE initialization_key = ?",
    ).get(initializationKey) !== undefined;
  }

  recordInitialization(initializationKey: string): void {
    this.connection.prepare(
      "INSERT OR IGNORE INTO runtime_initializations(initialization_key, initialized_at) VALUES (?, ?)",
    ).run(initializationKey, new Date().toISOString());
  }

  health(): {
    readonly ok: boolean;
    readonly checks: readonly string[];
    readonly migrations: readonly { readonly owner: string; readonly version: number; readonly appliedAt: string }[];
  } {
    const checks = this.connection.prepare("PRAGMA quick_check").all()
      .map((row) => String((row as Record<string, unknown>).quick_check));
    const migrations = this.connection.prepare(`
      SELECT owner, version, applied_at AS appliedAt
      FROM schema_migrations ORDER BY owner
    `).all() as unknown as readonly { readonly owner: string; readonly version: number; readonly appliedAt: string }[];
    return { ok: checks.length === 1 && checks[0] === "ok", checks, migrations };
  }

  async backupTo(destinationPath: string): Promise<{ readonly filePath: string; readonly byteLength: number }> {
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    await backup(this.connection, destinationPath);
    const health = checkSqliteDatabaseFile(destinationPath);
    if (!health.ok) throw new Error(`SQLite backup integrity check failed: ${health.checks.join("; ")}`);
    return { filePath: destinationPath, byteLength: (await stat(destinationPath)).size };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.connection.close();
  }
}

export function checkSqliteDatabaseFile(filePath: string): {
  readonly ok: boolean;
  readonly checks: readonly string[];
  readonly tables: readonly string[];
  readonly productNamespace?: string;
  readonly dataFormatId?: string;
} {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const checks = database.prepare("PRAGMA quick_check").all()
      .map((row) => String((row as Record<string, unknown>).quick_check));
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all().map((row) => String((row as Record<string, unknown>).name));
    let productNamespace: string | undefined;
    let dataFormatId: string | undefined;
    if (tables.includes("product_identity")) {
      const identity = database.prepare(
        "SELECT product_namespace AS productNamespace, data_format_id AS dataFormatId FROM product_identity",
      ).get() as { readonly productNamespace?: unknown; readonly dataFormatId?: unknown } | undefined;
      if (typeof identity?.productNamespace === "string") productNamespace = identity.productNamespace;
      if (typeof identity?.dataFormatId === "string") dataFormatId = identity.dataFormatId;
    }
    return { ok: checks.length === 1 && checks[0] === "ok", checks, tables, productNamespace, dataFormatId };
  } finally {
    database.close();
  }
}
