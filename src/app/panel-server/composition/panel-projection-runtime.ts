import path from "node:path";

import type { ManagedAssetsFeature } from "../../managed-assets/index.js";
import type { OrdinaryAgentFeature } from "../../ordinary-agent/index.js";
import type { PersonalKnowledgeFeature } from "../../personal-knowledge/index.js";
import type { SpaceFeature } from "../../spaces/index.js";
import type { LocalWorkspaceMutationCoordinator } from "../../tool-center/adapters/local-workspace-mutation-coordinator.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import { ensureSpaceManagedRoot } from "../ordinary-run-birth.js";
import {
  createWorkbenchProjectionChangeFeed,
  projectionChangeFromPersonalKnowledge,
  projectionChangeFromSpace,
  type WorkbenchProjectionChangeFeed,
} from "../workbench/workbench-projection-change-feed.js";

export type PanelProjectionRuntime = {
  readonly changes: WorkbenchProjectionChangeFeed;
  release(): void;
};

/** Wires owner events to the Panel projection feed and owns their subscriptions. */
export function createPanelProjectionRuntime(input: {
  readonly spaces: Pick<SpaceFeature, "events" | "queries">;
  readonly personalKnowledge: Pick<PersonalKnowledgeFeature, "events">;
  readonly managedAssets: Pick<ManagedAssetsFeature, "events">;
  readonly workspaces: Pick<WorkspaceFeature, "events">;
  readonly fileMutations: Pick<LocalWorkspaceMutationCoordinator, "events">;
  readonly ordinary: Pick<OrdinaryAgentFeature, "events">;
  readonly managedSpaceRoot: string;
}): PanelProjectionRuntime {
  const changes = createWorkbenchProjectionChangeFeed();
  const unsubscribers = [
    input.spaces.events.subscribe((event) => {
      changes.publish(projectionChangeFromSpace(event));
      if (event.type === "space.created") {
        // Managed roots are recreated lazily; failures never roll back the committed Space.
        void ensureSpaceManagedRoot(path.join(input.managedSpaceRoot, event.space.id, "files"))
          .catch((error) => console.error(`[panel-server] Could not create managedRoot for Space ${event.space.id}`, error));
      }
    }),
    input.personalKnowledge.events.subscribe((event) => {
      changes.publish(projectionChangeFromPersonalKnowledge(event));
    }),
    input.managedAssets.events.subscribe((event) => {
      changes.publish({ owners: ["managed_assets"], managedAssetIds: [event.assetId] });
    }),
    input.workspaces.events.subscribe((event) => {
      const workspaceId = event.type === "workspace.registered" || event.type === "workspace.visibility_changed"
        ? event.workspace.id
        : event.workspaceId;
      changes.publish({ owners: ["workspaces"] });
      void input.spaces.queries.listReferencesByWorkspace(workspaceId).then((references) => {
        if (references.length === 0) return;
        changes.publish({
          owners: ["spaces"],
          spaceIds: [...new Set(references.map((reference) => reference.spaceId))],
          referenceIds: references.map((reference) => reference.id),
        });
      }).catch(() => undefined);
    }),
    input.fileMutations.events.subscribe(() => {
      changes.publish({ owners: ["mounted_files"] });
    }),
    input.ordinary.events.subscribeStableTerminalRuns(() => {
      // Missing Space sources are reported by actual access, never by a background scan.
      changes.publish({ owners: ["mounted_files"] });
    }),
  ];

  return {
    changes,
    release() {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      changes.release();
    },
  };
}
