import path from "node:path";

import type { SpaceFeature, SpaceReferenceItem } from "../spaces/index.js";
import type { LocalWorkspaceMutationCoordinator } from "../tool-center/adapters/local-workspace-mutation-coordinator.js";
import type { WorkbenchCoordination } from "./contracts.js";
import { WorkbenchCoordinationError } from "./contracts.js";

export type SpaceReferenceUnlinkService = {
  unlink(referenceId: string): Promise<void>;
};

/** One application path shared by HTTP and Agent adapters. */
export function createSpaceReferenceUnlinkService(input: {
  readonly spaces: {
    readonly commands: Pick<SpaceFeature["commands"], "unlinkReference">;
    readonly queries: Pick<SpaceFeature["queries"], "getReference">;
  };
  readonly coordination: Pick<WorkbenchCoordination, "commands">;
  readonly mutations: Pick<LocalWorkspaceMutationCoordinator, "runExclusive">;
  readonly assertSpaceAvailable: (spaceId: string) => void;
}): SpaceReferenceUnlinkService {
  return {
    async unlink(referenceId) {
      const initial = await input.spaces.queries.getReference(referenceId);
      if (initial === undefined) return;
      assertExternal(initial);
      if (initial.reference.kind === "workspace") {
        await input.coordination.commands.detachWorkspaceFromSpace(referenceId);
        return;
      }
      const unlinkCurrent = async () => {
        const current = await input.spaces.queries.getReference(referenceId);
        if (current === undefined) return;
        assertExternal(current);
        input.assertSpaceAvailable(current.spaceId);
        if (initial.reference.kind === "local_file" && !sameLocalFileSource(initial, current)) {
          throw new WorkbenchCoordinationError(
            "coordination_reference_kind_invalid",
            `Space reference ${referenceId} changed source while waiting for its path lease.`,
          );
        }
        await input.spaces.commands.unlinkReference(referenceId);
      };
      if (initial.reference.kind !== "local_file") {
        await unlinkCurrent();
        return;
      }
      await input.mutations.runExclusive(initial.reference.path, unlinkCurrent);
    },
  };
}

function assertExternal(item: SpaceReferenceItem): void {
  if (item.reference.kind === "local_file" ||
      item.reference.kind === "workspace" ||
      item.reference.kind === "web_page" ||
      item.reference.kind === "generated_artifact") return;
  throw new WorkbenchCoordinationError(
    "coordination_reference_kind_invalid",
    `Space reference ${item.id} is owned content and cannot be unlinked as an external source.`,
  );
}

function sameLocalFileSource(left: SpaceReferenceItem, right: SpaceReferenceItem): boolean {
  if (left.reference.kind !== "local_file" || right.reference.kind !== "local_file") return false;
  const leftPath = path.normalize(path.resolve(left.reference.path));
  const rightPath = path.normalize(path.resolve(right.reference.path));
  const samePath = process.platform === "win32"
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
  return samePath && left.sourceIdentity === right.sourceIdentity;
}
