import { randomUUID } from "node:crypto";
import { nowIso } from "../../kernel/id.js";
import { isMemoryOwner, memoryOwnerKey, type MemoryOwner } from "../../domain/memory/index.js";
import {
  PATH_DEPENDENCY_MAX_EVIDENCE_REFS,
  PATH_DEPENDENCY_MAX_METHODOLOGY_CHARS,
  PATH_DEPENDENCY_MAX_SOURCE_REFS,
  PATH_DEPENDENCY_MAX_TAGS,
  PATH_DEPENDENCY_MAX_TAG_CHARS,
  PATH_DEPENDENCY_MAX_TITLE_CHARS,
  assertPathDependencyMemoryId,
  PathDependencyFeatureError,
  pathDependencyContentVersion,
  type PathDependency,
  type PathDependencyEvent,
  type PathDependencyFeature,
  type PathDependencyRepository,
  type PathDependencySaveInput,
  type PathDependencySourceRef,
  type PathDependencyVerification,
  type PathDependencyVerificationInput,
} from "./contracts.js";
import { searchPathDependencies } from "./search.js";

export type CreatePathDependencyFeatureInput = {
  readonly repository: PathDependencyRepository;
  readonly now?: () => string;
  readonly idFactory?: () => string;
};

export function createPathDependencyFeature(input: CreatePathDependencyFeatureInput): PathDependencyFeature {
  const now = input.now ?? nowIso;
  const idFactory = input.idFactory ?? (() => `path-dependency:${randomUUID()}`);
  const listeners = new Set<(event: PathDependencyEvent) => void>();
  const queues = new Map<string, Promise<void>>();
  const ownerQueues = new Map<string, Promise<void>>();
  const deletedOwners = new Set<string>();
  let released = false;
  let releasePromise: Promise<void> | undefined;

  const enqueue = <T>(memoryId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(memoryId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    queues.set(memoryId, tail);
    void tail.finally(() => {
      if (queues.get(memoryId) === tail) queues.delete(memoryId);
    });
    return result;
  };

  // Owner-level serialization is intentionally narrow: different owners can
  // still proceed independently, while an owner deletion waits for every
  // already-admitted save before taking its repository snapshot.
  const enqueueOwner = <T>(ownerKey: string, operation: () => Promise<T>): Promise<T> => {
    const previous = ownerQueues.get(ownerKey) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    ownerQueues.set(ownerKey, tail);
    void tail.finally(() => {
      if (ownerQueues.get(ownerKey) === tail) ownerQueues.delete(ownerKey);
    });
    return result;
  };

  function assertUsable(action: string): void {
    if (released) throw new PathDependencyFeatureError("path_dependency_feature_released", `PathDependency feature is released and cannot ${action}.`);
  }

  function publish(event: PathDependencyEvent): void {
    for (const listener of listeners) {
      try { listener(structuredClone(event)); } catch { /* projections cannot undo committed facts */ }
    }
  }

  return {
    commands: {
      async save(saveInput) {
        assertUsable("save a dependency");
        // HTTP and tool adapters validate owner identities, but the feature is
        // also a public application port. Reject malformed runtime input here
        // so a caller can never create an unscoped record in a file-backed or
        // in-memory repository by bypassing an adapter.
        if (!isMemoryOwner(saveInput.owner)) {
          throw new PathDependencyFeatureError(
            "path_dependency_invalid_input",
            "A path dependency must have a global, Space, or Workspace owner.",
          );
        }
        assertOwnerWritable(saveInput.owner, deletedOwners);
        if (saveInput.memoryId !== undefined) {
          assertPathDependencyMemoryId(saveInput.memoryId);
          if (saveInput.expectedRevision === undefined) {
            throw new PathDependencyFeatureError(
              "path_dependency_revision_conflict",
              `Path dependency ${saveInput.memoryId} is an update target; expectedRevision is required.`,
            );
          }
        }
        if (saveInput.expectedRevision !== undefined &&
            (!Number.isSafeInteger(saveInput.expectedRevision) || saveInput.expectedRevision <= 0)) {
          throw new PathDependencyFeatureError(
            "path_dependency_invalid_input",
            "expectedRevision must be a positive safe integer.",
          );
        }
        const memoryId = saveInput.memoryId ?? idFactory();
        assertPathDependencyMemoryId(memoryId);
        const operation = async () => {
          const current = await input.repository.get(memoryId);
          if (current === undefined && saveInput.expectedRevision !== undefined) {
            throw new PathDependencyFeatureError(
              "path_dependency_revision_conflict",
              `Path dependency ${memoryId} does not exist; an update requires a current revision.`,
            );
          }
          if (current !== undefined && saveInput.expectedRevision === undefined) {
            throw new PathDependencyFeatureError(
              "path_dependency_revision_conflict",
              `Path dependency ${memoryId} already exists; an update requires expectedRevision ${current.revision}.`,
            );
          }
          if (current !== undefined && !sameOwner(current.owner, saveInput.owner)) {
            throw new PathDependencyFeatureError(
              "path_dependency_revision_conflict",
              `Path dependency ${memoryId} cannot move between owners.`,
            );
          }
          const dependency = buildDependency(saveInput, current, memoryId, now());
          const result = await input.repository.save({
            dependency,
            ...(saveInput.expectedRevision === undefined ? {} : { expectedRevision: saveInput.expectedRevision }),
          });
          if (result.status === "conflict") return result;
          publish({
            type: result.status === "created" ? "path_dependency.created" : "path_dependency.updated",
            dependency: result.dependency,
          });
          return result;
        };
        return saveInput.owner.kind === "global"
          ? enqueue(memoryId, operation)
          : enqueueOwner(memoryOwnerKey(saveInput.owner), () => enqueue(memoryId, operation));
      },
      async delete(command) {
        assertUsable("delete a dependency");
        assertPathDependencyMemoryId(command.memoryId);
        await enqueue(command.memoryId, async () => {
          const deleted = await input.repository.delete(command);
          if (deleted === undefined) {
            throw new PathDependencyFeatureError("path_dependency_not_found", `Path dependency ${command.memoryId} was not found.`);
          }
          publish({
            type: "path_dependency.deleted",
            memoryId: deleted.id,
            owner: deleted.owner,
            revision: deleted.revision,
          });
        });
      },
      async deleteByOwner(owner) {
        assertUsable("delete dependencies for an owner");
        // The public type excludes global, but this command is also reachable
        // from JavaScript/host adapters. Keep the runtime check without
        // widening the contract just to satisfy malformed callers.
        if (!isConcreteMemoryOwner(owner)) {
          throw new PathDependencyFeatureError(
            "path_dependency_invalid_input",
            "Owner deletion requires a concrete Space or Workspace owner.",
          );
        }
        const ownerKey = memoryOwnerKey(owner);
        // Set the tombstone before the first await. New saves are rejected;
        // saves already admitted to ownerQueues drain before list() runs.
        deletedOwners.add(ownerKey);
        return await enqueueOwner(ownerKey, async () => {
          const dependencies = await input.repository.list({ owners: [owner] });
          let deletedCount = 0;
          for (const dependency of dependencies) {
            await enqueue(dependency.id, async () => {
              const current = await input.repository.get(dependency.id);
              if (current === undefined || !sameOwner(current.owner, owner)) return;
              const deleted = await input.repository.delete({
                memoryId: current.id,
                expectedRevision: current.revision,
              });
              if (deleted === undefined) return;
              deletedCount += 1;
              publish({
                type: "path_dependency.deleted",
                memoryId: deleted.id,
                owner: deleted.owner,
                revision: deleted.revision,
              });
            });
          }
          return deletedCount;
        });
      },
    },
    queries: {
      get(memoryId) {
        assertUsable("read a dependency");
        assertPathDependencyMemoryId(memoryId);
        return input.repository.get(memoryId);
      },
      list(query) {
        assertUsable("list dependencies");
        return input.repository.list(query);
      },
      async search(searchInput) {
        assertUsable("search dependencies");
        const dependencies = await input.repository.list({ owners: searchInput.owners });
        return searchPathDependencies(dependencies, searchInput);
      },
      async directory(directoryInput) {
        assertUsable("build a dependency directory");
        const dependencies = await input.repository.list({
          owners: directoryInput.owners,
          limit: directoryInput.limit ?? 24,
        });
        const excerptChars = Math.max(0, Math.floor(directoryInput.excerptChars ?? 180));
        return dependencies.map((dependency) => ({
          id: dependency.id,
          kind: "path_dependency" as const,
          owner: dependency.owner,
          title: dependency.title,
          excerpt: dependency.methodology.slice(0, excerptChars),
          revision: dependency.revision,
          contentVersion: dependency.contentVersion,
          verification: dependency.verification.status,
          tags: dependency.tags,
        }));
      },
    },
    events: {
      subscribe(listener) {
        assertUsable("subscribe to dependency events");
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    release() {
      if (releasePromise !== undefined) return releasePromise;
      released = true;
      listeners.clear();
      releasePromise = (async () => {
        while (queues.size > 0 || ownerQueues.size > 0) {
          await Promise.allSettled([...queues.values(), ...ownerQueues.values()]);
        }
      })();
      return releasePromise;
    },
  };
}

function buildDependency(
  input: PathDependencySaveInput,
  current: PathDependency | undefined,
  memoryId: string,
  timestamp: string,
): PathDependency {
  const title = boundedText(input.title, PATH_DEPENDENCY_MAX_TITLE_CHARS, "title");
  const methodology = boundedText(input.methodology, PATH_DEPENDENCY_MAX_METHODOLOGY_CHARS, "methodology");
  const tags = uniqueTags(input.tags ?? current?.tags ?? []);
  const sourceRunRefs = mergeSourceRunRefs(current?.sourceRunRefs ?? [], input.sourceRunRefs ?? []);
  const evidenceRefs = boundedRefs(input.evidenceRefs ?? current?.evidenceRefs ?? [], PATH_DEPENDENCY_MAX_EVIDENCE_REFS, "evidenceRefs");
  const verification = normalizeVerification(input.verification, current?.verification);
  const contentVersion = pathDependencyContentVersion({ title, methodology, tags, verification, evidenceRefs });
  const createdBy = current?.createdBy ?? input.createdBy ?? "agent";
  if (createdBy !== "agent" && createdBy !== "user") {
    throw new PathDependencyFeatureError("path_dependency_invalid_input", "createdBy must be agent or user.");
  }
  return {
    id: memoryId,
    owner: input.owner,
    title,
    methodology,
    sourceRunRefs,
    verification,
    evidenceRefs,
    revision: current === undefined ? 1 : current.revision + 1,
    contentVersion,
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
    createdBy,
    tags,
  };
}

function normalizeVerification(
  value: PathDependencyVerificationInput | undefined,
  current: PathDependencyVerification | undefined,
): PathDependencyVerification {
  if (value !== undefined &&
      (typeof value !== "object" || value === null ||
        (value.status !== "not_recorded" && value.status !== "observed"))) {
    throw new PathDependencyFeatureError(
      "path_dependency_invalid_input",
      "verification.status must be not_recorded or observed.",
    );
  }
  return {
    status: value?.status ?? current?.status ?? "not_recorded",
  };
}

function boundedSourceRefs(value: readonly PathDependencySourceRef[]): readonly PathDependencySourceRef[] {
  if (!Array.isArray(value) || value.length > PATH_DEPENDENCY_MAX_SOURCE_REFS) {
    throw new PathDependencyFeatureError("path_dependency_invalid_input", `sourceRunRefs must be an array with at most ${PATH_DEPENDENCY_MAX_SOURCE_REFS} entries.`);
  }
  return value.map((ref) => {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      throw new PathDependencyFeatureError("path_dependency_invalid_input", "sourceRunRefs entries must be objects.");
    }
    const candidate = ref as {
      readonly runId?: unknown;
      readonly conversationId?: unknown;
      readonly title?: unknown;
    };
    return {
      runId: boundedText(candidate.runId, 256, "sourceRunRefs.runId"),
      ...(candidate.conversationId === undefined ? {} : { conversationId: boundedText(candidate.conversationId, 256, "sourceRunRefs.conversationId") }),
      ...(candidate.title === undefined ? {} : { title: boundedText(candidate.title, 240, "sourceRunRefs.title") }),
    };
  });
}

function mergeSourceRunRefs(
  current: readonly PathDependencySourceRef[],
  additions: readonly PathDependencySourceRef[],
): readonly PathDependencySourceRef[] {
  const merged = new Map<string, PathDependencySourceRef>();
  const normalizedCurrent = boundedSourceRefs(current);
  const normalizedAdditions = boundedSourceRefs(additions);
  for (const source of [...normalizedCurrent, ...normalizedAdditions]) {
    const key = `${source.runId}:${source.conversationId ?? ""}`;
    merged.set(key, source);
  }
  return [...merged.values()];
}

function boundedRefs(value: readonly string[], max: number, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > max) throw new PathDependencyFeatureError("path_dependency_invalid_input", `${label} must be an array with at most ${max} entries.`);
  return [...new Set(value.map((item) => boundedText(item, 512, label)))];
}

function uniqueTags(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > PATH_DEPENDENCY_MAX_TAGS) throw new PathDependencyFeatureError("path_dependency_invalid_input", `tags must be an array with at most ${PATH_DEPENDENCY_MAX_TAGS} entries.`);
  return [...new Set(value.map((tag) => boundedText(tag, PATH_DEPENDENCY_MAX_TAG_CHARS, "tags")))];
}

function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new PathDependencyFeatureError("path_dependency_invalid_input", `${label} must be a non-empty string.`);
  if (value.length > max) throw new PathDependencyFeatureError("path_dependency_invalid_input", `${label} exceeds ${max} characters.`);
  return value;
}

function sameOwner(left: MemoryOwner, right: MemoryOwner): boolean {
  return memoryOwnerKey(left) === memoryOwnerKey(right);
}

function isConcreteMemoryOwner(
  value: unknown,
): value is Exclude<MemoryOwner, { readonly kind: "global" }> {
  return isMemoryOwner(value) && value.kind !== "global";
}

function assertOwnerWritable(owner: MemoryOwner, deletedOwners: ReadonlySet<string>): void {
  if (owner.kind === "global") return;
  if (deletedOwners.has(memoryOwnerKey(owner))) {
    throw new PathDependencyFeatureError(
      "path_dependency_owner_deleted",
      `The ${owner.kind} owner ${owner.id} is being deleted or has already been deleted; path dependencies cannot be recreated.`,
    );
  }
}
