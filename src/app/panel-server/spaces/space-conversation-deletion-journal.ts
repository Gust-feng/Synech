import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { SqliteRuntimeDatabase } from "../../../adapters/runtime-storage/index.js";
export {
  SPACE_CONVERSATION_DELETION_SCHEMA_VERSION,
  type SpaceConversationDeletionCheckpoint,
  type SpaceConversationDeletionJournal,
  type SpaceConversationDeletionPhase,
  type SpaceConversationDeletionRecord,
} from "../../workbench-coordination/space-deletion-journal-contract.js";
import {
  SPACE_CONVERSATION_DELETION_SCHEMA_VERSION,
  type SpaceConversationDeletionJournal,
  type SpaceConversationDeletionRecord,
} from "../../workbench-coordination/space-deletion-journal-contract.js";

const conversationIdsSchema = z.array(z.string().min(1)).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "conversation ids must be unique" });
  }
});

const recordSchema: z.ZodType<SpaceConversationDeletionRecord> = z.object({
  schemaVersion: z.literal(SPACE_CONVERSATION_DELETION_SCHEMA_VERSION),
  deletionId: z.string().uuid(),
  spaceId: z.string().min(1),
  conversationIds: conversationIdsSchema,
  referenceIds: conversationIdsSchema.optional().default([]),
  phase: z.enum([
    "prepared",
    "processes_stopped",
    "conversations_deleted",
    "knowledge_cleaned",
    "space_deleted",
    "cleanup_pending",
    "failed",
  ]),
  resumeFrom: z.enum(["prepared", "processes_stopped", "conversations_deleted", "knowledge_cleaned", "space_deleted"]).optional(),
  errorMessage: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict().superRefine((record, context) => {
  if (record.phase === "failed" && record.resumeFrom === undefined) {
    context.addIssue({ code: "custom", path: ["resumeFrom"], message: "failed records require a resume checkpoint" });
  }
  if (record.phase !== "failed" && (record.resumeFrom !== undefined || record.errorMessage !== undefined)) {
    context.addIssue({ code: "custom", message: "only failed records may carry resumeFrom or errorMessage" });
  }
});

type JournalRow = {
  readonly schemaVersion: string;
  readonly deletionId: string;
  readonly spaceId: string;
  readonly conversationIdsJson: string;
  readonly referenceIdsJson: string;
  readonly phase: string;
  readonly resumeFrom: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export function createSqliteSpaceConversationDeletionJournal(
  database: SqliteRuntimeDatabase,
): SpaceConversationDeletionJournal {
  database.migrate("space-conversation-deletion", [{
    version: 1,
    sql: "CREATE TABLE space_conversation_deletions (deletion_id TEXT PRIMARY KEY, schema_version TEXT NOT NULL, space_id TEXT NOT NULL UNIQUE, conversation_ids_json TEXT NOT NULL, reference_ids_json TEXT NOT NULL, phase TEXT NOT NULL, resume_from TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;",
  }]);
  const selectColumns = `
    schema_version AS schemaVersion,
    deletion_id AS deletionId,
    space_id AS spaceId,
    conversation_ids_json AS conversationIdsJson,
    reference_ids_json AS referenceIdsJson,
    phase,
    resume_from AS resumeFrom,
    error_message AS errorMessage,
    created_at AS createdAt,
    updated_at AS updatedAt
  `;

  return {
    async list() {
      const rows = database.connection.prepare(`
        SELECT ${selectColumns}
        FROM space_conversation_deletions
        ORDER BY created_at, deletion_id
      `).all() as unknown as readonly JournalRow[];
      return rows.map(recordFromRow);
    },

    async getBySpace(spaceId) {
      const row = database.connection.prepare(`
        SELECT ${selectColumns}
        FROM space_conversation_deletions
        WHERE space_id = ?
      `).get(spaceId) as JournalRow | undefined;
      return row === undefined ? undefined : recordFromRow(row);
    },

    async save(value) {
      const record = validateRecord(value);
      database.connection.prepare(`
        INSERT INTO space_conversation_deletions(
          deletion_id, schema_version, space_id, conversation_ids_json, reference_ids_json,
          phase, resume_from, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(deletion_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          space_id = excluded.space_id,
          conversation_ids_json = excluded.conversation_ids_json,
          reference_ids_json = excluded.reference_ids_json,
          phase = excluded.phase,
          resume_from = excluded.resume_from,
          error_message = excluded.error_message,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        record.deletionId,
        record.schemaVersion,
        record.spaceId,
        JSON.stringify(record.conversationIds),
        JSON.stringify(record.referenceIds ?? []),
        record.phase,
        record.resumeFrom ?? null,
        record.errorMessage ?? null,
        record.createdAt,
        record.updatedAt,
      );
    },

    async delete(deletionId) {
      database.connection.prepare(
        "DELETE FROM space_conversation_deletions WHERE deletion_id = ?",
      ).run(deletionId);
    },
  };
}

export function newSpaceConversationDeletionRecord(input: {
  readonly spaceId: string;
  readonly conversationIds: readonly string[];
  /** Reference ids captured before Space deletion; used to detach knowledge sources. */
  readonly referenceIds?: readonly string[];
  readonly now: string;
  readonly deletionId?: string;
}): SpaceConversationDeletionRecord {
  return validateRecord({
    schemaVersion: SPACE_CONVERSATION_DELETION_SCHEMA_VERSION,
    deletionId: input.deletionId ?? randomUUID(),
    spaceId: input.spaceId,
    conversationIds: [...new Set(input.conversationIds)],
    referenceIds: [...new Set(input.referenceIds ?? [])],
    phase: "prepared",
    createdAt: input.now,
    updatedAt: input.now,
  });
}

function recordFromRow(row: JournalRow): SpaceConversationDeletionRecord {
  let conversationIds: unknown;
  let referenceIds: unknown;
  try {
    conversationIds = JSON.parse(row.conversationIdsJson) as unknown;
    referenceIds = JSON.parse(row.referenceIdsJson) as unknown;
  } catch (error) {
    throw new Error(`Space deletion journal ${row.deletionId} contains invalid JSON.`, { cause: error });
  }
  return validateRecord({
    schemaVersion: row.schemaVersion,
    deletionId: row.deletionId,
    spaceId: row.spaceId,
    conversationIds,
    referenceIds,
    phase: row.phase,
    ...(row.resumeFrom === null ? {} : { resumeFrom: row.resumeFrom }),
    ...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function validateRecord(value: unknown): SpaceConversationDeletionRecord {
  const result = recordSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Space deletion journal is incompatible: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
