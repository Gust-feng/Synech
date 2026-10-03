import { nowIso } from "../../kernel/id.js";
import {
  COLLABORATION_RULES_MAX_CHARS,
  WORKSPACE_COLLABORATION_RULES_FILE_NAME,
  CollaborationRulesError,
  assertCollaborationRuleScope,
  type CollaborationRuleOwner,
  type CollaborationRuleScope,
  type CollaborationRulesDeleteInput,
  type CollaborationRulesDeleteResult,
  type CollaborationRulesFeature,
  type CollaborationRulesRepository,
  type CollaborationRulesWriteInput,
  type CollaborationRulesWriteResult,
} from "./contracts.js";
import { collaborationRuleScopeIdentity } from "./scope-identity.js";

/**
 * Managed-store owner of global/Space collaboration rules.
 *
 * Workspace rules are the root AGENTS.md of a mounted directory and are routed by
 * `CollaborationRulesApplication` through the Workspace rules port; this Feature
 * never stores a second copy of them. Model-visible startup assembly also lives in
 * the Application because it must consult that port.
 */
export function createCollaborationRulesFeature(input: {
  readonly repository: CollaborationRulesRepository;
  readonly now?: () => string;
  /** Shared Product Home lease used to make file snapshots coherent with backups. */
  readonly runStorageExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
}): CollaborationRulesFeature {
  const now = input.now ?? nowIso;
  const runStorageExclusive = input.runStorageExclusive ?? (async <T>(operation: () => Promise<T>) => await operation());
  const writeTails = new Map<string, Promise<void>>();
  const deletedOwners = new Set<string>();

  const enqueue = <T>(scope: CollaborationRuleScope, operation: () => Promise<T>): Promise<T> => {
    const key = collaborationRuleScopeIdentity(scope);
    const previous = writeTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    writeTails.set(key, tail);
    void tail.finally(() => {
      if (writeTails.get(key) === tail) writeTails.delete(key);
    });
    return result;
  };

  return {
    queries: {
      async get(scope) {
        assertCollaborationRuleScope(scope);
        assertManagedScope(scope);
        return await runStorageExclusive(async () => await input.repository.read(scope));
      },
    },
    commands: {
      async write(command: CollaborationRulesWriteInput): Promise<CollaborationRulesWriteResult> {
        assertCollaborationRuleScope(command.scope);
        assertManagedScope(command.scope);
        if (command.content.length > COLLABORATION_RULES_MAX_CHARS) {
          throw new CollaborationRulesError(
            "collaboration_rule_too_large",
            `Collaboration rules exceed ${COLLABORATION_RULES_MAX_CHARS} characters. Shorten the rules and save again.`,
          );
        }
        assertOwnerWritable(command.scope, deletedOwners);
        return await enqueue(command.scope, async () => await runStorageExclusive(async () =>
          await input.repository.write({ ...command, updatedAt: now() })));
      },
      async delete(command: CollaborationRulesDeleteInput): Promise<CollaborationRulesDeleteResult> {
        assertCollaborationRuleScope(command.scope);
        assertManagedScope(command.scope);
        assertOwnerWritable(command.scope, deletedOwners);
        return await enqueue(command.scope, async () => await runStorageExclusive(async () =>
          await input.repository.delete(command)));
      },
      async deleteByOwner(owner) {
        assertConcreteOwner(owner);
        const key = collaborationRuleScopeIdentity(owner);
        deletedOwners.add(key);
        await enqueue(owner, async () => await runStorageExclusive(async () =>
          await input.repository.deleteByOwner(owner)));
      },
    },
  };
}

/** Workspace scope is external; reaching the managed store with it is a wiring bug. */
function assertManagedScope(scope: CollaborationRuleScope): void {
  if (scope.kind !== "workspace") return;
  throw new CollaborationRulesError(
    "collaboration_rule_invalid_scope",
    `Workspace ${scope.id} rules are stored in its root ${WORKSPACE_COLLABORATION_RULES_FILE_NAME}; the managed store only holds global and Space rules.`,
  );
}

function assertConcreteOwner(owner: unknown): asserts owner is CollaborationRuleOwner {
  assertCollaborationRuleScope(owner);
  if (owner.kind === "global") {
    throw new CollaborationRulesError("collaboration_rule_invalid_scope", "Owner deletion requires a concrete Space or Workspace owner.");
  }
}

function assertOwnerWritable(scope: CollaborationRuleScope, deletedOwners: ReadonlySet<string>): void {
  if (scope.kind === "global") return;
  if (deletedOwners.has(collaborationRuleScopeIdentity(scope))) {
    throw new CollaborationRulesError(
      "collaboration_rule_owner_deleted",
      `The ${scope.kind} owner ${scope.id} is being deleted or has already been deleted; collaboration rules cannot be recreated.`,
    );
  }
}