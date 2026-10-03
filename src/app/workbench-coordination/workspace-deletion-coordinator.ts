import type { SpaceFeature } from "../spaces/index.js";
import type { CollaborationRulesFeature } from "../collaboration-rules/index.js";
import type { WorkspaceFeature } from "../workspaces/index.js";
import { withOrderedSpaceAdmissions } from "../ownership/admission.js";
import { WorkbenchCoordinationError } from "./contracts.js";

/**
 * Cross-feature Workspace deletion workflow.
 *
 * This module is deliberately owned by WorkbenchCoordination. Workspace,
 * Space, Ordinary and the owner-scoped stores expose only their commands and
 * queries; none of them decides the cascade order or its admission policy.
 */
export type WorkspaceDeletionCoordinator = {
  ready(): Promise<void>;
  isDeleting(workspaceId: string): boolean;
  assertAvailable(workspaceId: string): void;
  admit<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
  deleteWorkspace(workspaceId: string): Promise<void>;
};

export function createWorkspaceDeletionCoordinator(input: {
  readonly workspaces: {
    readonly commands: Pick<WorkspaceFeature["commands"], "deleteWorkspace" | "purgeWorkspace">;
    readonly queries: Pick<WorkspaceFeature["queries"], "get"> &
      Partial<Pick<WorkspaceFeature["queries"], "listAll">>;
  };
  readonly spaces: {
    readonly commands: Pick<SpaceFeature["commands"], "unlinkReference">;
    readonly queries: Pick<SpaceFeature["queries"], "listReferencesByWorkspace" | "getReference">;
  };
  readonly spaceAdmission: { admit<T>(spaceId: string, operation: () => Promise<T>): Promise<T> };
  readonly collaborationRules: Pick<CollaborationRulesFeature["commands"], "deleteByOwner">;
  readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly runWorkspaceExclusive?: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
}): WorkspaceDeletionCoordinator {
  const deleting = new Set<string>();
  const deleted = new Set<string>();
  const admissionTails = new Map<string, Promise<void>>();
  const runExclusive = input.runExclusive ?? (async <T>(operation: () => Promise<T>) => await operation());
  const runWorkspaceExclusive = input.runWorkspaceExclusive ?? (async <T>(_id: string, operation: () => Promise<T>) => await operation());
  const spaceAdmission = input.spaceAdmission;
  let tail = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const admitInOrder = <T>(workspaceId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = admissionTails.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const next = result.then(() => undefined, () => undefined);
    admissionTails.set(workspaceId, next);
    void next.finally(() => {
      if (admissionTails.get(workspaceId) === next) admissionTails.delete(workspaceId);
    });
    return result;
  };
  const deletingError = (id: string) => new WorkbenchCoordinationError("workspace_deletion_in_progress", `工作区 ${id} 正在删除。`);
  const unavailableError = (id: string) => new WorkbenchCoordinationError("workspace_not_available", `工作区 ${id} 当前不可用。`);

  return {
    ready() {
      return serialize(async () => {
        const workspaces = await input.workspaces.queries.listAll?.() ?? [];
        for (const workspace of workspaces) {
          if (workspace.status === "deleting") deleting.add(workspace.id);
        }
      });
    },
    isDeleting: (workspaceId) => deleting.has(workspaceId),
    assertAvailable(workspaceId) {
      if (deleting.has(workspaceId)) throw deletingError(workspaceId);
      if (deleted.has(workspaceId)) throw unavailableError(workspaceId);
    },
    admit(workspaceId, operation) {
      if (deleting.has(workspaceId)) return Promise.reject(deletingError(workspaceId));
      if (deleted.has(workspaceId)) return Promise.reject(unavailableError(workspaceId));
      return admitInOrder(workspaceId, async () => {
        if (deleting.has(workspaceId)) throw deletingError(workspaceId);
        if (deleted.has(workspaceId)) throw unavailableError(workspaceId);
        const workspace = await input.workspaces.queries.get(workspaceId);
        if (workspace === undefined) {
          throw new WorkbenchCoordinationError("workspace_not_found", "工作区不存在。");
        }
        if (workspace.status !== "available") throw unavailableError(workspaceId);
        return operation();
      });
    },
    deleteWorkspace(workspaceId) {
      // DELETE is also the explicit retry/recovery command after a partial
      // cascade. Keep the owner denied until every phase has succeeded.
      deleted.delete(workspaceId);
      deleting.add(workspaceId);
      return serialize(() => admitInOrder(workspaceId, async () => {
        const referencesBeforeLease = await input.spaces.queries.listReferencesByWorkspace(workspaceId);
        const spaceIds = [...new Set(referencesBeforeLease.map((reference) => reference.spaceId))];
        return await withOrderedSpaceAdmissions(spaceAdmission, spaceIds, async () => await runExclusive(() =>
          runWorkspaceExclusive(workspaceId, async () => {
          let completed = false;
          try {
            const workspace = await input.workspaces.queries.get(workspaceId);
            if (workspace === undefined) {
              // Workspace is a filesystem resource, not a Conversation or
              // Memory owner. If its registration is already gone, the
              // resource deletion is converged; no owner-scoped Memory or
              // Conversation cleanup is allowed here.
              completed = true;
              return;
            }
            await input.workspaces.commands.deleteWorkspace(workspaceId);
            // Conversation and Memory are Space-owned. Workspace deletion only
            // removes the external resource registration and its references;
            // it never cascades into Space-owned conversations or memory.
            await input.collaborationRules.deleteByOwner({ kind: "workspace", id: workspaceId });
            const references = await input.spaces.queries.listReferencesByWorkspace(workspaceId);
            for (const reference of references) {
              if (!spaceIds.includes(reference.spaceId)) {
                throw new WorkbenchCoordinationError(
                  "workspace_reference_membership_changed",
                  `Workspace ${workspaceId} reference ${reference.id} changed Space membership while deletion was waiting.`,
                );
              }
              const current = await input.spaces.queries.getReference(reference.id);
              if (current === undefined) continue;
              if (current.spaceId !== reference.spaceId || current.reference.kind !== "workspace" || current.reference.workspaceId !== workspaceId) {
                throw new WorkbenchCoordinationError(
                  "workspace_reference_membership_changed",
                  `Workspace ${workspaceId} reference ${reference.id} changed while deletion was waiting.`,
                );
              }
              await input.spaces.commands.unlinkReference(current.id);
            }
            await input.workspaces.commands.purgeWorkspace(workspaceId);
            completed = true;
          } finally {
            if (completed) {
              deleting.delete(workspaceId);
              deleted.add(workspaceId);
            }
          }
          }),
        ));
      }));
    },
  };
}
