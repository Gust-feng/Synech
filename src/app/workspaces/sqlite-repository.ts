import type { SQLInputValue } from "node:sqlite";

import type { SqliteRuntimeDatabase } from "../../adapters/runtime-storage/index.js";
import {
  WORKSPACE_SCHEMA_VERSION,
  WorkspaceFeatureError,
  type Workspace,
  type WorkspaceMount,
  type WorkspaceRepository,
  type WorkspaceSnapshot,
} from "./contracts.js";

const MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('available', 'disconnected', 'deleting')),
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

    CREATE TABLE workspace_links (
      link_id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      mount_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
    CREATE INDEX workspace_links_space_idx ON workspace_links(space_id);
    CREATE INDEX workspace_links_workspace_idx ON workspace_links(workspace_id);
  `,
}, {
  version: 2,
  sql: `
    ALTER TABLE workspaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'listed'
      CHECK(visibility IN ('listed', 'implicit'));
    DROP TABLE workspace_links;
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
        return validateSnapshot({ schemaVersion: WORKSPACE_SCHEMA_VERSION, workspaces, mounts });
      } catch (error) {
        if (error instanceof WorkspaceFeatureError) throw error;
        throw new WorkspaceFeatureError("workspace_repository_failure", "Could not read Workspace snapshot from SQLite.", { cause: error });
      }
    },
    async write(snapshot: WorkspaceSnapshot): Promise<void> {
      const value = validateSnapshot(snapshot);
      try {
        writeSnapshot(database, value);
      } catch (error) {
        throw new WorkspaceFeatureError("workspace_repository_failure", "Could not persist Workspace snapshot to SQLite.", { cause: error });
      }
    },
  };
}

function rowToWorkspace(row: unknown): Workspace {
  const value = row as Record<string, SQLInputValue>;
  return {
    id: String(value.id),
    title: String(value.title),
    status: value.status as Workspace["status"],
    visibility: value.visibility as Workspace["visibility"],
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
  };
}

function rowToMount(row: unknown): WorkspaceMount {
  const value = row as Record<string, SQLInputValue>;
  return {
    workspaceId: String(value.workspaceId),
    mountVersion: String(value.mountVersion),
    rootPath: String(value.rootPath),
    sourceIdentity: String(value.sourceIdentity),
    status: value.status as WorkspaceMount["status"],
    connectedAt: String(value.connectedAt),
    ...(value.invalidatedAt === null ? {} : { invalidatedAt: String(value.invalidatedAt) }),
  };
}

function validateSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  if (snapshot.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new WorkspaceFeatureError(
      "workspace_snapshot_incompatible",
      `Unsupported Workspace schema ${snapshot.schemaVersion}.`,
    );
  }
  const workspaceIds = new Set(snapshot.workspaces.map((workspace) => workspace.id));
  for (const mount of snapshot.mounts) {
    if (!workspaceIds.has(mount.workspaceId)) {
      throw new WorkspaceFeatureError(
        "workspace_snapshot_incompatible",
        `Workspace mount ${mount.mountVersion} references missing Workspace ${mount.workspaceId}.`,
      );
    }
  }
  for (const workspace of snapshot.workspaces) {
    const activeMountCount = snapshot.mounts.filter(
      (mount) => mount.workspaceId === workspace.id && mount.status === "active",
    ).length;
    const valid = workspace.status === "available"
      ? activeMountCount === 1
      : workspace.status === "disconnected"
        ? activeMountCount === 0
        : activeMountCount <= 1;
    if (!valid) {
      throw new WorkspaceFeatureError(
        "workspace_snapshot_incompatible",
        `Workspace ${workspace.id} status ${workspace.status} is inconsistent with ${activeMountCount} active mounts.`,
      );
    }
  }
  return snapshot;
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
