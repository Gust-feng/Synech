import type { SynechProjectionChange } from "../../panel-api-contracts";

type ProjectionChangeListener = (change: SynechProjectionChange) => void;

const listeners = new Set<ProjectionChangeListener>();
let stream: EventSource | undefined;

/** One shared connection fans Host-owned invalidation facts out to Panel projections. */
export function subscribeSynechProjectionChanges(listener: ProjectionChangeListener): () => void {
  listeners.add(listener);
  ensureStream();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stream?.close();
      stream = undefined;
    }
  };
}

function ensureStream(): void {
  if (stream !== undefined || typeof EventSource === "undefined") return;
  const opened = new EventSource("/api/projection-changes");
  opened.addEventListener("synech.projection.changed", ((message: MessageEvent<string>) => {
    try {
      const change = JSON.parse(message.data) as SynechProjectionChange;
      if (!isProjectionChange(change)) return;
      for (const listener of [...listeners]) {
        try { listener(change); } catch { /* One projection cannot block the other owners. */ }
      }
    } catch {
      // A malformed optional notification must not affect the authoritative HTTP projections.
    }
  }) as EventListener);
  stream = opened;
}

function isProjectionChange(value: SynechProjectionChange): boolean {
  return Number.isSafeInteger(value.revision)
    && value.revision >= 0
    && typeof value.reset === "boolean"
    && Array.isArray(value.owners);
}
