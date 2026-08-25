import type { ConversationOwner } from "../../../domain/execution-scope/index.js";
import type { PersonalKnowledgeFeature } from "../../personal-knowledge/index.js";
import type {
  OrdinaryAgentFeature,
  OrdinaryRunBirth,
  OrdinaryRunInput,
  SubmitOrdinaryTurnResult,
} from "../../ordinary-agent/index.js";
import type { SpaceFeature } from "../../spaces/index.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import type { AgentNotesFeature } from "../../agent-notes/index.js";
import type { PathDependencyFeature } from "../../path-dependencies/index.js";
import {
  processCleanupHasUnresolvedStops,
  type InMemoryProcessRegistry,
  type ProcessTerminator,
} from "../../runtime-guard/process-registry.js";
import { WorkbenchCoordinationError } from "../../workbench-coordination/index.js";
import {
  newSpaceConversationDeletionRecord,
  type SpaceConversationDeletionCheckpoint,
  type SpaceConversationDeletionJournal,
  type SpaceConversationDeletionRecord,
} from "./space-conversation-deletion-journal.js";
import {
  newConversationBirthRecord,
  newConversationDeleteRecord,
  type ConversationBirthPhase,
  type ConversationBirthRecord,
  type ConversationDeletePhase,
  type ConversationDeleteRecord,
  type ConversationLifecycleJournal,
  type ConversationLifecycleRecord,
} from "./conversation-lifecycle-journal.js";

export type ConversationLifecycleCoordinator = {
  /** Settles incomplete Conversation birth and delete records before request admission. */
  ready(): Promise<void>;
  /** Rejects a new turn while a durable single-conversation deletion is unresolved. */
  assertConversationAvailable(conversationId: string): void;
  submit(input: {
    readonly owner: ConversationOwner;
    readonly submissionId: string;
    readonly runInput: OrdinaryRunInput;
    readonly birth: OrdinaryRunBirth;
  }): Promise<SubmitOrdinaryTurnResult>;
  deleteConversation(conversationId: string): Promise<void>;
};

/**
 * Host-owned coordination for Conversation birth and deletion. The journal lets
 * recovery finish lifecycle cleanup without ever
 * replaying a model turn or a Shell command.
 */
