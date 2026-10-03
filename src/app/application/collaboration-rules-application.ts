import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import type { SpaceAdmission } from "../ownership/admission.js";
import {
  COLLABORATION_RULES_MAX_CHARS,
  COLLABORATION_RULES_WORKSPACE_MAX_TOKENS,
  CollaborationRulesApplicationError,
  CollaborationRulesError,
  type CollaborationRulesDeleteInput,
  type CollaborationRulesDeleteResult,
  type CollaborationRulesDocument,
  type CollaborationRulesFeature,
  type CollaborationRuleScope,
  type CollaborationRulesStartupSnapshot,
  type CollaborationRulesTokenCounter,
  type CollaborationRulesWriteInput,
  type CollaborationRulesWriteResult,
  type WorkspaceRulesPort,
} from "../collaboration-rules/index.js";

export {
  CollaborationRulesApplicationError,
  type CollaborationRulesApplicationErrorCode,
} from "../collaboration-rules/index.js";

export type CollaborationRulesOwnerExistsQuery = {
  readonly isSpaceAvailable: (spaceId: string) => Promise<boolean>;
  readonly isWorkspaceAvailable: (workspaceId: string) => Promise<boolean>;
};

export type CollaborationRulesApplication = {
  get(scope: CollaborationRuleScope): Promise<CollaborationRulesDocument>;
  write(input: CollaborationRulesWriteInput): Promise<CollaborationRulesWriteResult>;
  delete(input: CollaborationRulesDeleteInput): Promise<CollaborationRulesDeleteResult>;
  /** Model-visible standing context for one run: global plus the frozen owner scope. */
  startupSnapshot(owner: ConversationOwner): Promise<CollaborationRulesStartupSnapshot>;
};

export type CollaborationRulesApplicationDependencies = {
  readonly rules: CollaborationRulesFeature;
  readonly spaceAdmission: Pick<SpaceAdmission, "admit">;
  readonly workspaceAdmission: Pick<SpaceAdmission, "admit">;
  readonly ownerExistsQuery: CollaborationRulesOwnerExistsQuery;
  /** Absent when the Host has no Workspace rules capability; Workspace scope then reports unsupported. */
  readonly workspaceRules?: WorkspaceRulesPort;
  /** Host tokenizer for the Workspace budget (for example createOpenAITokenCounter(model).countText). */
  readonly countTokens: CollaborationRulesTokenCounter;
};

/**
 * The sole user-facing boundary for explicit collaboration rules.
 *
 * It owns scope routing, owner admission, the per-scope budget and the traceable
 * `source` fact. Managed documents go through `CollaborationRulesFeature`; Workspace
 * documents go through the narrow `WorkspaceRulesPort`, whose Host adapter owns the
 * mount identity check, the shared path lease and the CAS write. The Application
 * never touches paths, mounts, leases or the filesystem itself.
 */
