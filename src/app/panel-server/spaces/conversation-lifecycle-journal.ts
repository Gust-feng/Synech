import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { SqliteRuntimeDatabase } from "../../../adapters/runtime-storage/index.js";

/**
 * Durable Host records for creating and deleting an Ordinary Conversation.
 */
export const CONVERSATION_LIFECYCLE_SCHEMA_VERSION = "conversation-lifecycle/v1" as const;

export type ConversationBirthPhase =
  | "prepared"
  | "conversation_created";

export type ConversationDeletePhase =
  | "prepared"
  | "processes_stopped"
  | "conversation_deleted";

export type ConversationBirthRecord = {
  readonly schemaVersion: typeof CONVERSATION_LIFECYCLE_SCHEMA_VERSION;
  readonly operation: "birth";
  readonly operationId: string;
  readonly conversationId: string;
  /** Canonical owner captured before the Ordinary Conversation is created. */
  readonly ownerKind: "space" | "workspace";
  readonly ownerId: string;
  readonly phase: ConversationBirthPhase;
  readonly lastErrorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ConversationDeleteRecord = {
  readonly schemaVersion: typeof CONVERSATION_LIFECYCLE_SCHEMA_VERSION;
  readonly operation: "delete";
  readonly operationId: string;
  readonly conversationId: string;
  readonly phase: ConversationDeletePhase;
  readonly lastErrorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ConversationLifecycleRecord =
  | ConversationBirthRecord
  | ConversationDeleteRecord;

export interface ConversationLifecycleJournal {
  list(): Promise<readonly ConversationLifecycleRecord[]>;
  getByConversation(conversationId: string): Promise<ConversationLifecycleRecord | undefined>;
  save(record: ConversationLifecycleRecord): Promise<void>;
  delete(operationId: string): Promise<void>;
}

const phaseSchema = z.enum([
  "prepared",
  "conversation_created",
  "processes_stopped",
  "conversation_deleted",
]);

const persistedRecordSchema = z.object({
  schemaVersion: z.literal(CONVERSATION_LIFECYCLE_SCHEMA_VERSION),
  operation: z.enum(["birth", "delete"]),
  operationId: z.string().uuid(),
  conversationId: z.string().min(1),
  ownerKind: z.enum(["space", "workspace"]).optional(),
  ownerId: z.string().min(1).optional(),
  phase: phaseSchema,
  lastErrorMessage: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict().superRefine((record, context) => {
  if (record.operation === "birth") {
    if (record.ownerKind === undefined || record.ownerId === undefined) {
      context.addIssue({ code: "custom", message: "birth records require canonical owner identity" });
    }
    if (record.phase !== "prepared" && record.phase !== "conversation_created") {
      context.addIssue({ code: "custom", path: ["phase"], message: "birth record has an invalid phase" });
    }
    return;
  }
  if (
    record.phase !== "prepared" &&
    record.phase !== "processes_stopped" &&
    record.phase !== "conversation_deleted"
  ) {
    context.addIssue({ code: "custom", path: ["phase"], message: "delete record has an invalid phase" });
  }
});

type JournalRow = {
  readonly schemaVersion: string;
  readonly operation: string;
  readonly operationId: string;
  readonly conversationId: string;
  readonly ownerKind: string | null;
  readonly ownerId: string | null;
  readonly phase: string;
  readonly lastErrorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export function createSqliteConversationLifecycleJournal(
  database: SqliteRuntimeDatabase,
): ConversationLifecycleJournal {
  database.migrate("conversation-lifecycle", [{
    version: 1,
    sql: `
      CREATE TABLE conversation_lifecycle_journal (
        operation_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        operation TEXT NOT NULL,
        conversation_id TEXT NOT NULL UNIQUE,
        owner_kind TEXT,
        owner_id TEXT,
        phase TEXT NOT NULL,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  }]);

  const selectColumns = `
    schema_version AS schemaVersion,
    operation,
    operation_id AS operationId,
    conversation_id AS conversationId,
    owner_kind AS ownerKind,
    owner_id AS ownerId,
    phase,
    last_error_message AS lastErrorMessage,
    created_at AS createdAt,
    updated_at AS updatedAt
  `;

  return {
    async list() {
      const rows = database.connection.prepare(`
        SELECT ${selectColumns}
        FROM conversation_lifecycle_journal
        ORDER BY created_at, operation_id
      `).all() as unknown as readonly JournalRow[];
      return rows.map(recordFromRow);
    },

    async getByConversation(conversationId) {
      const row = database.connection.prepare(`
        SELECT ${selectColumns}
        FROM conversation_lifecycle_journal
        WHERE conversation_id = ?
      `).get(conversationId) as JournalRow | undefined;
      return row === undefined ? undefined : recordFromRow(row);
    },

    async save(value) {
      const record = validateRecord(value);
      database.connection.prepare(`
        INSERT INTO conversation_lifecycle_journal(
          operation_id, schema_version, operation, conversation_id, owner_kind,
          owner_id, phase, last_error_message,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          operation = excluded.operation,
          conversation_id = excluded.conversation_id,
          owner_kind = excluded.owner_kind,
          owner_id = excluded.owner_id,
          phase = excluded.phase,
          last_error_message = excluded.last_error_message,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        record.operationId,
        record.schemaVersion,
        record.operation,
        record.conversationId,
        record.operation === "birth" ? record.ownerKind : null,
        record.operation === "birth" ? record.ownerId : null,
        record.phase,
        record.lastErrorMessage ?? null,
        record.createdAt,
        record.updatedAt,
      );
    },

    async delete(operationId) {
      database.connection.prepare(
        "DELETE FROM conversation_lifecycle_journal WHERE operation_id = ?",
      ).run(operationId);
    },
  };
}

export function newConversationBirthRecord(input: {
  readonly conversationId: string;
  readonly owner: { readonly kind: "space" | "workspace"; readonly id: string };
  readonly now: string;
  readonly operationId?: string;
}): ConversationBirthRecord {
  return validateRecord({
    schemaVersion: CONVERSATION_LIFECYCLE_SCHEMA_VERSION,
    operation: "birth",
    operationId: input.operationId ?? randomUUID(),
    conversationId: input.conversationId,
    ownerKind: input.owner.kind,
    ownerId: input.owner.id,
    phase: "prepared",
    createdAt: input.now,
    updatedAt: input.now,
  }) as ConversationBirthRecord;
}

export function newConversationDeleteRecord(input: {
  readonly conversationId: string;
  readonly now: string;
  readonly operationId?: string;
}): ConversationDeleteRecord {
  return validateRecord({
    schemaVersion: CONVERSATION_LIFECYCLE_SCHEMA_VERSION,
    operation: "delete",
    operationId: input.operationId ?? randomUUID(),
    conversationId: input.conversationId,
    phase: "prepared",
    createdAt: input.now,
    updatedAt: input.now,
  }) as ConversationDeleteRecord;
}

function recordFromRow(row: JournalRow): ConversationLifecycleRecord {
  return validateRecord({
    schemaVersion: row.schemaVersion,
    operation: row.operation,
    operationId: row.operationId,
    conversationId: row.conversationId,
    ...(row.ownerKind === null ? {} : { ownerKind: row.ownerKind }),
    ...(row.ownerId === null ? {} : { ownerId: row.ownerId }),
    phase: row.phase,
    ...(row.lastErrorMessage === null ? {} : { lastErrorMessage: row.lastErrorMessage }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function validateRecord(value: unknown): ConversationLifecycleRecord {
  const result = persistedRecordSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Conversation lifecycle journal is incompatible: ${z.prettifyError(result.error)}`);
  }
  const record = result.data;
  if (record.operation === "birth") {
    return {
      schemaVersion: CONVERSATION_LIFECYCLE_SCHEMA_VERSION,
      operation: "birth",
      operationId: record.operationId,
      conversationId: record.conversationId,
      ownerKind: record.ownerKind!,
      ownerId: record.ownerId!,
      phase: record.phase as ConversationBirthPhase,
      ...(record.lastErrorMessage === undefined ? {} : { lastErrorMessage: record.lastErrorMessage }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
  return {
    schemaVersion: CONVERSATION_LIFECYCLE_SCHEMA_VERSION,
    operation: "delete",
    operationId: record.operationId,
    conversationId: record.conversationId,
    phase: record.phase as ConversationDeletePhase,
    ...(record.lastErrorMessage === undefined ? {} : { lastErrorMessage: record.lastErrorMessage }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
