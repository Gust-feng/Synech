import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SqliteRuntimeDatabase,
  SqliteSchemaVersionError,
} from "../dist/adapters/runtime-storage/index.js";

test("a build refuses to run against a newer feature schema", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synech-schema-version-"));
  const database = new SqliteRuntimeDatabase(path.join(directory, "data.sqlite3"));
  try {
    database.connection.prepare(
      "INSERT INTO schema_migrations(owner, version, applied_at) VALUES (?, ?, ?)",
    ).run("future-feature", 2, new Date().toISOString());

    assert.throws(
      () => database.migrate("future-feature", [{ version: 1, sql: "CREATE TABLE should_not_exist(id TEXT)" }]),
      (error) => error instanceof SqliteSchemaVersionError &&
        error.code === "sqlite_schema_version_unsupported" &&
        error.storedVersion === 2 &&
        error.supportedVersion === 1,
    );
    assert.equal(
      database.connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'should_not_exist'").get(),
      undefined,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
