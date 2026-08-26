import {
  createSpaceReferenceContentApplication,
  type SpaceReferenceContentApplication,
} from "../../application/space-reference-content-application.js";
import {
  createSpaceReferenceLifecycleApplication,
  type SpaceReferenceLifecycleApplication,
} from "../../application/space-reference-lifecycle-application.js";
import type { ManagedAssetsFeature } from "../../managed-assets/index.js";
import type { SpaceAdmission } from "../../ownership/admission.js";
import type { DocumentPreview } from "../../panel-api/workbench.js";
import type { SpaceFeature } from "../../spaces/index.js";
import type { LocalWorkspaceMutationCoordinator } from "../../tool-center/adapters/local-workspace-mutation-coordinator.js";
import {
  createSpaceReferenceUnlinkService,
  type WorkbenchCoordination,
} from "../../workbench-coordination/index.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import { createPanelSpaceReferenceContentAdapter } from "../spaces/panel-space-reference-content-adapter.js";

export type SpaceReferenceApplicationRuntime = {
  readonly content: SpaceReferenceContentApplication<DocumentPreview>;
  readonly lifecycle: SpaceReferenceLifecycleApplication;
};

export function createSpaceReferenceApplicationRuntime(input: {
  readonly spaces: SpaceFeature;
  readonly workspaces: WorkspaceFeature;
  readonly managedAssets: ManagedAssetsFeature;
  readonly admission: SpaceAdmission;
  readonly coordination: WorkbenchCoordination;
  readonly mutations: Pick<LocalWorkspaceMutationCoordinator, "run" | "runExclusive">;
}): SpaceReferenceApplicationRuntime {
  const unlink = createSpaceReferenceUnlinkService({
    spaces: {
      commands: { unlinkReference: input.spaces.commands.unlinkReference },
      queries: { getReference: input.spaces.queries.getReference },
    },
    coordination: input.coordination,
    mutations: input.mutations,
    withSpaceAdmission: (spaceId, operation) => input.admission.admit(spaceId, operation),
  });
  const content = createSpaceReferenceContentApplication({
    spaceFeature: {
      commands: { refreshReferenceSourceIdentity: input.spaces.commands.refreshReferenceSourceIdentity },
      queries: { getReference: input.spaces.queries.getReference },
    },
    spaceAdmission: input.admission,
    fileMutationCoordinator: { run: (key, operation) => input.mutations.run(key, operation) },
    ...createPanelSpaceReferenceContentAdapter({
      spaces: input.spaces,
      workspaces: input.workspaces,
      managedAssets: input.managedAssets,
    }),
  });
  const lifecycle = createSpaceReferenceLifecycleApplication({
    spaceFeature: input.spaces,
    spaceAdmission: input.admission,
    unlinkExternalReference: (itemId) => unlink.unlink(itemId),
  });

  return { content, lifecycle };
}
