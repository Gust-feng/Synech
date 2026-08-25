import type { SpaceFeature, SpaceExternalSourceSnapshot } from "../spaces/index.js";
import type { WorkspaceFeature } from "../workspaces/index.js";
import {
  WorkbenchCoordinationError,
  type SpaceKnowledgeDetachWorkflow,
  type WorkbenchCoordination,
} from "./contracts.js";

export function createWorkbenchCoordination(input: {
  readonly spaces: {
    readonly commands: Pick<SpaceFeature["commands"], "addReference" | "unlinkReference">;
    readonly queries: Pick<SpaceFeature["queries"], "getTree" | "getReference" | "listReferencesByWorkspace">;
  };
  readonly workspaces: {
    readonly commands: Pick<WorkspaceFeature["commands"],
      "ensureWorkspace" | "reconnectWorkspace" | "setVisibility" | "discardImplicitWorkspace">;
  };
  readonly inspectDirectory: (rootPath: string) => Promise<SpaceExternalSourceSnapshot | undefined>;
  readonly withSpaceAdmission: <T>(spaceId: string, operation: () => Promise<T>) => Promise<T>;
  readonly listWorkspaceConversationIds: (workspaceId: string) => Promise<readonly string[]>;
  readonly withWorkspaceAdmission: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
  readonly withWorkspacePathLease: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
  readonly withWorkspaceMountTransitionLease: <T>(
    workspaceId: string,
    candidateRootPath: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly deleteWorkspace: (workspaceId: string) => Promise<void>;
  readonly deleteSpace: (spaceId: string, detachKnowledgeFromSpace?: SpaceKnowledgeDetachWorkflow) => Promise<void>;
  readonly detachKnowledgeFromSpace: (input: {
    readonly spaceId: string;
    readonly referenceIds: readonly string[];
  }) => Promise<void>;
}): WorkbenchCoordination {
  // Keep one FIFO lane for the Workbench command surface intentionally. A
  // resource-keyed lane is not sufficient here: attach can create/reuse a
  // Workspace before writing Space membership, while deleteWorkspace/deleteSpace
  // capture and clean those same relationships; reconnect also changes the
  // Workspace mount identity that an in-flight attach or detach may observe.
  // Path leases protect filesystem I/O, but they cannot serialize these
  // cross-owner relationship snapshots or their compensation. Split lanes
  // only after a transaction-level owner/admission protocol exists.
  let tail = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  // Internal workflow used by both the public detach command and the Space
  // deletion cascade. It deliberately does not enter the public queue again;
  // deleteSpace already owns the outer serialized critical section.
  const detachKnowledgeWorkflow: SpaceKnowledgeDetachWorkflow = async (detachInput) => {
    if (await input.spaces.queries.getTree(detachInput.spaceId) === undefined) {
      throw new WorkbenchCoordinationError(
        "coordination_space_not_found",
        `Space not found: ${detachInput.spaceId}`,
      );
    }
    await input.detachKnowledgeFromSpace(detachInput);
  };

  return {
    commands: {
      attachWorkspaceToSpace(attachInput) {
        return serialize(async () => await input.withSpaceAdmission(attachInput.spaceId, async () => {
          if (await input.spaces.queries.getTree(attachInput.spaceId) === undefined) {
            throw new WorkbenchCoordinationError("coordination_space_not_found", `Space not found: ${attachInput.spaceId}`);
          }
          const source = await input.inspectDirectory(attachInput.rootPath);
          if (source?.kind !== "folder") {
            throw new WorkbenchCoordinationError(
              "coordination_workspace_directory_required",
              "The selected Workspace path must be an existing directory.",
            );
          }
          const ensured = await input.workspaces.commands.ensureWorkspace({
            rootPath: attachInput.rootPath,
            sourceIdentity: source.identity,
            visibility: "implicit",
            ...(attachInput.title === undefined ? {} : { title: attachInput.title }),
          });
          const existing = (await input.spaces.queries.listReferencesByWorkspace(ensured.workspace.id))
            .find((reference) => reference.spaceId === attachInput.spaceId);
          if (existing !== undefined) {
            return { workspace: ensured.workspace, mount: ensured.mount, item: existing };
          }
          try {
            const item = await input.spaces.commands.addReference({
              spaceId: attachInput.spaceId,
              title: attachInput.title ?? ensured.workspace.title,
              reference: { kind: "workspace", workspaceId: ensured.workspace.id },
              ...(attachInput.annotation === undefined ? {} : { annotation: attachInput.annotation }),
              actor: attachInput.actor,
            });
            return { workspace: ensured.workspace, mount: ensured.mount, item };
          } catch (attachError) {
            if (!ensured.created) throw attachError;
            try {
              await input.withWorkspaceAdmission(ensured.workspace.id, async () => {
                const [references, conversations] = await Promise.all([
                  input.spaces.queries.listReferencesByWorkspace(ensured.workspace.id),
                  input.listWorkspaceConversationIds(ensured.workspace.id),
                ]);
                if (references.length === 0 && conversations.length === 0) {
                  await input.workspaces.commands.discardImplicitWorkspace(ensured.workspace.id);
                }
              });
            } catch (compensationError) {
              throw new WorkbenchCoordinationError(
                "coordination_attach_compensation_failed",
                `Workspace ${ensured.workspace.id} could not be compensated after Space attachment failed.`,
                { cause: new AggregateError([attachError, compensationError]) },
              );
            }
            throw attachError;
          }
        }));
      },
      detachWorkspaceFromSpace(referenceId) {
        return serialize(async () => {
          const initial = await findWorkspaceReference(input.spaces.queries, referenceId);
          if (initial === undefined) return;
          await input.withSpaceAdmission(initial.spaceId, async () => {
            await input.withWorkspacePathLease(initial.reference.workspaceId, async () => {
              const current = await findWorkspaceReference(input.spaces.queries, referenceId);
              if (current === undefined) return;
              if (current.reference.workspaceId !== initial.reference.workspaceId) {
                throw new WorkbenchCoordinationError(
                  "coordination_reference_kind_invalid",
                  `Space reference ${referenceId} changed Workspace identity while waiting for its path lease.`,
                );
              }
              if (current.spaceId !== initial.spaceId) {
                throw new WorkbenchCoordinationError(
                  "coordination_reference_kind_invalid",
                  `Space reference ${referenceId} changed Space membership while waiting for its admission.`,
                );
              }
              await input.spaces.commands.unlinkReference(referenceId);
            });
          });
        });
      },
      reconnectWorkspace(reconnectInput) {
        return serialize(async () => await input.withWorkspaceAdmission(reconnectInput.workspaceId, async () => {
            const source = await input.inspectDirectory(reconnectInput.rootPath);
            if (source?.kind !== "folder") {
              throw new WorkbenchCoordinationError(
                "coordination_workspace_directory_required",
                "The selected Workspace path must be an existing directory.",
              );
            }
            return await input.withWorkspaceMountTransitionLease(
              reconnectInput.workspaceId,
              reconnectInput.rootPath,
              async () => {
                const currentSource = await input.inspectDirectory(reconnectInput.rootPath);
                if (currentSource?.kind !== "folder" || currentSource.identity !== source.identity) {
                  throw new WorkbenchCoordinationError(
                    "coordination_workspace_directory_required",
                    "The selected Workspace source changed while waiting for its path lease.",
                  );
                }
                return await input.workspaces.commands.reconnectWorkspace({
                  workspaceId: reconnectInput.workspaceId,
                  rootPath: reconnectInput.rootPath,
                  sourceIdentity: currentSource.identity,
                });
              },
            );
          }));
      },
      hideWorkspace(workspaceId) {
        return serialize(async () => await input.withWorkspaceAdmission(
          workspaceId,
          async () => await input.workspaces.commands.setVisibility(workspaceId, "implicit"),
        ));
      },
      deleteWorkspace(workspaceId) {
        return serialize(async () => await input.deleteWorkspace(workspaceId));
      },
      deleteSpace(spaceId) {
        return serialize(async () => await input.deleteSpace(spaceId, detachKnowledgeWorkflow));
      },
      detachKnowledgeFromSpace(detachInput) {
        return serialize(async () => await detachKnowledgeWorkflow(detachInput));
      },
    },
  };
}

async function findWorkspaceReference(
  queries: Parameters<typeof createWorkbenchCoordination>[0]["spaces"]["queries"],
  referenceId: string,
) {
  const reference = await queries.getReference(referenceId);
  if (reference === undefined) return undefined;
  if (reference.reference.kind !== "workspace") {
    throw new WorkbenchCoordinationError(
      "coordination_reference_kind_invalid",
      `Space reference ${referenceId} is not a Workspace membership.`,
    );
  }
  return reference as typeof reference & { readonly reference: { readonly kind: "workspace"; readonly workspaceId: string } };
}
