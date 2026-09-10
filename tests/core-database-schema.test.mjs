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
import { startLocalPanelServer } from "../dist/app/panel-server/request-handler.js";

const RELEASED_V101_LEDGER = [
  ["conversation-lifecycle", 1, "ca7ecb9854e63dae1438816b573cb57eceb9625167f690dad50b975202ce7a2a"],
  ["managed-assets", 1, "d81174fdfb81bfda1a49d8c62029a326f297a776818dd74328e13ef65d697495"],
  ["memory", 1, "2dffd4ab92580beea0a6b5cfd9f45db43d8bf1444742253d8704c5be9d2f371f"],
  ["memory", 2, "fc6212e17aad369eb6182ff9d0ade6b204be6cc612c8d1acefe932e3dc06777c"],
  ["memory", 3, "03d27d5ae01b30dcb4c9b84d79d1b613619f3fab71dae5c8eee3237aee00d4b5"],
  ["memory", 4, "98c02fa0ec5f8077e46ef83eafbe3346ee82ed1d4df9a4d82e06a232b275676c"],
  ["memory", 5, "4ec2318bb3a29ad5ad1da636a5217c64184be323bb7f1b8f5abec836ed5e54ce"],
  ["memory", 6, "0685642cc3cc5da6dda7eb86d1313f0ad0c6100b7435ae6b75e1366a29cfa276"],
  ["personal-knowledge", 1, "765a1c04ff9d0be57bf1e5285f6733f7308ae43fdb8b86b96fd0b03c2415c5a1"],
  ["space-conversation-deletion", 1, "fcc367ac68ae21c2e453a683ee1aa1058338f320fab41348dc3b589491fe4b11"],
  ["spaces", 1, "ec9bca6dc50030789f488591bf130ede75110e41a8b1b348e896f476c581d0b4"],
  ["spaces", 2, "419efc52a2931e46f914e718e34d727cd2597a0d9dd789feb40058511133ae9d"],
  ["workspaces", 1, "2dde5c2c686904e92333c633c38095fe2178e33f4f86d0a360d5925cefd0f373"],
];

test("fresh Product Home initializes the frozen v1 schema and matches the baseline", () => {
  execFileSync(process.execPath, ["scripts/update-data-baseline.mjs", "--check"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
});

test("the exact released v1.0.1 database upgrades atomically to frozen v1", async () => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, "synech-v101-upgrade-"));
  try {
    const filePath = await createReleasedV101Fixture(root);
    const database = new SqliteRuntimeDatabase(filePath);
    try {
      assert.equal(database.connection.prepare("SELECT enabled FROM memory_policy WHERE policy_key = ?")
        .get("global_consent").enabled, 1);
      assert.equal(database.connection.prepare("SELECT processed_fragment_end FROM memory_capture_progress WHERE conversation_id = ?")
        .get("conversation-fixture").processed_fragment_end, 23);
      assert.equal(database.connection.prepare("SELECT web_metadata_json FROM space_references WHERE id = ?")
        .get("reference-child").web_metadata_json, '{"url":"https://example.test"}');
    } finally {
      database.close();
    }

    const baseline = JSON.parse(await readFile("docs/architecture/data-baseline.json", "utf8"));
    const upgraded = checkSqliteDatabaseFile(filePath);
    assert.equal(upgraded.ok, true);
    assert.equal(upgraded.productNamespace, "synech");
    assert.equal(upgraded.dataFormatId, "synech/v1");
    assert.equal(upgraded.schemaFingerprint, baseline.schemaFingerprint);
    assert.deepEqual(
      Object.fromEntries(upgraded.migrations.map((migration) => [`${migration.owner}/${migration.version}`, migration.checksum])),
      baseline.migrationChecksums,
    );
  } finally {
    await removeTemporaryRoot(root, temporaryRoot, "synech-v101-upgrade-");
  }
});

test("partial v1.0.1 ledgers remain rejected and unchanged", async () => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, "synech-v101-rejection-"));
  try {
    const filePath = await createReleasedV101Fixture(root);
    const mutator = new DatabaseSync(filePath);
    try {
      mutator.prepare("DELETE FROM schema_migrations WHERE owner = ? AND version = ?").run("memory", 6);
    } finally {
      mutator.close();
    }

    assert.throws(() => new SqliteRuntimeDatabase(filePath), { code: "sqlite_product_identity_mismatch" });

    const reader = new DatabaseSync(filePath, { readOnly: true });
    try {
      assert.equal(reader.prepare("SELECT data_format_id FROM product_identity").get().data_format_id,
        "synech/v1-baseline-5");
      assert.equal(reader.prepare("SELECT enabled FROM memory_policy WHERE policy_key = ?")
        .get("global_consent").enabled, 1);
      assert.match(
        reader.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_capture_progress'").get().sql,
        /, processed_fragment_ordinal INTEGER, processed_fragment_end INTEGER\) STRICT$/u,
      );
    } finally {
      reader.close();
    }
  } finally {
    await removeTemporaryRoot(root, temporaryRoot, "synech-v101-rejection-");
  }
});