export function createConversationLifecycleCoordinator(input: {
  readonly ordinary: {
    readonly commands: Pick<OrdinaryAgentFeature["commands"], "submitTurn" | "deleteConversation">;
    readonly queries: Pick<OrdinaryAgentFeature["queries"], "getConversation" | "getConversationOwner">;
  };
  readonly workspaces?: {
    readonly queries: Pick<WorkspaceFeature["queries"], "get">;
  };
  readonly processes: Pick<InMemoryProcessRegistry, "cleanupByConversation">;
  readonly processTerminator: ProcessTerminator;
  readonly journal: ConversationLifecycleJournal;
  /** Host Workspace deletion admission gate for both new and existing-owner submits. */
  readonly workspaceAdmission?: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
  /** Host Space deletion admission gate for both new and existing-owner submits. */
  readonly spaceAdmission?: <T>(spaceId: string, operation: () => Promise<T>) => Promise<T>;
  readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly now?: () => string;
}): ConversationLifecycleCoordinator {
  const now = input.now ?? (() => new Date().toISOString());
  const runExclusive = input.runExclusive ?? (async <T>(operation: () => Promise<T>) => await operation());
  const deletingConversationIds = new Set<string>();
  let tail = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const resume = async (record: ConversationLifecycleRecord): Promise<void> => {
    try {
      if (record.operation === "birth") {
        await resumeBirth(record);
      } else {
        await resumeDelete(record);
      }
    } catch (error) {
      try {
        await saveOperationFailure(input.journal, record, error, now());
      } catch (journalError) {
        throw new AggregateError(
          [error, journalError],
          `Conversation ${record.operation} ${record.operationId} failed and its journal state could not be persisted.`,
        );
      }
      throw error;
    }
  };

  const resumeBirth = async (initial: ConversationBirthRecord): Promise<void> => {
    const conversation = await input.ordinary.queries.getConversation(initial.conversationId);
    if (conversation !== undefined) {
      const committed = await saveBirthCheckpoint(input.journal, initial, "conversation_created", now());
      await input.journal.delete(committed.operationId);
      return;
    }
    await input.journal.delete(initial.operationId);
  };

  const resumeDelete = async (initial: ConversationDeleteRecord): Promise<void> => {
    let record = initial;
    if (record.phase === "prepared") {
      assertProcessCleanupComplete(
        await input.processes.cleanupByConversation(record.conversationId, input.processTerminator),
        `Conversation ${record.conversationId}`,
      );
      record = await saveDeleteCheckpoint(input.journal, record, "processes_stopped", now());
    }
    if (record.phase === "processes_stopped") {
      await input.ordinary.commands.deleteConversation(record.conversationId);
      record = await saveDeleteCheckpoint(input.journal, record, "conversation_deleted", now());
    }
    await input.journal.delete(record.operationId);
  };

  return {
    ready() {
      return serialize(async () => await runExclusive(async () => {
        const records = await input.journal.list();
        for (const record of records) {
          if (record.operation === "delete") deletingConversationIds.add(record.conversationId);
        }
        for (const record of records) {
          await resume(record);
          if (record.operation === "delete") deletingConversationIds.delete(record.conversationId);
        }
      }));
    },
    assertConversationAvailable(conversationId) {
      if (deletingConversationIds.has(conversationId)) {
        throw new WorkbenchCoordinationError("conversation_deletion_in_progress", `Conversation ${conversationId} is being deleted.`);
      }
    },
    submit(submission) {
      const operation = () => serialize(async () => await runExclusive(async () => {
        const conversationId = `conversation:${submission.submissionId}`;
        if (deletingConversationIds.has(conversationId)) {
          throw new WorkbenchCoordinationError("conversation_deletion_in_progress", `Conversation ${conversationId} is being deleted.`);
        }
        const pending = await input.journal.getByConversation(conversationId);
        if (pending !== undefined) await resume(pending);

        const [existing, canonicalOwner] = await Promise.all([
          input.ordinary.queries.getConversation(conversationId),
          input.ordinary.queries.getConversationOwner(conversationId),
        ]);
        if (canonicalOwner !== undefined && (canonicalOwner.kind !== submission.owner.kind || canonicalOwner.id !== submission.owner.id)) {
          throw new WorkbenchCoordinationError(
            "conversation_owner_conflict",
            `Conversation ${conversationId} already belongs to ${canonicalOwner.kind} ${canonicalOwner.id}.`,
          );
        }
        if (existing !== undefined) {
          return await input.ordinary.commands.submitTurn({
            conversationId,
            owner: submission.owner,
            submissionId: submission.submissionId,
            input: submission.runInput,
            birth: submission.birth,
          });
        }
        if (submission.owner.kind === "workspace") {
          const workspace = await input.workspaces?.queries.get(submission.owner.id);
          if (workspace === undefined || workspace.status !== "available") {
            throw new WorkbenchCoordinationError("workspace_not_found", "所选工作区不存在或不可用。");
          }
        }

        const record = newConversationBirthRecord({
          conversationId,
          owner: submission.owner,
          now: now(),
        });
        await input.journal.save(record);
        try {
          const submitted = await input.ordinary.commands.submitTurn({
            newConversationId: conversationId,
            owner: submission.owner,
            submissionId: submission.submissionId,
            input: submission.runInput,
            birth: submission.birth,
          });
          const committed = await saveBirthCheckpoint(input.journal, record, "conversation_created", now());
          await input.journal.delete(committed.operationId);
          return submitted;
        } catch (error) {
          try {
            const current = await input.journal.getByConversation(conversationId) ?? record;
            await resume(current);
          } catch (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              `Conversation ${conversationId} creation failed and could not be reconciled.`,
            );
          }
          throw error;
        }
      }));
      if (submission.owner.kind === "workspace" && input.workspaceAdmission !== undefined) {
        return input.workspaceAdmission(submission.owner.id, operation);
      }
      if (submission.owner.kind === "space" && input.spaceAdmission !== undefined) {
        return input.spaceAdmission(submission.owner.id, operation);
      }
      return operation();
    },
    deleteConversation(conversationId) {
      deletingConversationIds.add(conversationId);
      return serialize(async () => await runExclusive(async () => {
        try {
          const pending = await input.journal.getByConversation(conversationId);
          if (pending !== undefined) {
            await resume(pending);
            if (pending.operation === "delete") {
              deletingConversationIds.delete(conversationId);
              return;
            }
          }
          const record = newConversationDeleteRecord({ conversationId, now: now() });
          await input.journal.save(record);
          await resume(record);
          deletingConversationIds.delete(conversationId);
        } catch (error) {
          try {
            const unresolved = await input.journal.getByConversation(conversationId);
            if (unresolved?.operation !== "delete") deletingConversationIds.delete(conversationId);
          } catch (journalError) {
            throw new AggregateError(
              [error, journalError],
              `Conversation ${conversationId} deletion failed and its journal state could not be inspected.`,
            );
          }
          throw error;
        }
      }));
    },
  };
}

export type SpaceConversationDeletionCoordinator = {
  /** Reconciles durable deletions before the Host starts accepting requests. */
  ready(): Promise<void>;
  isDeleting(spaceId: string): boolean;
  assertAvailable(spaceId: string): void;
  /** Serialize owner admission with the deletion snapshot and cascade. */
  admit<T>(spaceId: string, operation: () => Promise<T>): Promise<T>;
  deleteSpace(spaceId: string): Promise<void>;
};

