import { randomUUID } from "node:crypto";
import type { PersonalKnowledgeFeature } from "../personal-knowledge/index.js";
import type { OrdinaryAgentFeature } from "../ordinary-agent/index.js";
import type { SpaceFeature } from "../spaces/index.js";
import type { AgentNotesFeature } from "../agent-notes/index.js";
import type { PathDependencyFeature } from "../path-dependencies/index.js";
import type { MemoryLifecycle } from "../memory/contracts.js";
import {
  processCleanupHasUnresolvedStops,
  type InMemoryProcessRegistry,
  type ProcessTerminator,
} from "../runtime-guard/process-registry.js";
import { WorkbenchCoordinationError, type SpaceKnowledgeDetachWorkflow } from "./contracts.js";
import {
  SPACE_CONVERSATION_DELETION_SCHEMA_VERSION,
  type SpaceConversationDeletionJournal,
  type SpaceConversationDeletionRecord,
} from "./space-deletion-journal-contract.js";

export type SpaceConversationDeletionCoordinator = {
  ready(): Promise<void>;
  isDeleting(spaceId: string): boolean;
  assertAvailable(spaceId: string): void;
  admit<T>(spaceId: string, operation: () => Promise<T>): Promise<T>;
  deleteSpace(spaceId: string, detachKnowledgeFromSpace?: SpaceKnowledgeDetachWorkflow): Promise<void>;
};

/**
 * Cross-feature Space deletion workflow. The journal is a persistence port;
 * this module owns ordering, admission and recovery while Space/Knowledge/
 * Ordinary own only their feature commands and queries.
 */