test("a malformed v1.0.1 layout rolls back every upgrade write", async () => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, "synech-v101-rollback-"));
  try {
    const filePath = await createReleasedV101Fixture(root);
    const mutator = new DatabaseSync(filePath);
    try {
      mutator.exec("DROP TABLE memory_capture_progress");
    } finally {
      mutator.close();
    }

    assert.throws(() => new SqliteRuntimeDatabase(filePath));

    const reader = new DatabaseSync(filePath, { readOnly: true });
    try {
      assert.equal(reader.prepare("SELECT data_format_id FROM product_identity").get().data_format_id,
        "synech/v1-baseline-5");
      assert.equal(reader.prepare("SELECT enabled FROM memory_policy WHERE policy_key = ?")
        .get("global_consent").enabled, 1);
      assert.match(
        reader.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_policy'").get().sql,
        /^CREATE TABLE "memory_policy"/u,
      );
    } finally {
      reader.close();
    }
  } finally {
    await removeTemporaryRoot(root, temporaryRoot, "synech-v101-rollback-");
  }
});

async function createReleasedV101Fixture(root) {
  const productHome = path.join(root, "product-home");
  const server = await startLocalPanelServer({ productHome, host: "127.0.0.1", port: 0 });
  await server.close();
  const filePath = path.join(productHome, "data", "synech.sqlite3");
  const database = new DatabaseSync(filePath);
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(`
      ALTER TABLE memory_policy RENAME TO _fixture_memory_policy;
      CREATE TABLE "memory_policy" (
        policy_key TEXT PRIMARY KEY,
        policy_kind TEXT NOT NULL CHECK(policy_kind IN ('global_consent', 'rollout', 'space_participation')),
        scope_owner_key TEXT,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        revision INTEGER NOT NULL CHECK(revision > 0),
        updated_at INTEGER NOT NULL
      ) STRICT;
      DROP TABLE _fixture_memory_policy;

      ALTER TABLE memory_capture_progress RENAME TO _fixture_memory_capture_progress;
      CREATE TABLE memory_capture_progress (
        conversation_id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        processed_through_ordinal INTEGER NOT NULL CHECK(processed_through_ordinal >= 0),
        excluded_through_ordinal INTEGER NOT NULL CHECK(excluded_through_ordinal >= 0),
        source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint) > 0),
        updated_at INTEGER NOT NULL
      ) STRICT;
      DROP TABLE _fixture_memory_capture_progress;
      CREATE INDEX memory_capture_progress_owner_idx ON memory_capture_progress(owner_key);
      ALTER TABLE memory_capture_progress ADD COLUMN processed_fragment_ordinal INTEGER;
      ALTER TABLE memory_capture_progress ADD COLUMN processed_fragment_end INTEGER;

      ALTER TABLE space_references RENAME TO _fixture_space_references;
      CREATE TABLE space_references (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        reference_json TEXT NOT NULL,
        parent_id TEXT REFERENCES space_references(id) ON DELETE CASCADE,
        source_identity TEXT,
        status TEXT CHECK(status IN ('available', 'unavailable')),
        unavailable_at TEXT,
        annotation_json TEXT,
        image_captions_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      DROP TABLE _fixture_space_references;
      CREATE INDEX space_references_space_idx ON space_references(space_id);
      ALTER TABLE space_references ADD COLUMN web_metadata_json TEXT;
    `);
    database.prepare(`
      INSERT INTO memory_policy(policy_key, policy_kind, scope_owner_key, enabled, revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("global_consent", "global_consent", null, 1, 2, 17);
    database.prepare(`
      INSERT INTO memory_capture_progress(
        conversation_id, owner_key, processed_through_ordinal, excluded_through_ordinal,
        source_fingerprint, updated_at, processed_fragment_ordinal, processed_fragment_end
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("conversation-fixture", "space:fixture", 12, 2, "fixture-fingerprint", 19, 12, 23);
    database.prepare("INSERT INTO spaces(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("space-fixture", "Fixture", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.prepare(`
      INSERT INTO space_references(
        id, space_id, title, reference_json, parent_id, source_identity, status,
        unavailable_at, annotation_json, image_captions_json, created_at, updated_at, web_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "reference-root", "space-fixture", "Root", "{}", null, null, "available", null, null, null,
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", null,
    );
    database.prepare(`
      INSERT INTO space_references(
        id, space_id, title, reference_json, parent_id, source_identity, status,
        unavailable_at, annotation_json, image_captions_json, created_at, updated_at, web_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "reference-child", "space-fixture", "Child", "{}", "reference-root", null, "available", null, null, null,
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", '{"url":"https://example.test"}',
    );
    database.prepare("DELETE FROM schema_migrations").run();
    const insertMigration = database.prepare(`
      INSERT INTO schema_migrations(owner, version, checksum, applied_at) VALUES (?, ?, ?, ?)
    `);
    for (const [owner, version, checksum] of RELEASED_V101_LEDGER) {
      insertMigration.run(owner, version, checksum, "2026-01-01T00:00:00.000Z");
    }
    database.prepare("UPDATE product_identity SET data_format_id = ?").run("synech/v1-baseline-5");
    database.exec("PRAGMA foreign_keys = ON");
  } finally {
    database.close();
  }
  return filePath;
}

async function removeTemporaryRoot(root, temporaryRoot, prefix) {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), temporaryRoot);
  assert.ok(path.basename(resolved).startsWith(prefix));
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
