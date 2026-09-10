import type { DatabaseSync } from "node:sqlite";

import { PRODUCT_DATA_FORMAT_ID, PRODUCT_NAMESPACE } from "../../platform/product-identity.js";

/** The only public database format released before the frozen v1 baseline. */
export const RELEASED_V101_DATA_FORMAT_ID = "synech/v1-baseline-5" as const;

type MigrationLedgerEntry = {
  readonly owner: string;
  readonly version: number;
  readonly checksum: string;
};

/**
 * Exact v1.0.1 ledger. This is deliberately narrow: it identifies one released
 * database layout, not a generic compatibility protocol for development data.
 */
const RELEASED_V101_MIGRATIONS: readonly MigrationLedgerEntry[] = [
  { owner: "conversation-lifecycle", version: 1, checksum: "ca7ecb9854e63dae1438816b573cb57eceb9625167f690dad50b975202ce7a2a" },
  { owner: "managed-assets", version: 1, checksum: "d81174fdfb81bfda1a49d8c62029a326f297a776818dd74328e13ef65d697495" },
  { owner: "memory", version: 1, checksum: "2dffd4ab92580beea0a6b5cfd9f45db43d8bf1444742253d8704c5be9d2f371f" },
  { owner: "memory", version: 2, checksum: "fc6212e17aad369eb6182ff9d0ade6b204be6cc612c8d1acefe932e3dc06777c" },
  { owner: "memory", version: 3, checksum: "03d27d5ae01b30dcb4c9b84d79d1b613619f3fab71dae5c8eee3237aee00d4b5" },
  { owner: "memory", version: 4, checksum: "98c02fa0ec5f8077e46ef83eafbe3346ee82ed1d4df9a4d82e06a232b275676c" },
  { owner: "memory", version: 5, checksum: "4ec2318bb3a29ad5ad1da636a5217c64184be323bb7f1b8f5abec836ed5e54ce" },
  { owner: "memory", version: 6, checksum: "0685642cc3cc5da6dda7eb86d1313f0ad0c6100b7435ae6b75e1366a29cfa276" },
  { owner: "personal-knowledge", version: 1, checksum: "765a1c04ff9d0be57bf1e5285f6733f7308ae43fdb8b86b96fd0b03c2415c5a1" },
  { owner: "space-conversation-deletion", version: 1, checksum: "fcc367ac68ae21c2e453a683ee1aa1058338f320fab41348dc3b589491fe4b11" },
  { owner: "spaces", version: 1, checksum: "ec9bca6dc50030789f488591bf130ede75110e41a8b1b348e896f476c581d0b4" },
  { owner: "spaces", version: 2, checksum: "419efc52a2931e46f914e718e34d727cd2597a0d9dd789feb40058511133ae9d" },
  { owner: "workspaces", version: 1, checksum: "2dde5c2c686904e92333c633c38095fe2178e33f4f86d0a360d5925cefd0f373" },
];

/** Frozen target v1 ledger after the v1.0.1 adoption transaction completes. */
const FROZEN_V1_MIGRATIONS: readonly MigrationLedgerEntry[] = [
  { owner: "conversation-lifecycle", version: 1, checksum: "ca7ecb9854e63dae1438816b573cb57eceb9625167f690dad50b975202ce7a2a" },
  { owner: "managed-assets", version: 1, checksum: "d81174fdfb81bfda1a49d8c62029a326f297a776818dd74328e13ef65d697495" },
  { owner: "memory", version: 1, checksum: "3d349f2d045023e2c80711b6701a2168fea7b41f0a09594ee649387d0187c2e6" },
  { owner: "personal-knowledge", version: 1, checksum: "765a1c04ff9d0be57bf1e5285f6733f7308ae43fdb8b86b96fd0b03c2415c5a1" },
  { owner: "space-conversation-deletion", version: 1, checksum: "fcc367ac68ae21c2e453a683ee1aa1058338f320fab41348dc3b589491fe4b11" },
  { owner: "spaces", version: 1, checksum: "d783205b4e31fc0a3445ad6d448e35bb147088a732bca23d3bf5cd255f44df0e" },
  { owner: "workspaces", version: 1, checksum: "2dde5c2c686904e92333c633c38095fe2178e33f4f86d0a360d5925cefd0f373" },
];

/**
 * Normalizes the one released v1.0.1 layout into the frozen v1 layout.
 *
 * `false` means this file is not exactly the v1.0.1 release and is left
 * untouched. SQL failures roll the entire conversion back.
 */
export function upgradeReleasedV101Database(connection: DatabaseSync): boolean {
  connection.exec("BEGIN IMMEDIATE");
  try {
    if (!hasReleasedV101IdentityAndLedger(connection)) {
      connection.exec("ROLLBACK");
      return false;
    }
    connection.exec("PRAGMA defer_foreign_keys = ON");
    rebuildMemoryPolicy(connection);
    rebuildMemoryCaptureProgress(connection);
    rebuildSpaceReferences(connection);
    replaceMigrationLedger(connection);
    const updated = connection.prepare(`
      UPDATE product_identity SET data_format_id = ?
      WHERE product_namespace = ? AND data_format_id = ?
    `).run(PRODUCT_DATA_FORMAT_ID, PRODUCT_NAMESPACE, RELEASED_V101_DATA_FORMAT_ID);
    if (updated.changes !== 1) throw new Error("Released v1.0.1 product identity changed during upgrade.");
    connection.exec("COMMIT");
    return true;
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Released v1.0.1 database upgrade and rollback both failed.",
      );
    }
    throw error;
  }
}

