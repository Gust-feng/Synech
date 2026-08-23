import { nowIso } from "../../kernel/id.js";
import {
  AGENT_NOTE_MAX_CHARS,
  assertAgentNoteScope,
  AgentNotesError,
  type AgentNoteRepository,
  type AgentNoteOwner,
  type AgentNoteDeleteInput,
  type AgentNoteDeleteResult,
  type AgentNoteScope,
  type AgentNotesFeature,
} from "./contracts.js";
import { agentNoteScopeIdentity } from "./scope-identity.js";

export type CreateAgentNotesFeatureInput = {
  readonly repository: AgentNoteRepository;
  readonly now?: () => string;
};

/**
 * Agent 笔记 feature（ADR-0033）。
 *
 * 职责刻意保持最小：读、写、组装启动注入。什么值得记、笔记怎么组织是模型的
 * 判断；用户的治理权是直接查看和编辑文件。这里不做自动总结、不做关键词过滤、
 * 不做审批状态机。
 */
export function createAgentNotesFeature(input: CreateAgentNotesFeatureInput): AgentNotesFeature {
  const now = input.now ?? nowIso;
  const writeTails = new Map<string, Promise<void>>();
  /**
   * Owner identity is stable for the lifetime of a Space / Workspace. Once a
   * cascade starts, no late tool call may recreate its notebook behind the
   * deletion coordinator. The owning feature must create a new identity when
   * a resource is recreated; this set intentionally has no "undelete" path.
   */
  const deletedOwners = new Set<string>();

  const enqueueWrite = <T>(scope: AgentNoteScope, operation: () => Promise<T>): Promise<T> => {
    const key = agentNoteScopeIdentity(scope);
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
      async get(scope: AgentNoteScope) {
        assertAgentNoteScope(scope);
        return input.repository.read(scope);
      },

      async startupSnapshot(owner: AgentNoteOwner) {
        assertAgentNoteScope(owner);
        const [global, ownerNotebook] = await Promise.all([
          input.repository.read({ kind: "global" }),
          input.repository.read(owner),
        ]);
        const sections: string[] = [];
        if (global.content.trim().length > 0) {
          sections.push(`## 全局笔记\n\n${global.content.trim()}`);
        }
        if (ownerNotebook.content.trim().length > 0) {
          sections.push(`## ${ownerHeading(owner)}\n\n${ownerNotebook.content.trim()}`);
        }
        return {
          injection: sections.length === 0 ? undefined : sections.join("\n\n"),
          versions: {
            global: global.version,
            owner: {
              scope: owner,
              version: ownerNotebook.version,
            },
          },
        };
      },
    },

    commands: {
      async write(command) {
        assertAgentNoteScope(command.scope);
        if (command.content.length > AGENT_NOTE_MAX_CHARS) {
          // 显式失败而不是静默截断：让模型自己收到边界并整理笔记（ADR-0033 §3）。
          throw new AgentNotesError(
            "note_too_large",
            `Note is ${command.content.length} chars; the limit is ${AGENT_NOTE_MAX_CHARS}. ` +
            "Condense the note (merge duplicates, drop stale entries) and write the full revised note again.",
          );
        }
        assertOwnerWritable(command.scope, deletedOwners);
        return enqueueWrite(command.scope, () => input.repository.write({
          ...command,
          updatedAt: now(),
        }));
      },

      async delete(command: AgentNoteDeleteInput): Promise<AgentNoteDeleteResult> {
        assertAgentNoteScope(command.scope);
        assertOwnerWritable(command.scope, deletedOwners);
        return enqueueWrite(command.scope, () => input.repository.delete(command));
      },

      async deleteByOwner(owner) {
        assertConcreteOwner(owner);
        // Mark before the first await. Writes already admitted to the owner
        // FIFO finish before deletion; every later write is rejected instead
        // of being queued behind the physical rm and recreating the notebook.
        deletedOwners.add(agentNoteScopeIdentity(owner));
        await enqueueWrite(owner, () => input.repository.deleteByOwner(owner));
      },
    },
  };
}

function ownerHeading(owner: AgentNoteOwner): string {
  return owner.kind === "space" ? "当前空间笔记" : "当前工作区笔记";
}

function assertConcreteOwner(owner: AgentNoteOwner): void {
  // The public type excludes global, but this boundary is also called from
  // JavaScript/host adapters. Keep the invariant explicit so a malformed
  // deletion can never target the global notebook.
  const candidate = owner as { readonly kind?: unknown; readonly id?: unknown } | null | undefined;
  if (candidate === undefined || candidate === null || candidate.kind === "global" ||
      (candidate.kind !== "space" && candidate.kind !== "workspace") ||
      typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new AgentNotesError(
      "note_invalid_owner",
      "Owner deletion requires a concrete Space or Workspace owner.",
    );
  }
}

function assertOwnerWritable(scope: AgentNoteScope, deletedOwners: ReadonlySet<string>): void {
  if (scope.kind === "global") return;
  if (deletedOwners.has(agentNoteScopeIdentity(scope))) {
    throw new AgentNotesError(
      "note_owner_deleted",
      `The ${scope.kind} owner ${scope.id} is being deleted or has already been deleted; owner notes cannot be recreated.`,
    );
  }
}
