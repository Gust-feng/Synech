import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isFileNotFound, isTransientRenameError } from "../../kernel/values/index.js";
import {
  CollaborationRulesError,
  assertCollaborationRuleScope,
  type CollaborationRuleOwner,
  type CollaborationRuleScope,
  type CollaborationRulesDeleteInput,
  type CollaborationRulesDeleteResult,
  type CollaborationRulesDocument,
  type CollaborationRulesRepository,
} from "./contracts.js";
import { collaborationRuleContentVersion } from "./rule-version.js";
import { collaborationRuleScopeIdentity } from "./scope-identity.js";

/**
 * Durable Markdown storage for user-authored standing rules.
 *
 * ```text
 * <root>/global/RULES.md
 * <root>/spaces/<hash>/{RULES.md,owner.json}
 * <root>/workspaces/<hash>/{RULES.md,owner.json}
 * ```
 */
export function createFileSystemCollaborationRulesRepository(
  rootDir: string,
  options: {
    readonly rename?: (source: string, target: string) => Promise<void>;
    readonly waitBeforeRenameRetry?: (attempt: number) => Promise<void>;
  } = {},
): CollaborationRulesRepository {
  const rename = options.rename ?? fs.rename;
  const waitBeforeRenameRetry = options.waitBeforeRenameRetry ??
    ((attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, 25 * attempt)));
  return {
    async read(scope) {
      assertCollaborationRuleScope(scope);
      return await readDocument(rulePath(rootDir, scope), scope);
    },

    async write(input) {
      assertCollaborationRuleScope(input.scope);
      const file = rulePath(rootDir, input.scope);
      const directory = path.dirname(file);
      const temporaryDirectory = path.join(directory, ".tmp");
      const temporaryPath = path.join(
        temporaryDirectory,
        `RULES.md.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
      );
      let temporaryExists = false;
      try {
        await fs.mkdir(temporaryDirectory, { recursive: true });
        if (input.scope.kind !== "global") await writeOwnerMarker(directory, input.scope);
        await fs.writeFile(temporaryPath, input.content, { encoding: "utf8", mode: 0o600 });
        temporaryExists = true;
        const conflict = await replaceIfCurrent({
          source: temporaryPath,
          target: file,
          scope: input.scope,
          expectedVersion: input.expectedVersion,
          rename,
          waitBeforeRenameRetry,
        });
        if (conflict !== undefined) {
          await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
          temporaryExists = false;
          return { status: "conflict", current: conflict };
        }
        temporaryExists = false;
      } catch (error) {
        if (temporaryExists) await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        if (error instanceof CollaborationRulesError) throw error;
        throw new CollaborationRulesError("collaboration_rule_io_failure", `Collaboration-rule write failed: ${file}`, { cause: error });
      }
      return {
        status: "saved",
        document: {
          scope: input.scope,
          content: input.content,
          version: collaborationRuleContentVersion(input.content),
          updatedAt: input.updatedAt,
        },
      };
    },

    async delete(input) {
      assertCollaborationRuleScope(input.scope);
      const current = await readDocument(rulePath(rootDir, input.scope), input.scope);
      if (current.version !== input.expectedVersion) return { status: "conflict", current };
      const directory = path.dirname(rulePath(rootDir, input.scope));
      try {
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch (error) {
        throw new CollaborationRulesError("collaboration_rule_io_failure", `Collaboration-rule deletion failed: ${directory}`, { cause: error });
      }
      return {
        status: "deleted",
        document: {
          scope: input.scope,
          content: "",
          version: collaborationRuleContentVersion(""),
          updatedAt: undefined,
        },
      };
    },

    async deleteByOwner(owner) {
      assertCollaborationRuleScope(owner);
      if ((owner as CollaborationRuleScope).kind === "global") {
        throw new CollaborationRulesError("collaboration_rule_invalid_scope", "Owner deletion requires a concrete Space or Workspace owner.");
      }
      const directory = ownerDirectoryPath(rootDir, owner);
      try {
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch (error) {
        throw new CollaborationRulesError("collaboration_rule_io_failure", `Collaboration-rule deletion failed: ${directory}`, { cause: error });
      }
    },
  };
}

async function replaceIfCurrent(input: {
  readonly source: string;
  readonly target: string;
  readonly scope: CollaborationRuleScope;
  readonly expectedVersion: CollaborationRulesDocument["version"];
  readonly rename: (source: string, target: string) => Promise<void>;
  readonly waitBeforeRenameRetry: (attempt: number) => Promise<void>;
}): Promise<CollaborationRulesDocument | undefined> {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const current = await readDocument(input.target, input.scope);
    if (current.version !== input.expectedVersion) return current;
    try {
      await input.rename(input.source, input.target);
      return undefined;
    } catch (error) {
      if (attempt >= 6 || !isTransientRenameError(error)) throw error;
      await input.waitBeforeRenameRetry(attempt);
    }
  }
  throw new Error("Collaboration-rule rename retry exhausted without an outcome.");
}

async function readDocument(file: string, scope: CollaborationRuleScope): Promise<CollaborationRulesDocument> {
  try {
    const [content, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    return {
      scope,
      content,
      version: collaborationRuleContentVersion(content),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        scope,
        content: "",
        version: collaborationRuleContentVersion(""),
        updatedAt: undefined,
      };
    }
    throw new CollaborationRulesError("collaboration_rule_io_failure", `Collaboration-rule read failed: ${file}`, { cause: error });
  }
}

function rulePath(rootDir: string, scope: CollaborationRuleScope): string {
  return scope.kind === "global"
    ? path.join(rootDir, "global", "RULES.md")
    : path.join(ownerDirectoryPath(rootDir, scope), "RULES.md");
}

function ownerDirectoryPath(rootDir: string, owner: CollaborationRuleOwner): string {
  return path.join(rootDir, `${owner.kind}s`, ownerDirectoryName(owner));
}

function ownerDirectoryName(owner: CollaborationRuleOwner): string {
  return createHash("sha256")
    .update(collaborationRuleScopeIdentity(owner), "utf8")
    .digest("hex")
    .slice(0, 16);
}

async function writeOwnerMarker(directory: string, owner: CollaborationRuleOwner): Promise<void> {
  const marker = path.join(directory, "owner.json");
  try {
    await fs.access(marker);
    return;
  } catch {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(marker, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
