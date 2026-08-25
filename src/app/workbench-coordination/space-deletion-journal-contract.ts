/** Persistence port for the Workbench-owned Space deletion workflow. */
export const SPACE_CONVERSATION_DELETION_SCHEMA_VERSION = "space-conversation-deletion/v1" as const;

export type SpaceConversationDeletionCheckpoint =
  | "prepared"
  | "processes_stopped"
  | "conversations_deleted"
  | "knowledge_cleaned"
  | "space_deleted";

export type SpaceConversationDeletionPhase =
  | SpaceConversationDeletionCheckpoint
  | "cleanup_pending"
  | "failed";

export type SpaceConversationDeletionRecord = {
  readonly schemaVersion: typeof SPACE_CONVERSATION_DELETION_SCHEMA_VERSION;
  readonly deletionId: string;
  readonly spaceId: string;
  readonly conversationIds: readonly string[];
  /** Reference ids captured before Space deletion for Knowledge cleanup. */
  readonly referenceIds?: readonly string[];
  readonly phase: SpaceConversationDeletionPhase;
  readonly resumeFrom?: SpaceConversationDeletionCheckpoint;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export interface SpaceConversationDeletionJournal {
  list(): Promise<readonly SpaceConversationDeletionRecord[]>;
  getBySpace(spaceId: string): Promise<SpaceConversationDeletionRecord | undefined>;
  save(record: SpaceConversationDeletionRecord): Promise<void>;
  delete(deletionId: string): Promise<void>;
}
