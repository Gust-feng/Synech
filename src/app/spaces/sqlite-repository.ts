import type { SQLInputValue } from "node:sqlite";

import type { SqliteRuntimeDatabase } from "../../adapters/runtime-storage/index.js";
import {
  SPACE_TREE_SCHEMA_VERSION,
  SpaceFeatureError,
  type SpaceReferenceItem,
  type SpaceRepository,
  type SpaceTreeSnapshot,
} from "./contracts.js";
import { validateSpaceTreeSnapshot } from "./space-validation.js";

const MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
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
    CREATE INDEX space_references_space_idx ON space_references(space_id);
  `,
}, {
  version: 2,
  sql: "ALTER TABLE space_references ADD COLUMN web_metadata_json TEXT;",
}] as const;

export function createSqliteSpaceRepository(database: SqliteRuntimeDatabase): SpaceRepository {
  database.migrate("spaces", MIGRATIONS);
  return {
    async read(): Promise<SpaceTreeSnapshot> {
      try {
        const spaces = database.connection.prepare(
          "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM spaces ORDER BY created_at, id",
        ).all();
        const referenceItems = database.connection.prepare(`
          SELECT id, space_id AS spaceId, title, parent_id AS parentId, reference_json AS referenceJson,
                 source_identity AS sourceIdentity, annotation_json AS annotationJson,
                 image_captions_json AS imageCaptionsJson, web_metadata_json AS webMetadataJson,
                 created_at AS createdAt, updated_at AS updatedAt
           FROM space_references ORDER BY rowid
        `).all().map((row) => {
          const item = row as Record<string, SQLInputValue>;
          return {
            id: item.id,
            spaceId: item.spaceId,
            title: item.title,
            ...(item.parentId === null ? {} : { parentId: item.parentId }),
            reference: JSON.parse(String(item.referenceJson)) as unknown,
            ...(item.sourceIdentity === null ? {} : { sourceIdentity: item.sourceIdentity }),
            ...(item.annotationJson === null ? {} : { annotation: JSON.parse(String(item.annotationJson)) as unknown }),
            ...(item.imageCaptionsJson === null ? {} : { imageCaptions: JSON.parse(String(item.imageCaptionsJson)) as unknown }),
            ...(item.webMetadataJson === null ? {} : { webMetadata: JSON.parse(String(item.webMetadataJson)) as unknown }),
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          };
        }) as unknown as SpaceReferenceItem[];
        return validateSpaceTreeSnapshot({ schemaVersion: SPACE_TREE_SCHEMA_VERSION, spaces, referenceItems });
      } catch (error) {
        if (error instanceof SpaceFeatureError) throw error;
        throw new SpaceFeatureError("space_repository_failure", "Could not read SpaceTree from SQLite.", { cause: error });
      }
    },
    async write(snapshot: SpaceTreeSnapshot): Promise<void> {
      const value = validateSpaceTreeSnapshot(snapshot);
      try {
        writeSnapshot(database, value);
      } catch (error) {
        throw new SpaceFeatureError("space_repository_failure", "Could not persist SpaceTree to SQLite.", { cause: error });
      }
    },
  };
}

function writeSnapshot(database: SqliteRuntimeDatabase, value: SpaceTreeSnapshot): void {
  database.transaction(() => {
    database.connection.exec("PRAGMA defer_foreign_keys = ON; DELETE FROM space_references; DELETE FROM spaces");
    const insertSpace = database.connection.prepare(
      "INSERT INTO spaces(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    for (const space of value.spaces) insertSpace.run(space.id, space.title, space.createdAt, space.updatedAt);
    const insertReference = database.connection.prepare(`
      INSERT INTO space_references(id, space_id, title, parent_id, reference_json, source_identity, annotation_json, image_captions_json, web_metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of value.referenceItems) {
      insertReference.run(
        item.id,
        item.spaceId,
        item.title,
        item.parentId ?? null,
        JSON.stringify(item.reference),
        item.sourceIdentity ?? null,
        item.annotation === undefined ? null : JSON.stringify(item.annotation),
        item.imageCaptions === undefined ? null : JSON.stringify(item.imageCaptions),
        item.webMetadata === undefined ? null : JSON.stringify(item.webMetadata),
        item.createdAt,
        item.updatedAt,
      );
    }
  });
}
