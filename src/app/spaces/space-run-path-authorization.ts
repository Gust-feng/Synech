import { promises as fs } from "node:fs";
import path from "node:path";
import { parseContextReference, type OrdinaryRunContext } from "../../domain/ordinary/index.js";
import { confirmationIdForToolCall } from "../../kernel/tools/index.js";
import type {
  AuthorizedLocalWorkspacePath,
  LocalWorkspacePathAuthorization,
  LocalWorkspacePathOperation,
} from "../tool-center/adapters/local-workspace-common.js";
import {
  spaceReferenceIdFromAttachmentId,
  spaceReferenceWritePermission,
  spaceScopeIdFromPermissions,
} from "./space-file-access.js";
import {
  canonicalSpacePathIdentity,
  resolveSpacePath,
  type SpacePathGrant,
  type SpacePathIdentity,
} from "./space-path-resolver.js";
import type { SpaceRevocationOverlay } from "./space-tools.js";
import {
  spaceExternalSourceStatus,
  type SpaceExternalSourceInspector,
} from "./space-external-source.js";

export type CreateSpaceRunPathAuthorizationInput = {
  readonly runContext: Pick<OrdinaryRunContext, "contextRefs" | "permissionBoundaryRefs">;
  readonly workspaceRoot: string;
  readonly revocationOverlay?: SpaceRevocationOverlay;
  readonly pathIdentity?: SpacePathIdentity;
  readonly externalSourceInspector?: SpaceExternalSourceInspector;
  /** Reads the current owner facts; used again after the mutation lease is acquired. */
  readonly resolveCurrentSource?: (referenceId: string) => Promise<{
    readonly path: string;
    readonly sourceIdentity?: string;
    readonly mountVersion?: string;
  } | undefined>;
  /** Called lazily when actual access proves that the frozen external source is gone or replaced. */
  readonly onInvalidReference?: (referenceId: string) => Promise<void>;
};

/**
 * Resolves run-frozen Space authority for the mature local file and Shell tools.
 * `undefined` is returned when the run is not owned by a Space.
 */
export function createSpaceRunPathAuthorization(
  input: CreateSpaceRunPathAuthorizationInput,
): LocalWorkspacePathAuthorization | undefined {
  const spaceId = spaceScopeIdFromPermissions(input.runContext.permissionBoundaryRefs);
  if (spaceId === undefined) return undefined;
  const grants = frozenSpacePathGrants(input.runContext);
  const resourceScope = { ownerKind: "space", ownerId: spaceId } as const;
  const identity = input.pathIdentity ?? ((value: string) =>
    canonicalSpacePathIdentity(value, (target) => fs.realpath(target)));

  return {
    resourceScope,
    async resolve(request): Promise<AuthorizedLocalWorkspacePath> {
      const unrestricted = hasUnrestrictedFilesystemAccess(request);
      const requestedPath = absoluteRequestedPath({
        requestedPath: request.requestedPath,
        operation: request.operation,
        workspaceRoot: request.workspaceRoot,
        grants,
        unrestricted,
      });
      const resolution = await resolveSpacePath({ requestedPath, grants, identity });
      if (resolution.outcome === "mount_conflict") {
        throw new Error(`Path matches multiple frozen Space references: ${resolution.referenceIds.join(", ")}.`);
      }
      if (resolution.outcome === "resolved" && input.revocationOverlay?.has(resolution.referenceId) === true) {
        throw new Error(`Space reference ${resolution.referenceId} was revoked and no longer authorizes this path.`);
      }
      if (resolution.outcome === "resolved") {
        const grant = grants.find((candidate) => candidate.referenceId === resolution.referenceId);
        if (grant !== undefined && input.resolveCurrentSource !== undefined) {
          const current = await input.resolveCurrentSource(resolution.referenceId);
          if (current === undefined ||
              await identity(current.path) !== await identity(grant.path) ||
              current.sourceIdentity !== grant.sourceIdentity ||
              current.mountVersion !== grant.mountVersion) {
            throw new Error(`Space reference ${resolution.referenceId} changed source identity while the request was waiting.`);
          }
        }
        // External references always carry a captured source identity. Managed
        // folders are software assets and must never enter the unlink workflow.
        if (grant?.sourceIdentity !== undefined &&
            await spaceExternalSourceStatus(grant, input.externalSourceInspector) !== "current") {
          if (input.onInvalidReference !== undefined) {
            await input.onInvalidReference(resolution.referenceId);
            throw new Error(`Space reference ${resolution.referenceId} no longer has an active Workspace mount.`);
          }
          throw new Error(`Space reference ${resolution.referenceId} no longer points to its original source.`);
        }
      }

      if (resolution.outcome === "outside_reference" && !unrestricted) {
        throw new Error(
          `${requestedPath} is not inside any Space reference authorized for this run. To write into a new folder, mount it first with SpaceMountLocalPath (the user confirms the path), or ask the user to provide the target folder in this conversation.`,
        );
      }

      if (resolution.outcome === "resolved") {
        const rootDirectory = path.resolve(resolution.rootPath);
        return {
          absolutePath: requestedPath,
          relativePath: portableRelativePath(rootDirectory, requestedPath),
          rootDirectory,
          resourceScope,
          resourceId: resolution.referenceId,
        };
      }

      const rootDirectory = path.parse(requestedPath).root;
      return {
        absolutePath: requestedPath,
        relativePath: portableRelativePath(rootDirectory, requestedPath),
        rootDirectory,
        resourceScope,
      };
    },
  };
}