function hasReleasedV101IdentityAndLedger(connection: DatabaseSync): boolean {
  const identity = connection.prepare(`
    SELECT product_namespace AS productNamespace, data_format_id AS dataFormatId
    FROM product_identity ORDER BY product_namespace
  `).all() as readonly Record<string, unknown>[];
  if (identity.length !== 1 ||
      identity[0]?.productNamespace !== PRODUCT_NAMESPACE ||
      identity[0]?.dataFormatId !== RELEASED_V101_DATA_FORMAT_ID) {
    return false;
  }
  const migrationTable = connection.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  if (migrationTable === undefined) return false;
  const ledger = connection.prepare(`
    SELECT owner, version, checksum FROM schema_migrations ORDER BY owner, version
  `).all() as readonly Record<string, unknown>[];
  return ledger.length === RELEASED_V101_MIGRATIONS.length && ledger.every((entry, index) => {
    const expected = RELEASED_V101_MIGRATIONS[index];
    return entry.owner === expected?.owner &&
      entry.version === expected.version &&
      entry.checksum === expected.checksum;
  });
}

function rebuildMemoryPolicy(connection: DatabaseSync): void {
  connection.exec(`
    ALTER TABLE memory_policy RENAME TO _synech_v101_memory_policy;
    CREATE TABLE memory_policy (
      policy_key TEXT PRIMARY KEY,
      policy_kind TEXT NOT NULL CHECK(policy_kind IN ('global_consent', 'rollout', 'space_participation')),
      scope_owner_key TEXT,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      revision INTEGER NOT NULL CHECK(revision > 0),
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO memory_policy(policy_key, policy_kind, scope_owner_key, enabled, revision, updated_at)
      SELECT policy_key, policy_kind, scope_owner_key, enabled, revision, updated_at
      FROM _synech_v101_memory_policy;
    DROP TABLE _synech_v101_memory_policy;
  `);
}

function rebuildMemoryCaptureProgress(connection: DatabaseSync): void {
  connection.exec(`
    ALTER TABLE memory_capture_progress RENAME TO _synech_v101_memory_capture_progress;
    CREATE TABLE memory_capture_progress (
      conversation_id TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      processed_through_ordinal INTEGER NOT NULL CHECK(processed_through_ordinal >= 0),
      excluded_through_ordinal INTEGER NOT NULL CHECK(excluded_through_ordinal >= 0),
      source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint) > 0),
      updated_at INTEGER NOT NULL,
      processed_fragment_ordinal INTEGER,
      processed_fragment_end INTEGER
    ) STRICT;
    INSERT INTO memory_capture_progress(
      conversation_id, owner_key, processed_through_ordinal, excluded_through_ordinal,
      source_fingerprint, updated_at, processed_fragment_ordinal, processed_fragment_end
    ) SELECT
      conversation_id, owner_key, processed_through_ordinal, excluded_through_ordinal,
      source_fingerprint, updated_at, processed_fragment_ordinal, processed_fragment_end
    FROM _synech_v101_memory_capture_progress;
    DROP TABLE _synech_v101_memory_capture_progress;
    CREATE INDEX memory_capture_progress_owner_idx ON memory_capture_progress(owner_key);
  `);
}

function rebuildSpaceReferences(connection: DatabaseSync): void {
  connection.exec(`
    ALTER TABLE space_references RENAME TO _synech_v101_space_references;
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
      updated_at TEXT NOT NULL,
      web_metadata_json TEXT
    ) STRICT;
    INSERT INTO space_references(
      id, space_id, title, reference_json, parent_id, source_identity, status,
      unavailable_at, annotation_json, image_captions_json, created_at, updated_at, web_metadata_json
    ) SELECT
      id, space_id, title, reference_json, parent_id, source_identity, status,
      unavailable_at, annotation_json, image_captions_json, created_at, updated_at, web_metadata_json
    FROM _synech_v101_space_references;
    DROP TABLE _synech_v101_space_references;
    CREATE INDEX space_references_space_idx ON space_references(space_id);
  `);
}

function replaceMigrationLedger(connection: DatabaseSync): void {
  connection.prepare("DELETE FROM schema_migrations").run();
  const insert = connection.prepare(`
    INSERT INTO schema_migrations(owner, version, checksum, applied_at) VALUES (?, ?, ?, ?)
  `);
  const appliedAt = new Date().toISOString();
  for (const migration of FROZEN_V1_MIGRATIONS) {
    insert.run(migration.owner, migration.version, migration.checksum, appliedAt);
  }
}
