import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import type {
  OrdinaryAgentFeature,
  OrdinaryRunBirth,
  OrdinaryRunInput,
  SubmitOrdinaryTurnResult,
} from "../ordinary-agent/index.js";
import {
  processCleanupHasUnresolvedStops,
  type InMemoryProcessRegistry,
  type ProcessTerminator,
} from "../runtime-guard/process-registry.js";
import type { WorkspaceFeature } from "../workspaces/index.js";
import type { RemovalTicket } from "../memory/contracts.js";
import { WorkbenchCoordinationError } from "./contracts.js";
import {
  newConversationBirthRecord,
  newConversationDeleteRecord,
  type ConversationBirthPhase,
  type ConversationBirthRecord,
  type ConversationDeletePhase,
  type ConversationDeleteRecord,
  type ConversationLifecycleJournal,
  type ConversationLifecycleRecord,
} from "./conversation-lifecycle-journal-contract.js";

export type ConversationLifecycleCoordinator = {
  /** Settles incomplete Conversation birth and delete records before request admission. */
  ready(): Promise<void>;
  /** Rejects a new turn while a durable single-conversation deletion is unresolved. */
  assertConversationAvailable(conversationId: string): void;
  /** Serializes owner-scoped mutations with conversation deletion. */
  admitConversation<T>(conversationId: string, operation: () => Promise<T>): Promise<T>;
  submit(input: {
    readonly owner: ConversationOwner;
    readonly submissionId: string;
    readonly runInput: OrdinaryRunInput;
    readonly birth: OrdinaryRunBirth;
  }): Promise<SubmitOrdinaryTurnResult>;
  deleteConversation(conversationId: string): Promise<void>;
};

/**
 * Cross-feature Conversation birth and deletion workflow. The journal and
 * process registry are ports; Ordinary remains the Conversation owner.
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
  readonly workspaceAdmission?: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
  readonly spaceAdmission?: <T>(spaceId: string, operation: () => Promise<T>) => Promise<T>;
  /**
   * Memory v2 lifecycle wraps the raw Conversation deletion: prepare fences
   * capture/recall before Ordinary removal, finalize purges only afterwards.
   */
  readonly prepareConversationRemoval?: (conversationId: string) => Promise<RemovalTicket>;
  readonly finalizeConversationRemoval?: (ticket: RemovalTicket) => Promise<void>;
  readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly now?: () => string;
}): ConversationLifecycleCoordinator {
  const now = input.now ?? (() => new Date().toISOString());
  const runExclusive = input.runExclusive ?? (async <T>(operation: () => Promise<T>) => await operation());
  const deletingConversationIds = new Set<string>();
  const admissionTails = new Map<string, Promise<void>>();
  let tail = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const admitInOrder = <T>(conversationId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = admissionTails.get(conversationId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const next = result.then(() => undefined, () => undefined);
    admissionTails.set(conversationId, next);
    void next.finally(() => {
      if (admissionTails.get(conversationId) === next) admissionTails.delete(conversationId);
    });
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
    // The durable journal is the deletion admission point. Fence Memory before
    // stopping processes or removing Ordinary data, but do not re-fence a
    // checkpoint that already completed the physical memory purge.
    const memoryRemovalTicket = record.phase === "conversation_deleted"
      ? undefined
      : await input.prepareConversationRemoval?.(record.conversationId);
    if (record.phase === "prepared") {
      assertProcessCleanupComplete(
        await input.processes.cleanupByConversation(record.conversationId, input.processTerminator),
        `Conversation ${record.conversationId}`,
      );
      record = await saveDeleteCheckpoint(input.journal, record, "processes_stopped", now());
    }
    if (record.phase === "processes_stopped") {
      await input.ordinary.commands.deleteConversation(record.conversationId);
      if (memoryRemovalTicket !== undefined) {
        await input.finalizeConversationRemoval?.(memoryRemovalTicket);
      }
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
    admitConversation(conversationId, operation) {
      if (deletingConversationIds.has(conversationId)) {
        return Promise.reject(new WorkbenchCoordinationError(
          "conversation_deletion_in_progress",
          `Conversation ${conversationId} is being deleted.`,
        ));
      }
      return admitInOrder(conversationId, operation);
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
      return serialize(async () => await admitInOrder(conversationId, async () => await runExclusive(async () => {
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
  const current = await journal.getByConversation(record.conversationId) ?? record;
  await journal.save({ ...current, lastErrorMessage: errorMessage(error), updatedAt });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
