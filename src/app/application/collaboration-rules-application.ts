import type { MemoryOwner } from "../../domain/memory/index.js";
import type { SpaceAdmission } from "../ownership/admission.js";
import {
  CollaborationRulesError,
  type CollaborationRulesDeleteInput,
  type CollaborationRulesDeleteResult,
  type CollaborationRulesDocument,
  type CollaborationRulesFeature,
  type CollaborationRulesWriteInput,
  type CollaborationRulesWriteResult,
} from "../collaboration-rules/index.js";

export type CollaborationRulesOwnerExistsQuery = {
  readonly isSpaceAvailable: (spaceId: string) => Promise<boolean>;
  readonly isWorkspaceAvailable: (workspaceId: string) => Promise<boolean>;
};

export type CollaborationRulesApplication = {
  get(scope: MemoryOwner): Promise<CollaborationRulesDocument>;
  write(input: CollaborationRulesWriteInput): Promise<CollaborationRulesWriteResult>;
  delete(input: CollaborationRulesDeleteInput): Promise<CollaborationRulesDeleteResult>;
};

/**
 * The sole user-facing mutation boundary for explicit collaboration rules.
 * A route may parse input and call one command; Space/Workspace admission and
 * owner revalidation remain here so stale browser scope cannot recreate rules
 * while a deletion workflow is active.
 */
export function createCollaborationRulesApplication(input: {
  readonly rules: CollaborationRulesFeature;
  readonly spaceAdmission: Pick<SpaceAdmission, "admit">;
  readonly workspaceAdmission: Pick<SpaceAdmission, "admit">;
  readonly ownerExistsQuery: CollaborationRulesOwnerExistsQuery;
}): CollaborationRulesApplication {
  const assertOwnerAvailable = async (scope: MemoryOwner): Promise<void> => {
    if (scope.kind === "global") return;
    const available = scope.kind === "space"
      ? await input.ownerExistsQuery.isSpaceAvailable(scope.id)
      : await input.ownerExistsQuery.isWorkspaceAvailable(scope.id);
    if (!available) {
      throw new CollaborationRulesError(
        "collaboration_rule_owner_deleted",
        `${scope.kind === "space" ? "Space" : "Workspace"} ${scope.id} is unavailable for collaboration rules.`,
      );
    }
  };

  const withinOwnerAdmission = async <T>(scope: MemoryOwner, operation: () => Promise<T>): Promise<T> => {
    if (scope.kind === "global") return await operation();
    const admission = scope.kind === "space" ? input.spaceAdmission : input.workspaceAdmission;
    return await admission.admit(scope.id, async () => {
      await assertOwnerAvailable(scope);
      return await operation();
    });
  };

  return {
    async get(scope) {
      await assertOwnerAvailable(scope);
      return await input.rules.queries.get(scope);
    },
    async write(command) {
      return await withinOwnerAdmission(command.scope, async () => await input.rules.commands.write(command));
    },
    async delete(command) {
      return await withinOwnerAdmission(command.scope, async () => await input.rules.commands.delete(command));
    },
  };
}
