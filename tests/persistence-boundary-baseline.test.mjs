import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/sqlite-runtime-database.js";
import { createSqliteManagedAssetRepository } from "../dist/app/managed-assets/index.js";
import { createSqliteWorkspaceRepository, WORKSPACE_SCHEMA_VERSION } from "../dist/app/workspaces/index.js";

test("Managed Asset persistence rejects a polluted JSON payload", async () => {
  await withDatabase(async (database) => {
    const repository = createSqliteManagedAssetRepository(database);
    database.connection.prepare("INSERT INTO managed_assets(id, payload_json) VALUES (?, ?)")
      .run("asset-1", JSON.stringify({ id: "asset-1", kind: "unknown", title: "bad" }));
    await assert.rejects(() => repository.get("asset-1"));
  });
});

test("Workspace persistence rejects overlapping active roots before writing", async () => {
  await withDatabase(async (database) => {
    const repository = createSqliteWorkspaceRepository(database);
    const at = "2026-01-01T00:00:00.000Z";
    await assert.rejects(() => repository.write({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaces: [
        { id: "workspace-parent", title: "parent", status: "available", visibility: "listed", createdAt: at, updatedAt: at },
        { id: "workspace-child", title: "child", status: "available", visibility: "listed", createdAt: at, updatedAt: at },
      ],
      mounts: [
        { workspaceId: "workspace-parent", mountVersion: "mount-1", rootPath: "C:/projects/root", sourceIdentity: "identity-1", status: "active", connectedAt: at },
        { workspaceId: "workspace-child", mountVersion: "mount-2", rootPath: "C:/projects/root/sub", sourceIdentity: "identity-2", status: "active", connectedAt: at },
      ],
    }), (error) => error?.code === "workspace_snapshot_incompatible");
  });
});

async function withDatabase(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-persistence-baseline-"));
  const database = new SqliteRuntimeDatabase(path.join(directory, "runtime.sqlite3"));
  try { await operation(database); } finally { database.close(); await fs.rm(directory, { recursive: true, force: true }); }
}
