import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isFileNotFound, isTransientRenameError } from "../../kernel/values/index.js";
import {
  AgentNotesError,
  assertAgentNoteScope,
  type AgentNoteDeleteInput,
  type AgentNoteDeleteResult,
  type AgentNoteOwner,
  type AgentNoteRepository,
  type AgentNoteScope,
  type AgentNotebook,
} from "./contracts.js";
import { agentNoteContentVersion } from "./note-version.js";
import { agentNoteScopeIdentity } from "./scope-identity.js";

/**
 * 笔记的文件系统存储。
 *
 * 布局（`<root>` 为 `runtime/synech/notes` 目录）：
 *
 * ```text
 * <root>/global/NOTES.md
 * <root>/spaces/<hash>/NOTES.md
 * <root>/spaces/<hash>/owner.json           # 记录稳定 owner 身份，供人排查
 * <root>/workspaces/<hash>/NOTES.md
 * <root>/workspaces/<hash>/owner.json       # 记录稳定 owner 身份，供人排查
 * ```
 *
 * 旧版本按 workspaceRoot 哈希命名的目录不会被这里扫描或猜测迁移；只有新 owner 身份写入
 * 的目录才是当前仓储的可见事实。迁移若有必要，必须由上层以可证明的 owner 关系显式执行。
 *
 * 笔记正文就是用户可直接打开编辑的 Markdown；这是 ADR-0033 的治理手段
 * （透明可编辑），所以正文旁不放任何会让手工编辑失效的校验和或索引。
 */
