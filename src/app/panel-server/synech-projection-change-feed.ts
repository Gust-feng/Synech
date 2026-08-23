import type {
  SynechProjectionChange,
  SynechProjectionOwner,
} from "../panel-api-contracts.js";

const DEFAULT_HISTORY_LIMIT = 256;
const ALL_OWNERS: readonly SynechProjectionOwner[] = [
  "spaces",
  "mounted_files",
  "personal_knowledge",
  "conversations",
];

export type SynechProjectionChangeInput = Omit<SynechProjectionChange, "revision" | "reset">;

export type SynechProjectionChangeReplay = {
  readonly cursor: number;
  readonly reset: boolean;
  readonly changes: readonly SynechProjectionChange[];
};

export type SynechProjectionChangeFeed = {
  publish(change: SynechProjectionChangeInput): SynechProjectionChange;
  replay(afterRevision?: number): SynechProjectionChangeReplay;
  subscribe(listener: (change: SynechProjectionChange) => void): () => void;
  release(): void;
};

/** Host-owned live invalidation feed. Business snapshots remain in their owning features. */
export function createSynechProjectionChangeFeed(
  historyLimit = DEFAULT_HISTORY_LIMIT,
): SynechProjectionChangeFeed {
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
    throw new Error("Synech projection change history limit must be a positive safe integer.");
  }
  const listeners = new Set<(change: SynechProjectionChange) => void>();
  const history: SynechProjectionChange[] = [];
  let revision = 0;
  let released = false;

  return {
    publish(input) {
      if (released) throw new Error("Synech projection change feed is released.");
      const change: SynechProjectionChange = {
        ...input,
        owners: uniqueOwners(input.owners),
        revision: ++revision,
        reset: false,
      };
      history.push(change);
      while (history.length > historyLimit) history.shift();
      for (const listener of [...listeners]) {
        try { listener(change); } catch { /* Projection observers cannot affect the committed source fact. */ }
      }
      return change;
    },
    replay(afterRevision) {
      if (released) throw new Error("Synech projection change feed is released.");
      if (afterRevision === undefined) {
        return { cursor: revision, reset: true, changes: [resetChange(revision)] };
      }
      if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || afterRevision > revision) {
        return { cursor: revision, reset: true, changes: [resetChange(revision)] };
      }
      const oldestAvailable = history[0]?.revision ?? revision + 1;
      if (afterRevision + 1 < oldestAvailable) {
        return { cursor: revision, reset: true, changes: [resetChange(revision)] };
      }
      return {
        cursor: revision,
        reset: false,
        changes: history.filter((change) => change.revision > afterRevision),
      };
    },
    subscribe(listener) {
      if (released) throw new Error("Synech projection change feed is released.");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release() {
      if (released) return;
      released = true;
      listeners.clear();
      history.length = 0;
    },
  };
}

function resetChange(revision: number): SynechProjectionChange {
  return { revision, reset: true, owners: ALL_OWNERS };
}

function uniqueOwners(owners: readonly SynechProjectionOwner[]): readonly SynechProjectionOwner[] {
  return [...new Set(owners)];
}
