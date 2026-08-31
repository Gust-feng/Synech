import type { IdFactory } from "../../../kernel/id.js";
import {
  OrdinaryFeatureError,
  type OrdinaryRunRepository,
  type OrdinaryRunSnapshotDocument,
  type OrdinaryRunState,
} from "../contracts.js";
import { isTerminal } from "../run-lifecycle-policy.js";
import { transitionOrdinaryRun, type OrdinaryRunTransition } from "../state.js";

export type OrdinaryRunStore = {
  cached(runId: string): OrdinaryRunSnapshotDocument | undefined;
  has(runId: string): boolean;
  cachedDocuments(): readonly OrdinaryRunSnapshotDocument[];
  adoptPersisted(document: OrdinaryRunSnapshotDocument): Promise<void>;
  load(runId: string): Promise<OrdinaryRunSnapshotDocument | undefined>;
  inspectPersisted(runId: string): Promise<OrdinaryRunSnapshotDocument | undefined>;
  inspectRecoveryInventory(): ReturnType<OrdinaryRunRepository["inspectRecoveryInventory"]>;
  listSummaries(limit?: number): ReturnType<OrdinaryRunRepository["list"]>;
  persistUnpublished(state: OrdinaryRunState, expectedRevision: number): Promise<OrdinaryRunSnapshotDocument>;
  publishBirth(document: OrdinaryRunSnapshotDocument): void;
  savePublished(state: OrdinaryRunState, expectedRevision: number): Promise<OrdinaryRunSnapshotDocument>;
  delete(runId: string): Promise<void>;
  withExclusiveRun<T>(runId: string, operation: () => Promise<T>): Promise<T>;
  mutate(
    runId: string,
    transition: OrdinaryRunTransition,
    options?: { readonly keepTerminal?: boolean },
  ): Promise<OrdinaryRunState>;
  mutateLocked(
    runId: string,
    transition: OrdinaryRunTransition,
    options?: { readonly keepTerminal?: boolean },
  ): Promise<OrdinaryRunState>;
  markEnumerationFailed(): void;
  enumerationFailed(): boolean;
  evictCachedTerminal(runId: string): void;
  awaitIdle(): Promise<void>;
  clear(): void;
};

export function createOrdinaryRunStore(options: {
  readonly repository: OrdinaryRunRepository;
  readonly now: () => string;
  readonly idFactory: IdFactory;
  readonly visibleAssistantText: (runId: string) => string | undefined;
  readonly onLoaded: (state: OrdinaryRunState) => void | Promise<void>;
  readonly onSaved: (state: OrdinaryRunState) => void;
  readonly onTransition: (event: OrdinaryRunState["timeline"][number], assistantText?: string) => void;
}): OrdinaryRunStore {
  const documents = new Map<string, OrdinaryRunSnapshotDocument>();
  const unpublishedRunIds = new Set<string>();
  const mutationQueues = new Map<string, Promise<void>>();
  let startupEnumerationFailed = false;

  async function load(runId: string): Promise<OrdinaryRunSnapshotDocument | undefined> {
    const cached = documents.get(runId);
    if (cached !== undefined) return cached;
    if (startupEnumerationFailed || unpublishedRunIds.has(runId)) return undefined;
    const document = await options.repository.get(runId);
    if (document !== undefined) {
      await adoptPersisted(document);
    }
    return document;
  }

  async function adoptPersisted(document: OrdinaryRunSnapshotDocument): Promise<void> {
    await options.onLoaded(document.state);
    documents.set(document.state.runId, document);
  }

  async function persistUnpublished(
    state: OrdinaryRunState,
    expectedRevision: number,
  ): Promise<OrdinaryRunSnapshotDocument> {
    unpublishedRunIds.add(state.runId);
    return options.repository.save(state, expectedRevision);
  }

  function publishBirth(document: OrdinaryRunSnapshotDocument): void {
    unpublishedRunIds.delete(document.state.runId);
    documents.set(document.state.runId, document);
    options.onSaved(document.state);
  }

  async function savePublished(state: OrdinaryRunState, expectedRevision: number): Promise<OrdinaryRunSnapshotDocument> {
    const saved = await options.repository.save(state, expectedRevision);
    documents.set(state.runId, saved);
    options.onSaved(state);
    return saved;
  }

  async function withExclusiveRun<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(runId) ?? Promise.resolve();
    let resolveCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
    const tail = previous.then(() => current, () => current);
    mutationQueues.set(runId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      resolveCurrent();
      if (mutationQueues.get(runId) === tail) mutationQueues.delete(runId);
    }
  }

  async function mutate(
    runId: string,
    transition: OrdinaryRunTransition,
    mutateOptions: { readonly keepTerminal?: boolean } = {},
  ): Promise<OrdinaryRunState> {
    return withExclusiveRun(runId, () => mutateLocked(runId, transition, mutateOptions));
  }

  async function mutateLocked(
    runId: string,
    transition: OrdinaryRunTransition,
    mutateOptions: { readonly keepTerminal?: boolean } = {},
  ): Promise<OrdinaryRunState> {
    const current = await load(runId);
    if (current === undefined) {
      throw new OrdinaryFeatureError("ordinary_run_not_found", `Ordinary run ${runId} was not found`);
    }
    if (mutateOptions.keepTerminal === true && isTerminal(current.state)) return clone(current.state);
    const visibleAssistantText = options.visibleAssistantText(runId);
    const state = transitionOrdinaryRun({
      state: visibleAssistantText === undefined || visibleAssistantText === current.state.visibleAssistantText
        ? current.state
        : { ...current.state, visibleAssistantText },
      transition,
      recordedAt: options.now(),
      eventId: options.idFactory("ordinary-event"),
    });
    await savePublished(state, current.revision);
    if (state.timeline.length > current.state.timeline.length) {
      options.onTransition(
        state.timeline.at(-1)!,
        transition.type === "record_session_checkpoint" ? transition.assistantText : undefined,
      );
    }
    return clone(state);
  }

  return {
    cached: (runId) => documents.get(runId),
    has: (runId) => documents.has(runId),
    cachedDocuments: () => [...documents.values()],
    adoptPersisted,
    load,
    inspectPersisted: (runId) => options.repository.get(runId),
    inspectRecoveryInventory: () => options.repository.inspectRecoveryInventory(),
    listSummaries: (limit) => options.repository.list(limit),
    persistUnpublished,
    publishBirth,
    savePublished,
    delete: (runId) => withExclusiveRun(runId, async () => {
      await options.repository.delete(runId);
      documents.delete(runId);
      unpublishedRunIds.delete(runId);
    }),
    withExclusiveRun,
    mutate,
    mutateLocked,
    markEnumerationFailed() { startupEnumerationFailed = true; },
    enumerationFailed: () => startupEnumerationFailed,
    evictCachedTerminal(runId) {
      if (unpublishedRunIds.has(runId)) return;
      const cached = documents.get(runId);
      if (cached === undefined || !isTerminal(cached.state)) return;
      documents.delete(runId);
    },
    async awaitIdle() { await Promise.allSettled(mutationQueues.values()); },
    clear() {
      documents.clear();
      unpublishedRunIds.clear();
    },
  };
}

function clone<T>(value: T): T {
  return globalThis.structuredClone(value);
}