export function createFileSystemAgentNoteRepository(
  rootDir: string,
  options: {
    readonly rename?: (source: string, target: string) => Promise<void>;
    readonly waitBeforeRenameRetry?: (attempt: number) => Promise<void>;
  } = {},
): AgentNoteRepository {
  const rename = options.rename ?? fs.rename;
  const waitBeforeRenameRetry = options.waitBeforeRenameRetry ??
    ((attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, 25 * attempt)));
  return {
    async read(scope: AgentNoteScope): Promise<AgentNotebook> {
      assertAgentNoteScope(scope);
      return readNotebook(notePath(rootDir, scope), scope);
    },

    async deleteByOwner(owner: AgentNoteOwner): Promise<void> {
      assertAgentNoteScope(owner);
      if ((owner as AgentNoteScope).kind === "global") {
        throw new AgentNotesError("note_invalid_owner", "Owner deletion requires a concrete Space or Workspace owner.");
      }
      const directory = ownerDirectoryPath(rootDir, owner);
      try {
        // The directory is the complete physical unit for one owner
        // (NOTES.md, owner.json and any interrupted temp write). `force` makes
        // deleting an empty or already deleted owner idempotent.
        await fs.rm(directory, { recursive: true, force: true });
      } catch (error) {
        throw new AgentNotesError("note_io_failure", `Agent note deletion failed: ${directory}`, { cause: error });
      }
    },

    async delete(input: AgentNoteDeleteInput): Promise<AgentNoteDeleteResult> {
      assertAgentNoteScope(input.scope);
      const current = await readNotebook(notePath(rootDir, input.scope), input.scope);
      if (current.version !== input.expectedVersion) {
        return { status: "conflict", current };
      }
      const directory = path.dirname(notePath(rootDir, input.scope));
      try {
        // A notebook directory is the complete physical unit for this scope.
        // Removing it makes deletion immediate and leaves no backup/recovery
        // body; a later read naturally returns the empty baseline notebook.
        await fs.rm(directory, { recursive: true, force: true });
      } catch (error) {
        throw new AgentNotesError("note_io_failure", `Agent note deletion failed: ${directory}`, { cause: error });
      }
      return {
        status: "deleted",
        notebook: {
          scope: input.scope,
          content: "",
          version: agentNoteContentVersion(""),
          updatedAt: undefined,
        },
      };
    },

    async write(input) {
      assertAgentNoteScope(input.scope);
      const { scope, content, expectedVersion, updatedAt } = input;
      const file = notePath(rootDir, scope);
      const directory = path.dirname(file);
      const tempDirectory = path.join(directory, ".tmp");
      const tempPath = path.join(
        tempDirectory,
        `NOTES.md.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
      );
      let tempExists = false;
      try {
        await fs.mkdir(tempDirectory, { recursive: true });
        if (scope.kind !== "global") {
          await writeOwnerMarker(directory, scope);
        }
        await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
        tempExists = true;
        const conflict = await replaceNoteIfCurrent({
          source: tempPath,
          target: file,
          scope,
          expectedVersion,
          rename,
          waitBeforeRenameRetry,
        });
        if (conflict !== undefined) {
          await fs.rm(tempPath, { force: true }).catch(() => undefined);
          tempExists = false;
          return { status: "conflict", current: conflict };
        }
        tempExists = false;
      } catch (error) {
        if (tempExists) await fs.rm(tempPath, { force: true }).catch(() => undefined);
        if (error instanceof AgentNotesError) throw error;
        throw new AgentNotesError("note_io_failure", `Agent note write failed: ${file}`, { cause: error });
      }
      return {
        status: "saved",
        notebook: { scope, content, version: agentNoteContentVersion(content), updatedAt },
      };
    },
  };
}

async function replaceNoteIfCurrent(input: {
  readonly source: string;
  readonly target: string;
  readonly scope: AgentNoteScope;
  readonly expectedVersion: AgentNotebook["version"];
  readonly rename: (source: string, target: string) => Promise<void>;
  readonly waitBeforeRenameRetry: (attempt: number) => Promise<void>;
}): Promise<AgentNotebook | undefined> {
  // The Host directory lease excludes another local writer. Direct
  // editors do not share that lease, so every Windows rename retry revalidates
  // the Markdown body and leaves only the irreducible compare-to-syscall window.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const current = await readNotebook(input.target, input.scope);
    if (current.version !== input.expectedVersion) return current;
    try {
      await input.rename(input.source, input.target);
      return undefined;
    } catch (error) {
      if (attempt >= 6 || !isTransientRenameError(error)) throw error;
      await input.waitBeforeRenameRetry(attempt);
    }
  }
  throw new Error("Agent note rename retry exhausted without an outcome.");
}

async function readNotebook(file: string, scope: AgentNoteScope): Promise<AgentNotebook> {
  try {
    const [content, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    return {
      scope,
      content,
      version: agentNoteContentVersion(content),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        scope,
        content: "",
        version: agentNoteContentVersion(""),
        updatedAt: undefined,
      };
    }
    throw new AgentNotesError("note_io_failure", `Agent note read failed: ${file}`, { cause: error });
  }
}

function notePath(rootDir: string, scope: AgentNoteScope): string {
  if (scope.kind === "global") {
    return path.join(rootDir, "global", "NOTES.md");
  }
  return path.join(ownerDirectoryPath(rootDir, scope), "NOTES.md");
}

function ownerDirectoryPath(rootDir: string, owner: AgentNoteOwner): string {
  return path.join(rootDir, `${owner.kind}s`, ownerDirectoryName(owner));
}

/**
 * owner 目录名：稳定身份的短哈希。
 * 哈希只用于目录命名（id 可能含不适合做目录名的字符）；owner.json 记录原始
 * 软件对象身份供人排查，但不参与运行时判定。
 */
function ownerDirectoryName(owner: AgentNoteOwner): string {
  return createHash("sha256")
    .update(agentNoteScopeIdentity(owner), "utf8")
    .digest("hex")
    .slice(0, 16);
}

async function writeOwnerMarker(directory: string, owner: AgentNoteOwner): Promise<void> {
  const marker = path.join(directory, "owner.json");
  try {
    await fs.access(marker);
    return;
  } catch {
    // First write for this owner: record the stable identity for humans.
  }
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(marker, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
