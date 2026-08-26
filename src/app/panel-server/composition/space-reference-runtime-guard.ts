import {
  createSpaceRevocationOverlay,
  type SpaceFeature,
  type SpaceRevocationOverlay,
} from "../../spaces/index.js";
import {
  processCleanupHasUnresolvedStops,
  type InMemoryProcessRegistry,
  type ProcessTerminator,
} from "../../runtime-guard/index.js";

export type SpaceReferenceRuntimeGuard = {
  readonly revocationOverlay: SpaceRevocationOverlay;
  flush(): Promise<void>;
  release(): void;
};

/** Revokes removed Space references for live runs and stops their managed processes. */
export function createSpaceReferenceRuntimeGuard(input: {
  readonly spaces: Pick<SpaceFeature, "events">;
  readonly processes: Pick<InMemoryProcessRegistry, "revokeByReference">;
  readonly processTerminator: ProcessTerminator;
}): SpaceReferenceRuntimeGuard {
  const revocationOverlay = createSpaceRevocationOverlay(input.spaces.events);
  const activeCleanups = new Set<Promise<void>>();
  const unsubscribe = input.spaces.events.subscribe((event) => {
    if (event.type !== "space.reference_removed") return;
    for (const referenceId of event.removedItemIds) {
      let tracked: Promise<void>;
      tracked = input.processes.revokeByReference(referenceId, input.processTerminator).then((result) => {
        if (processCleanupHasUnresolvedStops(result)) {
          console.error(
            `[panel-server] Space reference ${referenceId} was revoked but one or more managed processes remain stop_pending`,
            result,
          );
        }
      }, (error: unknown) => {
        console.error(`[panel-server] Space reference ${referenceId} process cleanup failed`, error);
      }).finally(() => {
        activeCleanups.delete(tracked);
      });
      activeCleanups.add(tracked);
    }
  });

  return {
    revocationOverlay,
    async flush() {
      while (activeCleanups.size > 0) await Promise.all([...activeCleanups]);
    },
    release() {
      unsubscribe();
      revocationOverlay.dispose();
    },
  };
}