export function createCollaborationRulesApplication(
  input: CollaborationRulesApplicationDependencies,
): CollaborationRulesApplication {
  const assertOwnerAvailable = async (scope: CollaborationRuleScope): Promise<void> => {
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

  const withinOwnerAdmission = async <T>(scope: CollaborationRuleScope, operation: () => Promise<T>): Promise<T> => {
    if (scope.kind === "global") return await operation();
    const admission = scope.kind === "space" ? input.spaceAdmission : input.workspaceAdmission;
    return await admission.admit(scope.id, async () => {
      await assertOwnerAvailable(scope);
      return await operation();
    });
  };

  const requireWorkspaceRules = (): WorkspaceRulesPort => {
    if (input.workspaceRules === undefined) {
      throw new CollaborationRulesApplicationError(
        "collaboration_rules_scope_unsupported",
        "This Host does not provide Workspace rule files, so Workspace scope is not supported.",
      );
    }
    return input.workspaceRules;
  };

  const readWorkspaceDocument = async (workspaceId: string): Promise<CollaborationRulesDocument> => {
    const document = await requireWorkspaceRules().get(workspaceId);
    assertWorkspaceCapacity(document.content);
    return document;
  };

  return {
    async get(scope) {
      await assertOwnerAvailable(scope);
      return scope.kind === "workspace"
        ? await readWorkspaceDocument(scope.id)
        : await readManagedDocument(input.rules, scope);
    },
    async write(command) {
      return await withinOwnerAdmission(command.scope, async () => {
        if (command.scope.kind !== "workspace") {
          assertManagedCapacity(command.content);
          return managedWriteResult(await input.rules.commands.write(command));
        }
        assertWorkspaceCapacity(command.content);
        return await requireWorkspaceRules().write({
          scope: command.scope,
          content: command.content,
          expectedVersion: command.expectedVersion,
        });
      });
    },
    async delete(command) {
      return await withinOwnerAdmission(command.scope, async () => {
        if (command.scope.kind !== "workspace") return managedDeleteResult(await input.rules.commands.delete(command));
        // The root AGENTS.md belongs to the user's directory: clearing writes empty
        // content and keeps the file. The Domain owner never unlinks it.
        return await requireWorkspaceRules().delete({
          scope: command.scope,
          expectedVersion: command.expectedVersion,
        });
      });
    },
    async startupSnapshot(owner) {
      const [global, local] = await Promise.all([
        readManagedDocument(input.rules, { kind: "global" }),
        readOwnerSnapshotDocument(owner),
      ]);
      return assembleStartupSnapshot(owner, global, local);
    },
  };

  /**
   * Run-birth read: a Workspace without the Host port has no rules to inject, so it
   * degrades instead of aborting the run. Over-budget content is still an explicit
   * capacity failure through `readWorkspaceDocument`.
   */
  async function readOwnerSnapshotDocument(owner: ConversationOwner): Promise<CollaborationRulesDocument | undefined> {
    // ConversationOwner is Space-only. Workspace AGENTS.md remains available
    // through the explicit Workspace collaboration-rules scope, but it must not
    // be smuggled into ConversationOwner/MemoryOwner or injected as a second
    // conversation owner here.
    return await readManagedDocument(input.rules, owner);
  }

  function assertManagedCapacity(content: string): void {
    if (content.length <= COLLABORATION_RULES_MAX_CHARS) return;
    throw new CollaborationRulesApplicationError(
      "collaboration_rules_capacity_exceeded",
      `Collaboration rules exceed ${COLLABORATION_RULES_MAX_CHARS} characters. Shorten the rules and save again.`,
    );
  }

  function assertWorkspaceCapacity(content: string): void {
    const tokens = input.countTokens(content);
    if (Number.isFinite(tokens) && tokens <= COLLABORATION_RULES_WORKSPACE_MAX_TOKENS) return;
    throw new CollaborationRulesApplicationError(
      "collaboration_rules_capacity_exceeded",
      `Workspace rules exceed ${COLLABORATION_RULES_WORKSPACE_MAX_TOKENS} tokens. Shorten the file and save again.`,
    );
  }
}

async function readManagedDocument(
  rules: CollaborationRulesFeature,
  scope: CollaborationRuleScope,
): Promise<CollaborationRulesDocument> {
  return asManagedDocument(await rules.queries.get(scope));
}

function managedWriteResult(result: CollaborationRulesWriteResult): CollaborationRulesWriteResult {
  return result.status === "conflict"
    ? { status: "conflict", current: asManagedDocument(result.current) }
    : { status: "saved", document: asManagedDocument(result.document) };
}

function managedDeleteResult(result: CollaborationRulesDeleteResult): CollaborationRulesDeleteResult {
  return result.status === "conflict"
    ? { status: "conflict", current: asManagedDocument(result.current) }
    : { status: "deleted", document: asManagedDocument(result.document) };
}

/** Every document leaves the Application with a traceable storage source. */
function asManagedDocument(document: CollaborationRulesDocument): CollaborationRulesDocument {
  return { ...document, source: { kind: "managed" } };
}

function assembleStartupSnapshot(
  owner: ConversationOwner,
  global: CollaborationRulesDocument,
  local: CollaborationRulesDocument | undefined,
): CollaborationRulesStartupSnapshot {
  const sections: string[] = [];
  if (global.content.trim().length > 0) sections.push(`## 全局协作规则\n\n${global.content.trim()}`);
  if (local !== undefined && local.content.trim().length > 0) {
    const heading = "当前 Space 协作规则";
    sections.push(`## ${heading}\n\n${local.content.trim()}`);
  }
  return {
    injection: sections.length === 0
      ? undefined
      : `[Standing collaboration rules]\n${sections.join("\n\n")}`,
  };
}