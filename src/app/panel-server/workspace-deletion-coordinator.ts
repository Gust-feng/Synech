import type { OrdinaryAgentFeature } from "../ordinary-agent/index.js";
import type { WorkspaceFeature } from "../workspaces/index.js";
import type { AgentNotesFeature } from "../agent-notes/index.js";
import type { PathDependencyFeature } from "../path-dependencies/index.js";
import {
  processCleanupHasUnresolvedStops,
  type InMemoryProcessRegistry,
  type ProcessTerminator,
} from "../runtime-guard/process-registry.js";
import { PanelHttpError } from "./http-utils.js";

export type WorkspaceDeletionCoordinator = {
  ready(): Promise<void>;
  /** True only while the cascade is actively progressing (a failed cascade remains true). */
  isDeleting(workspaceId: string): boolean;
  /** Rejects both an active cascade and the terminal deleted owner. */
  assertAvailable(workspaceId: string): void;
  /**
   * Serialize the short run/conversation admission critical section with
   * Workspace deletion. This does not hold a lock for the model execution;
   * an operation that has entered its callback before the deletion marker is
   * committed is allowed to drain, while queued operations are rechecked and
   * may be rejected before they enter their callback.
   */
  admit<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
  deleteWorkspace(workspaceId: string): Promise<void>;
};

/**
 * Host-owned coordination for Workspace deletion（ADR-0035 §7.2）。
 *
 * The deleting marker is written before the cascade so new runs are denied.
 * The Workspace registration is purged only after conversations, owner memory,
 * and Space links have been cleaned successfully. A failed or interrupted
 * cascade keeps the durable deleting marker; startup restores that deny gate
 * and an explicit DELETE retries the idempotent cleanup. External folders and
 * Personal Knowledge copies are never deletion targets.
 */
