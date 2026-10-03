import { promises as fs } from "node:fs";

import { isFileNotFound } from "../../../kernel/values/index.js";
import {
  CollaborationRulesApplicationError,
  CollaborationRulesError,
  WORKSPACE_COLLABORATION_RULES_FILE_NAME,
  collaborationRuleContentVersion,
  type CollaborationRulesDeleteResult,
  type CollaborationRulesDocument,
  type CollaborationRulesWriteResult,
  type WorkspaceRulesDeleteInput,
  type WorkspaceRulesPort,
  type WorkspaceRulesWriteInput,
} from "../../collaboration-rules/index.js";
import { createFile, writeText } from "../../local-filesystem/local-filesystem-write.js";
import { resolveWithinRoot } from "../../local-filesystem/local-filesystem-path.js";
import {
  inspectSpaceExternalSource,
  type SpaceExternalSourceInspector,
} from "../../spaces/index.js";
import type { LocalWorkspaceMutationCoordinator } from "../../tool-center/adapters/local-workspace-mutation-coordinator.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";

/**
 * Host adapter for Workspace-backed collaboration rules: the root AGENTS.md.
 *
 * It reuses the existing Workspace mount identity check and the shared local
 * workspace mutation coordinator. Mount resolution, source identity re-verification
 * inside the lease, path-escape refusal, content CAS and the atomic write all live
 * here; the Application only sees documents. The external file is never unlinked:
 * clearing writes empty content and keeps the user's AGENTS.md.
 */
export type WorkspaceRulesPortInput = {
  readonly workspaces: {
    readonly queries: Pick<WorkspaceFeature["queries"], "get">;
    readonly commands: Pick<WorkspaceFeature["commands"], "invalidateMount">;
  };
  /** The same coordinator that guards other mutations of this workspace directory. */
  readonly mutations: Pick<LocalWorkspaceMutationCoordinator, "runExclusive">;
  /** Filesystem source inspector; defaults to the real filesystem. */
  readonly inspectSource?: SpaceExternalSourceInspector;
};

type WorkspaceRulesMount = {
  readonly workspaceId: string;
  readonly path: string;
  readonly sourceIdentity: string;
  readonly mountVersion: string;
};

type WorkspaceFileContent = {
  readonly content: string;
  readonly updatedAt: string | undefined;
};

