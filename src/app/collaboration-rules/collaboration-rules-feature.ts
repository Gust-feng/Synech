import { nowIso } from "../../kernel/id.js";
import {
  COLLABORATION_RULES_MAX_CHARS,
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
        return await runStorageExclusive(async () => await input.repository.read(scope));
      },
      async startupSnapshot(owner) {
        assertConcreteOwner(owner);
        const [global, local] = await runStorageExclusive(async () => await Promise.all([
          input.repository.read({ kind: "global" }),
          input.repository.read(owner),
        ]));
        const sections: string[] = [];
        if (global.content.trim().length > 0) sections.push(`## 全局协作规则\n\n${global.content.trim()}`);
        if (local.content.trim().length > 0) {
          const heading = owner.kind === "space" ? "当前 Space 协作规则" : "当前工作区协作规则";
          sections.push(`## ${heading}\n\n${local.content.trim()}`);
        }
        return {
          injection: sections.length === 0
            ? undefined
            : `[Standing collaboration rules]\n${sections.join("\n\n")}`,
        };
      },
    },
    commands: {
      async write(command: CollaborationRulesWriteInput): Promise<CollaborationRulesWriteResult> {
        assertCollaborationRuleScope(command.scope);
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