export function createWorkspaceDeletionCoordinator(input: {
  readonly workspaces: {
    readonly commands: Pick<WorkspaceFeature["commands"], "deleteWorkspace" | "purgeWorkspace" | "unlinkWorkspaceFromSpace">;
    readonly queries: Pick<WorkspaceFeature["queries"], "get"> &
      Partial<Pick<WorkspaceFeature["queries"], "list">>;
  };
  readonly ordinary: {
    readonly commands: Pick<OrdinaryAgentFeature["commands"], "deleteConversation">;
    readonly queries: Pick<OrdinaryAgentFeature["queries"], "listConversationsByOwner">;
  };
  /** Owner-scoped Agent Notes are removed through the feature command facade. */
  readonly agentNotes: Pick<AgentNotesFeature["commands"], "deleteByOwner">;
  /** Optional until the memory feature is installed by the production root. */
  readonly memory?: Pick<PathDependencyFeature["commands"], "deleteByOwner">;
  readonly processes: Pick<InMemoryProcessRegistry, "cleanupByConversation">;
  readonly processTerminator: ProcessTerminator;
  /** Shared Product Home lease used by other cross-feature file mutations. */
  readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly now?: () => string;
}): WorkspaceDeletionCoordinator {
  const deletingWorkspaceIds = new Set<string>();
  // A successful cascade leaves a durable deleting tombstone in the feature,
  // but the in-process terminal set gives callers a stable 409 after purge.
  const deletedWorkspaceIds = new Set<string>();
  const admissionTails = new Map<string, Promise<void>>();
  const runExclusive = input.runExclusive ?? (async <T>(operation: () => Promise<T>) => await operation());
  let tail = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const serializeAdmission = <T>(workspaceId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = admissionTails.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const next = result.then(() => undefined, () => undefined);
    admissionTails.set(workspaceId, next);
    void next.finally(() => {
      if (admissionTails.get(workspaceId) === next) admissionTails.delete(workspaceId);
    });
    return result;
  };

  return {
    ready() {
      return serialize(async () => {
        // Rehydrate the deny gate before the server accepts requests. There is
        // deliberately no phase replay: without a durable cascade journal,
        // purging a deleting row on startup could orphan its conversations or
        // owner memory. Explicit DELETE remains the recovery operation.
        const workspaces = await input.workspaces.queries.list?.() ?? [];
        for (const workspace of workspaces) {
          if (workspace.status === "deleting") deletingWorkspaceIds.add(workspace.id);
        }
      });
    },
    isDeleting: (workspaceId) => deletingWorkspaceIds.has(workspaceId),
    assertAvailable(workspaceId) {
      if (deletingWorkspaceIds.has(workspaceId)) {
        throw new PanelHttpError(409, "workspace_deletion_in_progress", `工作区 ${workspaceId} 正在删除。`);
      }
      if (deletedWorkspaceIds.has(workspaceId)) {
        throw new PanelHttpError(409, "workspace_not_available", `工作区 ${workspaceId} 当前不可用。`);
      }
    },
    admit(workspaceId, operation) {
      // Reject after the deletion marker is visible without waiting behind an
      // already-admitted operation. A request is considered admitted only once
      // its FIFO callback starts; callbacks queued before the marker are
      // rechecked below and may be rejected instead of being drained.
      if (deletingWorkspaceIds.has(workspaceId)) {
        return Promise.reject(new PanelHttpError(409, "workspace_deletion_in_progress", `工作区 ${workspaceId} 正在删除。`));
      }
      if (deletedWorkspaceIds.has(workspaceId)) {
        return Promise.reject(new PanelHttpError(409, "workspace_not_available", `工作区 ${workspaceId} 当前不可用。`));
      }
      return serializeAdmission(workspaceId, async () => {
        if (deletingWorkspaceIds.has(workspaceId)) {
          throw new PanelHttpError(409, "workspace_deletion_in_progress", `工作区 ${workspaceId} 正在删除。`);
        }
        if (deletedWorkspaceIds.has(workspaceId)) {
          throw new PanelHttpError(409, "workspace_not_available", `工作区 ${workspaceId} 当前不可用。`);
        }
        const workspace = await input.workspaces.queries.get(workspaceId);
        if (workspace === undefined) {
          throw new PanelHttpError(404, "workspace_not_found", "工作区不存在。");
        }
        if (workspace.status !== "available") {
          throw new PanelHttpError(409, "workspace_not_available", `工作区 ${workspaceId} 当前不可用。`);
        }
        return operation();
      });
    },
    deleteWorkspace(workspaceId) {
      // Explicit DELETE is the retry path after a partial/terminal cascade.
      // Re-enter the active state while preserving the durable deleting marker.
      deletedWorkspaceIds.delete(workspaceId);
      deletingWorkspaceIds.add(workspaceId);
      return serialize(async () => await serializeAdmission(workspaceId, async () => await runExclusive(async () => {
        let workspaceMissing = false;
        let completed = false;
        try {
          const workspace = await input.workspaces.queries.get(workspaceId);
          if (workspace === undefined) {
            workspaceMissing = true;
            throw new PanelHttpError(404, "workspace_not_found", "工作区不存在。");
          }
          // Persist the deny marker before capturing owner resources. The
          // command is idempotent, so retries can resume a partial cascade.
          await input.workspaces.commands.deleteWorkspace(workspaceId);
          const conversations = await input.ordinary.queries.listConversationsByOwner({ kind: "workspace", id: workspaceId });
          for (const conversation of conversations) {
            assertProcessCleanupComplete(
              await input.processes.cleanupByConversation(conversation.conversationId, input.processTerminator),
              `Workspace ${workspaceId}`,
            );
            await input.ordinary.commands.deleteConversation(conversation.conversationId);
          }
          await input.memory?.deleteByOwner({ kind: "workspace", id: workspaceId });
          await input.agentNotes.deleteByOwner({ kind: "workspace", id: workspaceId });
          const activeLinks = workspace.links.filter((link) => link.status === "active");
          for (const link of activeLinks) {
            await input.workspaces.commands.unlinkWorkspaceFromSpace(link.linkId);
          }
          await input.workspaces.commands.purgeWorkspace(workspaceId);
          completed = true;
        } finally {
          // A failed cascade remains denied in this process so a retry can
          // finish the partial cleanup without admitting new owner data.
          if (completed || workspaceMissing) deletingWorkspaceIds.delete(workspaceId);
          if (completed) deletedWorkspaceIds.add(workspaceId);
          if (workspaceMissing) deletedWorkspaceIds.delete(workspaceId);
        }
      })));
    },
  };
}

function assertProcessCleanupComplete(
  cleanup: Awaited<ReturnType<InMemoryProcessRegistry["cleanupByConversation"]>>,
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
  throw new PanelHttpError(
    409,
    "background_process_stop_pending",
    `${owner} still has managed processes that could not be confirmed stopped: ${processIds.join(", ")}.`,
  );
}