export function createWorkspaceRulesPort(input: WorkspaceRulesPortInput): WorkspaceRulesPort {
  const inspectSource = input.inspectSource ?? inspectSpaceExternalSource;

  /** Current active mount of one Workspace; invalidates the mount when its directory was replaced. */
  const resolveMount = async (workspaceId: string): Promise<WorkspaceRulesMount | undefined> => {
    const workspace = await input.workspaces.queries.get(workspaceId);
    const mount = workspace?.status === "available" ? workspace.currentMount : undefined;
    if (mount === undefined) return undefined;
    const source = await inspectSource(mount.rootPath);
    if (source?.kind !== "folder" || source.identity !== mount.sourceIdentity) {
      await input.workspaces.commands.invalidateMount({
        workspaceId,
        expectedMountVersion: mount.mountVersion,
      });
      return undefined;
    }
    return {
      workspaceId,
      path: mount.rootPath,
      sourceIdentity: mount.sourceIdentity,
      mountVersion: mount.mountVersion,
    };
  };

  /** Re-reads the mount inside the lease; a changed or vanished mount aborts the mutation. */
  const requireCurrentMount = async (observed: WorkspaceRulesMount): Promise<WorkspaceRulesMount> => {
    const current = await resolveMount(observed.workspaceId);
    const unchanged = current !== undefined &&
      current.mountVersion === observed.mountVersion &&
      current.sourceIdentity === observed.sourceIdentity;
    if (!unchanged) throw workspaceUnavailable(observed.workspaceId);
    return current;
  };

  /** Resolves the one rule file of a mount; a link leaving the workspace root is refused. */
  const rulesFile = async (mount: WorkspaceRulesMount): Promise<string> => {
    try {
      return await resolveWithinRoot(mount.path, WORKSPACE_COLLABORATION_RULES_FILE_NAME);
    } catch (error) {
      throw new CollaborationRulesApplicationError(
        "collaboration_rules_scope_unsupported",
        `Workspace ${mount.workspaceId} ${WORKSPACE_COLLABORATION_RULES_FILE_NAME} leaves the workspace directory; it is not written.`,
        { cause: error },
      );
    }
  };

  return {
    async get(workspaceId) {
      const mount = await resolveMount(workspaceId);
      if (mount === undefined) throw workspaceUnavailable(workspaceId);
      // Reads take the same lease: a mount can be invalidated while this read waits,
      // so identity and mountVersion are re-verified inside the lease before reading.
      return await input.mutations.runExclusive(mount.path, async () => {
        const current = await requireCurrentMount(mount);
        const file = await rulesFile(current);
        return workspaceDocument(workspaceId, file, await readWorkspaceFile(file));
      });
    },

    async write(command: WorkspaceRulesWriteInput): Promise<CollaborationRulesWriteResult> {
      const mount = await resolveMount(command.scope.id);
      if (mount === undefined) throw workspaceUnavailable(command.scope.id);
      return await input.mutations.runExclusive(mount.path, async () => {
        const current = await requireCurrentMount(mount);
        const file = await rulesFile(current);
        const existing = await readWorkspaceFile(file);
        const conflict = await conflictDocument(command.scope.id, file, existing, command.expectedVersion);
        if (conflict !== undefined) return { status: "conflict", current: conflict };
        if (existing === undefined) {
          const created = await createFile(file);
          if (!created.ok) {
            if (created.error.kind === "already_exists") {
              return { status: "conflict", current: await reloadDocument(command.scope.id, file) };
            }
            throw workspaceWriteFailure(file, created.error.kind);
          }
        }
        if (await publish(file, command.content, command.expectedVersion) === "conflict") {
          return { status: "conflict", current: await reloadDocument(command.scope.id, file) };
        }
        return { status: "saved", document: await reloadDocument(command.scope.id, file) };
      });
    },

    async delete(command: WorkspaceRulesDeleteInput): Promise<CollaborationRulesDeleteResult> {
      const mount = await resolveMount(command.scope.id);
      if (mount === undefined) throw workspaceUnavailable(command.scope.id);
      return await input.mutations.runExclusive(mount.path, async () => {
        const current = await requireCurrentMount(mount);
        const file = await rulesFile(current);
        const existing = await readWorkspaceFile(file);
        const conflict = await conflictDocument(command.scope.id, file, existing, command.expectedVersion);
        if (conflict !== undefined) return { status: "conflict", current: conflict };
        if (existing === undefined) {
          return { status: "deleted", document: workspaceDocument(command.scope.id, file, undefined) };
        }
        if (await publish(file, "", command.expectedVersion) === "conflict") {
          return { status: "conflict", current: await reloadDocument(command.scope.id, file) };
        }
        return { status: "deleted", document: await reloadDocument(command.scope.id, file) };
      });
    },
  };
}

/**
 * Publishes content through the shared atomic CAS helper. A fingerprint mismatch
 * means another writer changed the file after our read, so the caller reports a
 * conflict instead of overwriting it.
 */
async function publish(
  file: string,
  content: string,
  expectedVersion: string,
): Promise<"written" | "conflict"> {
  const result = await writeText(file, content, expectedVersion);
  if (result.ok) return "written";
  if (result.error.kind === "fingerprint_mismatch" || result.error.kind === "not_found" || result.error.kind === "is_directory") {
    return "conflict";
  }
  throw workspaceWriteFailure(file, result.error.kind);
}

async function conflictDocument(
  workspaceId: string,
  file: string,
  existing: WorkspaceFileContent | undefined,
  expectedVersion: string,
): Promise<CollaborationRulesDocument | undefined> {
  const document = workspaceDocument(workspaceId, file, existing);
  return document.version === expectedVersion ? undefined : document;
}

async function reloadDocument(workspaceId: string, file: string): Promise<CollaborationRulesDocument> {
  return workspaceDocument(workspaceId, file, await readWorkspaceFile(file));
}

async function readWorkspaceFile(file: string): Promise<WorkspaceFileContent | undefined> {
  try {
    const [content, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    return { content, updatedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw new CollaborationRulesError("collaboration_rule_io_failure", `Workspace rules read failed: ${file}`, { cause: error });
  }
}

function workspaceDocument(
  workspaceId: string,
  file: string,
  existing: WorkspaceFileContent | undefined,
): CollaborationRulesDocument {
  const content = existing?.content ?? "";
  return {
    scope: { kind: "workspace", id: workspaceId },
    content,
    version: collaborationRuleContentVersion(content),
    updatedAt: existing?.updatedAt,
    source: { kind: "workspace_file", path: file },
  };
}

function workspaceWriteFailure(file: string, kind: string): CollaborationRulesError {
  return new CollaborationRulesError("collaboration_rule_io_failure", `Workspace rules write failed (${kind}): ${file}`);
}

function workspaceUnavailable(workspaceId: string): CollaborationRulesApplicationError {
  return new CollaborationRulesApplicationError(
    "collaboration_rules_scope_unavailable",
    `Workspace ${workspaceId} is disconnected or no longer matches its registered directory.`,
  );
}