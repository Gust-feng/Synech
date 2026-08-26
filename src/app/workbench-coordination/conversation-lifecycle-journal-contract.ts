import { randomUUID } from "node:crypto";

/** Durable records for creating and deleting an Ordinary Conversation. */
export const CONVERSATION_LIFECYCLE_SCHEMA_VERSION = "conversation-lifecycle/v1" as const;

export type ConversationBirthPhase = "prepared" | "conversation_created";

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

export type ConversationLifecycleRecord = ConversationBirthRecord | ConversationDeleteRecord;

export interface ConversationLifecycleJournal {
  list(): Promise<readonly ConversationLifecycleRecord[]>;
  getByConversation(conversationId: string): Promise<ConversationLifecycleRecord | undefined>;
  save(record: ConversationLifecycleRecord): Promise<void>;
  delete(operationId: string): Promise<void>;
}

export function newConversationBirthRecord(input: {
  readonly conversationId: string;
  readonly owner: { readonly kind: "space" | "workspace"; readonly id: string };
  readonly now: string;
  readonly operationId?: string;
}): ConversationBirthRecord {
  return {
    schemaVersion: CONVERSATION_LIFECYCLE_SCHEMA_VERSION,
    operation: "birth",
    operationId: input.operationId ?? randomUUID(),
    conversationId: input.conversationId,
    ownerKind: input.owner.kind,
    ownerId: input.owner.id,
    phase: "prepared",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function newConversationDeleteRecord(input: {
  readonly conversationId: string;
  readonly now: string;
  readonly operationId?: string;
}): ConversationDeleteRecord {
  return {
    schemaVersion: CONVERSATION_LIFECYCLE_SCHEMA_VERSION,
    operation: "delete",
    operationId: input.operationId ?? randomUUID(),
    conversationId: input.conversationId,
    phase: "prepared",
    createdAt: input.now,
    updatedAt: input.now,
  };
}