export function frozenSpacePathGrants(runContext: Pick<OrdinaryRunContext, "contextRefs" | "permissionBoundaryRefs">): readonly SpacePathGrant[] {
  const grants: SpacePathGrant[] = [];
  for (const contextRef of runContext.contextRefs) {
    const attachmentId = contextRef.attachmentId;
    const referenceId = attachmentId === undefined
      ? undefined
      : spaceReferenceIdFromAttachmentId(attachmentId);
    if (referenceId === undefined) continue;
    const grant = localGrant(contextRef.ref, contextRef.kind);
    if (grant === undefined) continue;
    const readPermission = `${grant.kind === "file" ? "read:local-file" : "read:local-project"}:${grant.path}`;
    const readable = runContext.permissionBoundaryRefs.includes(readPermission);
    const writable = runContext.permissionBoundaryRefs.includes(spaceReferenceWritePermission(referenceId));
    if (!readable && !writable) continue;
    grants.push({
      referenceId,
      kind: grant.kind,
      path: grant.path,
      sourceIdentity: contextRef.sourceIdentity,
      mountVersion: contextRef.mountVersion,
    });
  }
  return grants;
}

function absoluteRequestedPath(input: {
  readonly requestedPath: string;
  readonly operation: LocalWorkspacePathOperation;
  readonly workspaceRoot: string;
  readonly grants: readonly SpacePathGrant[];
  readonly unrestricted: boolean;
}): string {
  const requested = input.requestedPath.trim().length === 0 ? "." : input.requestedPath.trim();
  if (path.isAbsolute(requested)) return path.resolve(requested);
  if (!input.unrestricted) {
    const folderGrants = input.grants.filter((grant) => grant.kind === "folder");
    if (folderGrants.length !== 1) {
      throw new Error("Space file tools require an absolute path when the run has zero or multiple folder references.");
    }
    return path.resolve(folderGrants[0]!.path, requested);
  }
  return path.resolve(input.workspaceRoot, requested);
}

function hasUnrestrictedFilesystemAccess(
  request: Parameters<NonNullable<LocalWorkspacePathAuthorization>["resolve"]>[0],
): boolean {
  if (request.context.accessPolicy?.filesystemScope === "unrestricted") return true;
  const invocationId = request.context.invocationId;
  return request.operation === "execute" && invocationId !== undefined &&
    request.context.approvedConfirmationIds?.includes(confirmationIdForToolCall(invocationId)) === true;
}

function localGrant(
  ref: string,
  kind: OrdinaryRunContext["contextRefs"][number]["kind"],
): { readonly kind: "file" | "folder"; readonly path: string } | undefined {
  const parsed = parseContextReference(ref, kind);
  if (parsed?.scheme === "local_file" && path.isAbsolute(parsed.path)) {
    return { kind: "file", path: path.resolve(parsed.path) };
  }
  if (parsed?.scheme === "local_project" && path.isAbsolute(parsed.path)) {
    return { kind: "folder", path: path.resolve(parsed.path) };
  }
  return undefined;
}

function portableRelativePath(rootDirectory: string, absolutePath: string): string {
  const relative = path.relative(rootDirectory, absolutePath);
  return (relative.length === 0 ? "." : relative).split(path.sep).join("/");
}