export function createSpaceConversationDeletionCoordinator(input: {
  readonly spaces: {
    readonly commands: Pick<SpaceFeature["commands"], "deleteSpace">;
    readonly queries: Pick<SpaceFeature["queries"], "getTree">;
  };
  readonly ordinary: {
    readonly commands: Pick<OrdinaryAgentFeature["commands"], "deleteConversation">;
    readonly queries: Pick<OrdinaryAgentFeature["queries"], "listConversationsByOwner">;
  };
  readonly personalKnowledge: {
    readonly commands: Pick<PersonalKnowledgeFeature["commands"], "cleanupSpace">;
  };
  readonly agentNotes: Pick<AgentNotesFeature["commands"], "deleteByOwner">;
  readonly memory: Pick<PathDependencyFeature["commands"], "deleteByOwner">;
  readonly memoryLifecycle: Pick<MemoryLifecycle, "prepareOwnerRemoval" | "finalizeOwnerRemoval">;
  readonly processes: Pick<InMemoryProcessRegistry, "cleanupBySpace">;
  readonly processTerminator: ProcessTerminator;
  readonly journal: SpaceConversationDeletionJournal;
  readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly now?: () => string;
}): SpaceConversationDeletionCoordinator {
  const now = input.now ?? (() => new Date().toISOString());
  const runExclusive = input.runExclusive ?? (async <T>(operation: () => Promise<T>) => await operation());
  const defaultDetachKnowledgeFromSpace: SpaceKnowledgeDetachWorkflow = async (detachInput) =>
    await input.personalKnowledge.commands.cleanupSpace(detachInput);
  const deleting = new Set<string>();
  const admissionTails = new Map<string, Promise<void>>();
  let tail = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const admitInOrder = <T>(spaceId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = admissionTails.get(spaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const next = result.then(() => undefined, () => undefined);
    admissionTails.set(spaceId, next);
    void next.finally(() => {
      if (admissionTails.get(spaceId) === next) admissionTails.delete(spaceId);
    });
    return result;
  };
  const deletingError = (id: string) => new WorkbenchCoordinationError("space_deletion_in_progress", `Space ${id} is being deleted.`);

  const resume = async (
    initial: SpaceConversationDeletionRecord,
    detachKnowledgeFromSpace: SpaceKnowledgeDetachWorkflow = defaultDetachKnowledgeFromSpace,
  ): Promise<void> => {
    let record = initial;
    if (record.phase === "cleanup_pending") {
      await input.journal.delete(record.deletionId);
      return;
    }
    let checkpoint = record.phase === "failed" ? record.resumeFrom : record.phase;
    if (checkpoint === undefined) throw new Error(`Space deletion ${record.deletionId} has no resumable checkpoint.`);
    try {
      if (checkpoint === "prepared") {
        assertProcessCleanupComplete(
          await input.processes.cleanupBySpace(record.spaceId, input.processTerminator),
          `Space ${record.spaceId}`,
        );
        record = await saveCheckpoint(input.journal, record, "processes_stopped", now());
        checkpoint = "processes_stopped";
      }
      if (checkpoint === "processes_stopped") {
        for (const conversationId of record.conversationIds) await input.ordinary.commands.deleteConversation(conversationId);
        record = await saveCheckpoint(input.journal, record, "conversations_deleted", now());
        checkpoint = "conversations_deleted";
      }
      if (checkpoint === "conversations_deleted") {
        await input.memory.deleteByOwner({ kind: "space", id: record.spaceId });
        await input.agentNotes.deleteByOwner({ kind: "space", id: record.spaceId });
        // Memory v2：两阶段 durable fence（generation bump → tombstone），紧邻执行且对 resume 幂等。
        const memoryRemovalTicket = await input.memoryLifecycle.prepareOwnerRemoval({ kind: "space", id: record.spaceId });
        await input.memoryLifecycle.finalizeOwnerRemoval(memoryRemovalTicket);
        const tree = await input.spaces.queries.getTree(record.spaceId);
        const referenceIds = record.referenceIds === undefined || record.referenceIds.length === 0
          ? (tree?.entries.map((entry) => entry.item.id) ?? [])
          : record.referenceIds;
        await detachKnowledgeFromSpace({ spaceId: record.spaceId, referenceIds });
        record = await saveCheckpoint(input.journal, { ...record, referenceIds }, "knowledge_cleaned", now());
        checkpoint = "knowledge_cleaned";
      }
      if (checkpoint === "knowledge_cleaned") {
        if (await input.spaces.queries.getTree(record.spaceId) !== undefined) {
          await input.spaces.commands.deleteSpace(record.spaceId);
        }
        record = await saveCheckpoint(input.journal, record, "space_deleted", now());
      }
    } catch (error) {
      try {
        await input.journal.save({ ...record, phase: "failed", resumeFrom: checkpoint, errorMessage: errorMessage(error), updatedAt: now() });
      } catch (journalError) {
        throw new AggregateError([error, journalError], `Space deletion ${record.deletionId} failed and its failure checkpoint could not be persisted.`);
      }
      throw error;
    }
    try {
      await input.journal.delete(record.deletionId);
    } catch (error) {
      const { resumeFrom: _resumeFrom, errorMessage: _errorMessage, ...stable } = record;
      await input.journal.save({
        ...stable,
        phase: "cleanup_pending",
        updatedAt: now(),
      });
      throw error;
    }
  };

  return {
    ready() {
      return serialize(async () => {
        const records = await input.journal.list();
        for (const record of records) deleting.add(record.spaceId);
        for (const record of records) {
          await resume(record);
          deleting.delete(record.spaceId);
        }
      });
    },
    isDeleting: (spaceId) => deleting.has(spaceId),
    assertAvailable(spaceId) {
      if (deleting.has(spaceId)) throw deletingError(spaceId);
    },
    admit(spaceId, operation) {
      if (deleting.has(spaceId)) return Promise.reject(deletingError(spaceId));
      return admitInOrder(spaceId, async () => {
        if (deleting.has(spaceId)) throw deletingError(spaceId);
        if (await input.journal.getBySpace(spaceId) !== undefined) {
          deleting.add(spaceId);
          throw deletingError(spaceId);
        }
        if (await input.spaces.queries.getTree(spaceId) === undefined) {
          throw new WorkbenchCoordinationError("space_not_found", `Space ${spaceId} was not found.`);
        }
        return operation();
      });
    },
    deleteSpace(spaceId, detachKnowledgeFromSpace = defaultDetachKnowledgeFromSpace) {
      deleting.add(spaceId);
      return serialize(() => admitInOrder(spaceId, () => runExclusive(async () => {
        let record = await input.journal.getBySpace(spaceId);
        if (record === undefined) {
          const tree = await input.spaces.queries.getTree(spaceId);
          if (tree === undefined) {
            deleting.delete(spaceId);
            return;
          }
          const conversations = await input.ordinary.queries.listConversationsByOwner({ kind: "space", id: spaceId });
          record = {
            schemaVersion: SPACE_CONVERSATION_DELETION_SCHEMA_VERSION,
            deletionId: randomUUID(),
            spaceId,
            conversationIds: [...new Set(conversations.map((conversation) => conversation.conversationId))],
            referenceIds: [...new Set(tree.entries.map((entry) => entry.item.id))],
            phase: "prepared",
            createdAt: now(),
            updatedAt: now(),
          };
          await input.journal.save(record);
        }
        await resume(record, detachKnowledgeFromSpace);
        deleting.delete(spaceId);
      })));
    },
  };
}

function assertProcessCleanupComplete(
  cleanup: Awaited<ReturnType<InMemoryProcessRegistry["cleanupBySpace"]>>,
  owner: string,
): void {
  if (!processCleanupHasUnresolvedStops(cleanup)) return;
  const processIds = [
    ...cleanup.attempted
      .filter((attempt) => attempt.outcome === "unknown" || attempt.outcome === "error")
      .map((attempt) => attempt.processId),
    ...cleanup.skipped
      .filter((skip) => skip.reason !== "inactive_status")
      .map((skip) => skip.processId),
  ];
  throw new WorkbenchCoordinationError("background_process_stop_pending", `${owner} still has managed processes that could not be confirmed stopped: ${processIds.join(", ")}.`);
}

async function saveCheckpoint(
  journal: SpaceConversationDeletionJournal,
  record: SpaceConversationDeletionRecord,
  phase: "processes_stopped" | "conversations_deleted" | "knowledge_cleaned" | "space_deleted",
  updatedAt: string,
): Promise<SpaceConversationDeletionRecord> {
  const { resumeFrom: _resumeFrom, errorMessage: _errorMessage, ...stable } = record;
  const next: SpaceConversationDeletionRecord = {
    ...stable,
    phase,
    updatedAt,
  };
  await journal.save(next);
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
