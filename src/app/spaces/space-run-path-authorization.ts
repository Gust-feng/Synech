import { promises as fs } from "node:fs";
import path from "node:path";
import type { OrdinaryRunContext } from "../../domain/ordinary/index.js";
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
      const requestedPath = absoluteRequestedPath({
        requestedPath: request.requestedPath,
        operation: request.operation,
        workspaceRoot: request.workspaceRoot,
        grants,
        fullAccess: request.context.confirmationPolicy === "full_access",
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
        // External references always carry a captured source identity. Managed
        // folders are software assets and must never enter the unlink workflow.
        if (grant?.sourceIdentity !== undefined &&
            await spaceExternalSourceStatus(grant, input.externalSourceInspector) !== "current") {
          if (input.onInvalidReference !== undefined) {
            await input.onInvalidReference(resolution.referenceId);
            throw new Error(`Space reference ${resolution.referenceId} no longer points to its original source and was removed from this Space.`);
          }
          throw new Error(`Space reference ${resolution.referenceId} no longer points to its original source.`);
        }
      }

      const unrestricted = request.operation === "execute" || request.context.confirmationPolicy === "full_access";
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
    grants.push({ referenceId, kind: grant.kind, path: grant.path, sourceIdentity: contextRef.sourceIdentity });
  }
  return grants;
}

function absoluteRequestedPath(input: {
  readonly requestedPath: string;
  readonly operation: LocalWorkspacePathOperation;
  readonly workspaceRoot: string;
  readonly grants: readonly SpacePathGrant[];
  readonly fullAccess: boolean;
}): string {
  const requested = input.requestedPath.trim().length === 0 ? "." : input.requestedPath.trim();
  if (path.isAbsolute(requested)) return path.resolve(requested);
  if (input.operation !== "execute" && !input.fullAccess) {
    const folderGrants = input.grants.filter((grant) => grant.kind === "folder");
    if (folderGrants.length !== 1) {
      throw new Error("Space file tools require an absolute path when the run has zero or multiple folder references.");
    }
    return path.resolve(folderGrants[0]!.path, requested);
  }
  return path.resolve(input.workspaceRoot, requested);
}

function localGrant(
  ref: string,
  kind: OrdinaryRunContext["contextRefs"][number]["kind"],
): { readonly kind: "file" | "folder"; readonly path: string } | undefined {
  if (kind === "file" && ref.toLowerCase().startsWith("local-file:")) {
    const value = ref.slice("local-file:".length);
    return path.isAbsolute(value) ? { kind: "file", path: path.resolve(value) } : undefined;
  }
  if (kind === "project" && ref.toLowerCase().startsWith("local-project:")) {
    const value = ref.slice("local-project:".length);
    return path.isAbsolute(value) ? { kind: "folder", path: path.resolve(value) } : undefined;
  }
  return undefined;
}

function portableRelativePath(rootDirectory: string, absolutePath: string): string {
  const relative = path.relative(rootDirectory, absolutePath);
  return (relative.length === 0 ? "." : relative).split(path.sep).join("/");
}