/** Host-owned coordination for the only cross-feature Space deletion workflow. */
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
  /** Owner-scoped Agent Notes are removed through the feature command facade. */
  readonly agentNotes: Pick<AgentNotesFeature["commands"], "deleteByOwner">;
  /** Owner memory is purged before the Space itself is deleted. */
  readonly memory: Pick<PathDependencyFeature["commands"], "deleteByOwner">;
  readonly processes: Pick<InMemoryProcessRegistry, "cleanupBySpace">;
  readonly processTerminator: ProcessTerminator;
  readonly journal: SpaceConversationDeletionJournal;
  readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly now?: () => string;
}): SpaceConversationDeletionCoordinator {
  const now = input.now ?? (() => new Date().toISOString());
  const runExclusive = input.runExclusive ?? (async <T>(operation: () => Promise<T>) => await operation());
  const deletingSpaceIds = new Set<string>();
  const admissionTails = new Map<string, Promise<void>>();
  let tail = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const serializeAdmission = <T>(spaceId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = admissionTails.get(spaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const next = result.then(() => undefined, () => undefined);
    admissionTails.set(spaceId, next);
    void next.finally(() => {
      if (admissionTails.get(spaceId) === next) admissionTails.delete(spaceId);
    });
    return result;
  };

  const resume = async (initial: SpaceConversationDeletionRecord): Promise<void> => {
    let record = initial;
    if (record.phase === "cleanup_pending") {
      await input.journal.delete(record.deletionId);
      return;
    }
    let checkpoint = record.phase === "failed" ? record.resumeFrom : record.phase;
    if (checkpoint === undefined) {
      throw new Error(`Space deletion ${record.deletionId} has no resumable checkpoint.`);
    }
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
        for (const conversationId of record.conversationIds) {
          await input.ordinary.commands.deleteConversation(conversationId);
        }
        record = await saveCheckpoint(input.journal, record, "conversations_deleted", now());
        checkpoint = "conversations_deleted";
      }
      if (checkpoint === "conversations_deleted") {
        await input.memory.deleteByOwner({ kind: "space", id: record.spaceId });
        await input.agentNotes.deleteByOwner({ kind: "space", id: record.spaceId });
        const tree = await input.spaces.queries.getTree(record.spaceId);
        const referenceIds = record.referenceIds === undefined || record.referenceIds.length === 0
          ? (tree?.entries.map((entry) => entry.item.id) ?? [])
          : record.referenceIds;
        await input.personalKnowledge.commands.cleanupSpace({
          spaceId: record.spaceId,
          referenceIds,
        });
        record = await saveCheckpoint(input.journal, { ...record, referenceIds }, "knowledge_cleaned", now());
        checkpoint = "knowledge_cleaned";
      }
      if (checkpoint === "knowledge_cleaned") {
        if (await input.spaces.queries.getTree(record.spaceId) !== undefined) {
          await input.spaces.commands.deleteSpace(record.spaceId);
        }
        record = await saveCheckpoint(input.journal, record, "space_deleted", now());
        checkpoint = "space_deleted";
      }
    } catch (error) {
      const failed: SpaceConversationDeletionRecord = {
        ...record,
        phase: "failed",
        resumeFrom: checkpoint,
        errorMessage: errorMessage(error),
        updatedAt: now(),
      };
      try {
        await input.journal.save(failed);
      } catch (journalError) {
        throw new AggregateError(
          [error, journalError],
          `Space deletion ${record.deletionId} failed and its failure checkpoint could not be persisted.`,
        );
      }
      throw error;
    }

    try {
      await input.journal.delete(record.deletionId);
    } catch (error) {
      await input.journal.save({
        schemaVersion: record.schemaVersion,
        deletionId: record.deletionId,
        spaceId: record.spaceId,
        conversationIds: record.conversationIds,
        ...(record.referenceIds === undefined ? {} : { referenceIds: record.referenceIds }),
        phase: "cleanup_pending",
        createdAt: record.createdAt,
        updatedAt: now(),
      });
      throw error;
    }
  };

  return {
    ready() {
      return serialize(async () => {
        const records = await input.journal.list();
        for (const record of records) deletingSpaceIds.add(record.spaceId);
        for (const record of records) {
          await resume(record);
          deletingSpaceIds.delete(record.spaceId);
        }
      });
    },
    isDeleting: (spaceId) => deletingSpaceIds.has(spaceId),
    assertAvailable(spaceId) {
      if (deletingSpaceIds.has(spaceId)) {
        throw new WorkbenchCoordinationError("space_deletion_in_progress", `Space ${spaceId} is being deleted.`);
      }
    },
    admit(spaceId, operation) {
      // Reject after the in-memory marker is visible without waiting behind a
      // previously admitted operation. The first check only avoids needless
      // queueing: an operation that is merely queued must re-check the marker
      // and durable journal when its FIFO turn starts, so it may still be
      // rejected after deletion begins. Only the callback already in progress
      // is allowed to drain before the deletion snapshot.
      if (deletingSpaceIds.has(spaceId)) {
        return Promise.reject(new WorkbenchCoordinationError("space_deletion_in_progress", `Space ${spaceId} is being deleted.`));
      }
      return serializeAdmission(spaceId, async () => {
        if (deletingSpaceIds.has(spaceId)) {
          throw new WorkbenchCoordinationError("space_deletion_in_progress", `Space ${spaceId} is being deleted.`);
        }
        // A journal row is the durable deletion marker. This check also
        // protects a request arriving after restart but before `ready()` has
        // replayed the row into the in-memory set.
        if (await input.journal.getBySpace(spaceId) !== undefined) {
          deletingSpaceIds.add(spaceId);
          throw new WorkbenchCoordinationError("space_deletion_in_progress", `Space ${spaceId} is being deleted.`);
        }
        if (await input.spaces.queries.getTree(spaceId) === undefined) {
          throw new WorkbenchCoordinationError("space_not_found", `Space ${spaceId} was not found.`);
        }
        return operation();
      });
    },
    deleteSpace(spaceId) {
      deletingSpaceIds.add(spaceId);
      return serialize(async () => await serializeAdmission(spaceId, async () => await runExclusive(async () => {
          let record = await input.journal.getBySpace(spaceId);
          if (record === undefined) {
            const tree = await input.spaces.queries.getTree(spaceId);
            if (tree === undefined) {
              deletingSpaceIds.delete(spaceId);
              return;
            }
            // Capture owner conversations only after all admissions that
            // passed before the deletion marker have completed.
            const conversations = await input.ordinary.queries.listConversationsByOwner({ kind: "space", id: spaceId });
            const conversationIds = conversations.map((conversation) => conversation.conversationId);
            record = newSpaceConversationDeletionRecord({
              spaceId,
              conversationIds,
              referenceIds: tree.entries.map((entry) => entry.item.id),
              now: now(),
            });
            await input.journal.save(record);
          }
          await resume(record);
          deletingSpaceIds.delete(spaceId);
        })));
    },
  };
}

