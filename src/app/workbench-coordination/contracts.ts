import type { SpaceReferenceActorRecord, SpaceReferenceAnnotationInput, SpaceReferenceItem } from "../spaces/index.js";
import type { Workspace, WorkspaceMount } from "../workspaces/index.js";

export type WorkbenchCoordinationErrorCode =
  | "coordination_space_not_found"
  | "coordination_reference_not_found"
  | "coordination_workspace_directory_required"
  | "coordination_reference_kind_invalid"
  | "coordination_attach_compensation_failed";

export class WorkbenchCoordinationError extends Error {
  readonly name = "WorkbenchCoordinationError";
  constructor(readonly code: WorkbenchCoordinationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export type AttachWorkspaceToSpaceInput = {
  readonly spaceId: string;
  readonly rootPath: string;
  readonly title?: string;
  readonly annotation?: SpaceReferenceAnnotationInput;
  readonly actor: SpaceReferenceActorRecord;
};

export type WorkbenchCoordination = {
  readonly commands: {
    attachWorkspaceToSpace(input: AttachWorkspaceToSpaceInput): Promise<{
      readonly workspace: Workspace;
      readonly mount: WorkspaceMount;
      readonly item: SpaceReferenceItem;
    }>;
    detachWorkspaceFromSpace(referenceId: string): Promise<void>;
    reconnectWorkspace(input: { readonly workspaceId: string; readonly rootPath: string }): Promise<{
      readonly workspace: Workspace;
      readonly mount: WorkspaceMount;
    }>;
    hideWorkspace(workspaceId: string): Promise<Workspace>;
    deleteWorkspace(workspaceId: string): Promise<void>;
    deleteSpace(spaceId: string): Promise<void>;
    detachKnowledgeFromSpace(input: { readonly spaceId: string; readonly referenceIds: readonly string[] }): Promise<void>;
  };
};
