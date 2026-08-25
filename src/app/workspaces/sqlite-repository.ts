import type { SQLInputValue } from "node:sqlite";

import type { SqliteRuntimeDatabase } from "../../adapters/runtime-storage/index.js";
import {
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceFeatureError,
  type WorkspaceRepository,
  type WorkspaceSnapshot,
} from "./contracts.js";
import { validateWorkspaceSnapshot } from "./workspace-validation.js";

const MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('available', 'disconnected', 'deleting')),
      visibility TEXT NOT NULL CHECK(visibility IN ('listed', 'implicit')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE workspace_mounts (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      mount_version TEXT NOT NULL,
      root_path TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'invalidated')),
      connected_at TEXT NOT NULL,
      invalidated_at TEXT,
      PRIMARY KEY (workspace_id, mount_version)
    ) STRICT;
  `,
}] as const;

export function createSqliteWorkspaceRepository(database: SqliteRuntimeDatabase): WorkspaceRepository {
  database.migrate("workspaces", MIGRATIONS);
  return {
    async read(): Promise<WorkspaceSnapshot> {
      try {
        const workspaces = database.connection.prepare(
          "SELECT id, title, status, visibility, created_at AS createdAt, updated_at AS updatedAt FROM workspaces ORDER BY created_at, id",
        ).all().map(rowToWorkspace);
        const mounts = database.connection.prepare(`
          SELECT workspace_id AS workspaceId, mount_version AS mountVersion, root_path AS rootPath,
                 source_identity AS sourceIdentity, status, connected_at AS connectedAt,
                 invalidated_at AS invalidatedAt
            FROM workspace_mounts ORDER BY connected_at, mount_version
        `).all().map(rowToMount);
        return validateWorkspaceSnapshot({ schemaVersion: WORKSPACE_SCHEMA_VERSION, workspaces, mounts });
      } catch (error) {
        if (error instanceof WorkspaceFeatureError) throw error;
        throw new WorkspaceFeatureError("workspace_repository_failure", "Could not read Workspace snapshot from SQLite.", { cause: error });
      }
    },
    async write(snapshot: WorkspaceSnapshot): Promise<void> {
      const value = validateWorkspaceSnapshot(snapshot);
      try {
        writeSnapshot(database, value);
      } catch (error) {
        throw new WorkspaceFeatureError("workspace_repository_failure", "Could not persist Workspace snapshot to SQLite.", { cause: error });
      }
    },
  };
}

function rowToWorkspace(row: unknown): unknown {
  const value = row as Record<string, SQLInputValue>;
  return {
    id: String(value.id),
    title: String(value.title),
    status: value.status,
    visibility: value.visibility,
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
  };
}

function rowToMount(row: unknown): unknown {
  const value = row as Record<string, SQLInputValue>;
  return {
    workspaceId: String(value.workspaceId),
    mountVersion: String(value.mountVersion),
    rootPath: String(value.rootPath),
    sourceIdentity: String(value.sourceIdentity),
    status: value.status,
    connectedAt: String(value.connectedAt),
    ...(value.invalidatedAt === null ? {} : { invalidatedAt: String(value.invalidatedAt) }),
  };
}

function writeSnapshot(database: SqliteRuntimeDatabase, value: WorkspaceSnapshot): void {
  database.transaction(() => {
    database.connection.exec("PRAGMA defer_foreign_keys = ON; DELETE FROM workspace_mounts; DELETE FROM workspaces");
    const insertWorkspace = database.connection.prepare(
      "INSERT INTO workspaces(id, title, status, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const workspace of value.workspaces) {
      insertWorkspace.run(workspace.id, workspace.title, workspace.status, workspace.visibility, workspace.createdAt, workspace.updatedAt);
    }
    const insertMount = database.connection.prepare(`
      INSERT INTO workspace_mounts(workspace_id, mount_version, root_path, source_identity, status, connected_at, invalidated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const mount of value.mounts) {
      insertMount.run(
        mount.workspaceId,
        mount.mountVersion,
        mount.rootPath,
        mount.sourceIdentity,
        mount.status,
        mount.connectedAt,
        mount.invalidatedAt ?? null,
      );
    }
  });
}