async function saveBirthCheckpoint(
  journal: ConversationLifecycleJournal,
  record: ConversationBirthRecord,
  phase: ConversationBirthPhase,
  updatedAt: string,
): Promise<ConversationBirthRecord> {
  if (record.phase === phase && record.lastErrorMessage === undefined) return record;
  const { lastErrorMessage: _discarded, ...stable } = record;
  const next: ConversationBirthRecord = { ...stable, phase, updatedAt };
  await journal.save(next);
  return next;
}

async function saveDeleteCheckpoint(
  journal: ConversationLifecycleJournal,
  record: ConversationDeleteRecord,
  phase: ConversationDeletePhase,
  updatedAt: string,
): Promise<ConversationDeleteRecord> {
  if (record.phase === phase && record.lastErrorMessage === undefined) return record;
  const { lastErrorMessage: _discarded, ...stable } = record;
  const next: ConversationDeleteRecord = { ...stable, phase, updatedAt };
  await journal.save(next);
  return next;
}

async function saveOperationFailure(
  journal: ConversationLifecycleJournal,
  record: ConversationLifecycleRecord,
  error: unknown,
  updatedAt: string,
): Promise<void> {
  // A checkpoint may have committed immediately before the following action
  // failed. Reload before recording the error so recovery never regresses it.
  const current = await journal.getByConversation(record.conversationId) ?? record;
  await journal.save({
    ...current,
    lastErrorMessage: errorMessage(error),
    updatedAt,
  });
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
  throw new WorkbenchCoordinationError(
    "background_process_stop_pending",
    `${owner} still has managed processes that could not be confirmed stopped: ${processIds.join(", ")}.`,
  );
}

async function saveCheckpoint(
  journal: SpaceConversationDeletionJournal,
  record: SpaceConversationDeletionRecord,
  phase: SpaceConversationDeletionCheckpoint,
  updatedAt: string,
): Promise<SpaceConversationDeletionRecord> {
  const next: SpaceConversationDeletionRecord = {
    schemaVersion: record.schemaVersion,
    deletionId: record.deletionId,
    spaceId: record.spaceId,
    conversationIds: record.conversationIds,
    ...(record.referenceIds === undefined ? {} : { referenceIds: record.referenceIds }),
    phase,
    createdAt: record.createdAt,
    updatedAt,
  };
  await journal.save(next);
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
