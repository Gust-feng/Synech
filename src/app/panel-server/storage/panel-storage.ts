import { promises as fs } from "node:fs";
import path from "node:path";

import { SqliteRuntimeDatabase } from "../../../adapters/runtime-storage/index.js";
import type { ProductPaths } from "../../../platform/storage/index.js";
import { createSqliteManagedAssetRepository } from "../../managed-assets/index.js";
import { createSqliteMemoryControlRepository } from "../../memory/index.js";
import { createSqlitePersonalKnowledgeRepository } from "../../personal-knowledge/index.js";
import {
  createFileSystemSpaceReferenceDeletionJournal,
  createSpaceFeature,
  createSqliteSpaceRepository,
  inspectFileSystemSpaceReferenceDeletionJournal,
  type SpaceFeature,
} from "../../spaces/index.js";
import { InMemoryLocalWorkspaceMutationCoordinator } from "../../tool-center/adapters/local-workspace-mutation-coordinator.js";
import { DataMaintenanceError, hasUnappliedPendingRestore } from "./data-maintenance.js";
import { createSpaceReferenceDeletionFilePort } from "../spaces/space-reference-deletion.js";

export async function preparePanelStorageForStartup(productPaths: ProductPaths): Promise<void> {
  const journalRoot = path.join(productPaths.state.journals, "space-reference-deletions");
  if (!hasUnappliedPendingRestore(productPaths) ||
    inspectFileSystemSpaceReferenceDeletionJournal(journalRoot) === "idle") return;

  const databasePath = productPaths.data.database;
  try {
    await fs.access(databasePath);
  } catch (error) {
    throw new DataMaintenanceError(
      "data_maintenance_failed",
      "应用恢复前无法读取保存 Space 删除身份的当前数据库；恢复未修改任何数据。",
      { cause: error },
    );
  }
  const database = new SqliteRuntimeDatabase(databasePath);
  let spaceFeature: SpaceFeature | undefined;
  let startupError: unknown;
  try {
    const managedAssets = createSqliteManagedAssetRepository(database);
    spaceFeature = createSpaceFeature({
      repository: createSqliteSpaceRepository(database),
      ownedAssetDeletion: {
        deleteManagedAssets: async (assetIds) => await managedAssets.removeMany(assetIds),
      },
      referenceDeletion: {
        journal: createFileSystemSpaceReferenceDeletionJournal(journalRoot),
        files: createSpaceReferenceDeletionFilePort(
          path.join(productPaths.data.spaces.files, "folders"),
        ),
        leases: new InMemoryLocalWorkspaceMutationCoordinator(),
        deleteOwnedAssets: async (assetIds) => await managedAssets.removeMany(assetIds),
      },
    });
    await spaceFeature.ready();
  } catch (error) {
    startupError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (spaceFeature !== undefined) {
    try { await spaceFeature.release(); } catch (error) { cleanupErrors.push(error); }
  }
  try { database.close(); } catch (error) { cleanupErrors.push(error); }
  if (startupError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [startupError, ...cleanupErrors],
        "Space deletion recovery before restore and cleanup both failed.",
      );
    }
    throw startupError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Space deletion recovery cleanup before restore failed.");
  }
}

export function openPanelStorage(productPaths: ProductPaths) {
  const database = new SqliteRuntimeDatabase(productPaths.data.database);
  try {
    return {
      database,
      managedAssets: createSqliteManagedAssetRepository(database),
      spaceRepository: createSqliteSpaceRepository(database),
      personalKnowledgeRepository: createSqlitePersonalKnowledgeRepository(database),
      memoryControlRepository: createSqliteMemoryControlRepository(database),
    };
  } catch (startupError) {
    try {
      database.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Workbench storage initialization and cleanup both failed.",
      );
    }
    throw startupError;
  }
}

export function assertSpaceDeletionJournalIdle(productPaths: ProductPaths): void {
  const status = inspectFileSystemSpaceReferenceDeletionJournal(
    path.join(productPaths.state.journals, "space-reference-deletions"),
  );
  if (status !== "idle") throw new Error("Space deletion recovery is still pending.");
}
