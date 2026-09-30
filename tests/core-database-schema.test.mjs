import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  checkSqliteDatabaseFile,
  SqliteRuntimeDatabase,
} from "../dist/adapters/runtime-storage/index.js";
import { openPanelStorage } from "../dist/app/panel-server/storage/panel-storage.js";
import { resolveProductPaths } from "../dist/platform/storage/index.js";

test("fresh Product Home matches the target v1 baseline and reopens without migration writes", async () => {
  execFileSync(process.execPath, ["scripts/update-data-baseline.mjs", "--check"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  const baseline = JSON.parse(await readFile("docs/architecture/data-baseline.json", "utf8"));
  assert.ok(Object.values(baseline.migrationOwners).every((version) => version === 1));

  await withStorageFixture((paths) => {
    const before = databaseSnapshot(paths.data.database);
    const storage = openPanelStorage(paths);
    storage.database.close();
    assert.deepEqual(databaseSnapshot(paths.data.database), before);
    for (const migration of before.health.migrations) {
      assert.equal(migration.version, 1);
      assert.equal(migration.checksum, baseline.migrationChecksums[`${migration.owner}/1`]);
    }
  });
});

test("old formats and unknown namespaces are rejected without changing the database", async (t) => {
  const identities = [
    { namespace: "synech", format: "synech/v1-baseline-5" },
    { namespace: "synech", format: "synech/v1-dev" },
    { namespace: "other-product", format: "synech/v1" },
  ];
  for (const { namespace, format } of identities) {
    await t.test(`${namespace}: ${format}`, async () => {
      await withStorageFixture((paths) => {
        mutateDatabase(paths.data.database, (database) => {
          database.prepare("UPDATE product_identity SET product_namespace = ?, data_format_id = ?")
            .run(namespace, format);
        });
        const before = databaseSnapshot(paths.data.database);
        assert.throws(() => new SqliteRuntimeDatabase(paths.data.database), {
          code: "sqlite_product_identity_mismatch",
        });
        assert.deepEqual(databaseSnapshot(paths.data.database), before);
        assertConnectionReleased(paths.data.database);
      });
    });
  }
});

test("old research versions and checksums fail startup unchanged and release the connection", async (t) => {
  const ledgers = [
    {
      name: "research/4",
      version: 4,
      checksum: "7e5f3c31f1ed9d4660261e85e149b8e7c986d8b5ab97c8fb0b123350a9a7410b",
      code: "sqlite_schema_version_unsupported",
    },
    {
      name: "old research/1 checksum",
      version: 1,
      checksum: "2573017cb4dca9d4d5e0afcc38ab59a5ee0db3ef8d215608ec86dd0f800a7b53",
      code: "sqlite_migration_integrity_failure",
    },
  ];
  for (const { name, version, checksum, code } of ledgers) {
    await t.test(name, async () => {
      await withStorageFixture((paths) => {
        mutateDatabase(paths.data.database, (database) => {
          database.prepare("UPDATE schema_migrations SET version = ?, checksum = ? WHERE owner = ?")
            .run(version, checksum, "research");
        });
        const before = databaseSnapshot(paths.data.database);
        assert.throws(() => openPanelStorage(paths), { code });
        assert.deepEqual(databaseSnapshot(paths.data.database), before);
        assertConnectionReleased(paths.data.database);
      });
    });
  }
});

async function withStorageFixture(operation) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, "synech-schema-test-"));
  try {
    const paths = resolveProductPaths({ productHome: root });
    const storage = openPanelStorage(paths);
    try {
      storage.database.connection.prepare(
        "INSERT INTO spaces(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run("space-fixture", "Preserved content", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    } finally {
      storage.database.close();
    }
    await operation(paths);
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith("synech-schema-test-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function databaseSnapshot(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    return {
      health: checkSqliteDatabaseFile(filePath),
      identity: database.prepare("SELECT * FROM product_identity ORDER BY product_namespace").all(),
      ledger: database.prepare("SELECT * FROM schema_migrations ORDER BY owner, version").all(),
      content: database.prepare("SELECT * FROM spaces ORDER BY id").all(),
      initializations: database.prepare("SELECT * FROM runtime_initializations ORDER BY initialization_key").all(),
      journalMode: database.prepare("PRAGMA journal_mode").get(),
    };
  } finally {
    database.close();
  }
}

function mutateDatabase(filePath, operation) {
  const database = new DatabaseSync(filePath);
  try {
    operation(database);
  } finally {
    database.close();
  }
}

function assertConnectionReleased(filePath) {
  mutateDatabase(filePath, (database) => {
    // Switching out of WAL requires other connections to have released the database.
    assert.equal(database.prepare("PRAGMA journal_mode = DELETE").get().journal_mode, "delete");
  });
}
