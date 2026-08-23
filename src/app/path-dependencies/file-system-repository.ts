import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { isNodeError, toPersistedJsonShape } from "../../kernel/values/index.js";
import {
  PATH_DEPENDENCY_SCHEMA_VERSION,
  assertPathDependencyMemoryId,
  PathDependencyFeatureError,
  type PathDependency,
  type PathDependencyDocument,
  type PathDependencyListQuery,
  type PathDependencyRepository,
  type PathDependencySaveResult,
} from "./contracts.js";

const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("space"), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("workspace"), id: z.string().min(1) }).strict(),
]);

const sourceRefSchema = z.object({
  runId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
}).strict();

const verificationSchema = z.object({
  status: z.enum(["not_recorded", "observed"]),
}).strict();

const dependencySchema = z.object({
  id: z.string().min(1),
  owner: ownerSchema,
  title: z.string().min(1),
  methodology: z.string().min(1),
  sourceRunRefs: z.array(sourceRefSchema),
  verification: verificationSchema,
  evidenceRefs: z.array(z.string().min(1)),
  revision: z.number().int().positive(),
  contentVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  createdBy: z.enum(["agent", "user"]),
  tags: z.array(z.string().min(1)),
}).strict();

const documentSchema = z.object({
  schemaVersion: z.literal(PATH_DEPENDENCY_SCHEMA_VERSION),
  dependency: dependencySchema,
}).strict();

export function validatePathDependency(value: unknown): PathDependency {
  const result = dependencySchema.safeParse(value);
  if (!result.success) {
    const id = typeof value === "object" && value !== null && "id" in value
      ? String((value as { id?: unknown }).id)
      : "unknown";
    throw new PathDependencyFeatureError(
      "path_dependency_snapshot_incompatible",
      `Path dependency ${id} is incompatible with ${PATH_DEPENDENCY_SCHEMA_VERSION}: ${z.prettifyError(result.error)}`,
    );
  }
  return toPathDependency(result.data);
}

/**
 * File-backed current-head repository. The runtime directory is intentionally
 * outside Synech SQLite/backup ownership; deleting a record removes its only
 * durable body. The Panel runtime lease is the cross-process single-writer
 * boundary; the per-id queue closes the in-process race.
 */
export function createFileSystemPathDependencyRepository(rootDir: string): PathDependencyRepository {
  const recordsDir = path.join(rootDir, "records");
  const queues = new Map<string, Promise<void>>();

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

  return {
    save(input) {
      assertPathDependencyMemoryId(input.dependency.id);
      return enqueue(input.dependency.id, async () => {
        const current = await readRecord(recordsDir, input.dependency.id);
        if (current === undefined) {
          if (input.expectedRevision !== undefined) {
            throw new PathDependencyFeatureError(
              "path_dependency_revision_conflict",
              `Path dependency ${input.dependency.id} does not exist for revision ${input.expectedRevision}.`,
            );
          }
        } else if (input.expectedRevision !== current.revision) {
          return { status: "conflict", current } satisfies PathDependencySaveResult;
        }
        try {
          await writeRecord(recordsDir, input.dependency);
        } catch (error) {
          throw new PathDependencyFeatureError(
            "path_dependency_repository_failure",
            `Path dependency ${input.dependency.id} could not be persisted.`,
            { cause: error },
          );
        }
        return {
          status: current === undefined ? "created" : "updated",
          dependency: input.dependency,
        } satisfies PathDependencySaveResult;
      });
    },
    get(memoryId) {
      assertPathDependencyMemoryId(memoryId);
      return readRecord(recordsDir, memoryId);
    },
    async list(query?: PathDependencyListQuery) {
      let entries: readonly Dirent[];
      try {
        entries = await fs.readdir(recordsDir, { withFileTypes: true });
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return [];
        throw new PathDependencyFeatureError("path_dependency_repository_failure", `Could not list ${recordsDir}.`, { cause: error });
      }
      const owners = query?.owners === undefined ? undefined : new Set(query.owners.map(ownerKey));
      const records: PathDependency[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const memoryId = decodeRecordName(entry.name);
        const record = await readRecord(recordsDir, memoryId);
        if (record === undefined) continue;
        if (owners !== undefined && !owners.has(ownerKey(record.owner))) continue;
        records.push(record);
      }
      records.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
      const limit = query?.limit === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, Math.floor(query.limit));
      return records.slice(0, limit);
    },
    delete(input) {
      assertPathDependencyMemoryId(input.memoryId);
      return enqueue(input.memoryId, async () => {
        const current = await readRecord(recordsDir, input.memoryId);
        if (current === undefined) return undefined;
        if (current.revision !== input.expectedRevision) {
          throw new PathDependencyFeatureError(
            "path_dependency_revision_conflict",
            `Path dependency ${input.memoryId} is at revision ${current.revision}, not ${input.expectedRevision}.`,
          );
        }
        try {
          await fs.rm(recordPath(recordsDir, input.memoryId), { force: true });
        } catch (error) {
          throw new PathDependencyFeatureError(
            "path_dependency_repository_failure",
            `Path dependency ${input.memoryId} could not be deleted.`,
            { cause: error },
          );
        }
        return current;
      });
    },
  };
}

export function createInMemoryPathDependencyRepository(): PathDependencyRepository {
  const records = new Map<string, PathDependency>();
  return {
    async save(input) {
      assertPathDependencyMemoryId(input.dependency.id);
      const current = records.get(input.dependency.id);
      if (current === undefined && input.expectedRevision !== undefined) {
        throw new PathDependencyFeatureError("path_dependency_revision_conflict", "The memory does not exist.");
      }
      if (current !== undefined && current.revision !== input.expectedRevision) {
        return { status: "conflict", current };
      }
      records.set(input.dependency.id, structuredClone(input.dependency));
      return { status: current === undefined ? "created" : "updated", dependency: structuredClone(input.dependency) };
    },
    async get(memoryId) {
      assertPathDependencyMemoryId(memoryId);
      const record = records.get(memoryId);
      return record === undefined ? undefined : structuredClone(record);
    },
    async list(query) {
      const owners = query?.owners === undefined ? undefined : new Set(query.owners.map(ownerKey));
      const result = [...records.values()]
        .filter((record) => owners === undefined || owners.has(ownerKey(record.owner)))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return result
        .slice(0, query?.limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.floor(query.limit)))
        .map((record) => structuredClone(record));
    },
    async delete(input) {
      assertPathDependencyMemoryId(input.memoryId);
      const current = records.get(input.memoryId);
      if (current === undefined) return undefined;
      if (current.revision !== input.expectedRevision) {
        throw new PathDependencyFeatureError("path_dependency_revision_conflict", "The memory revision is stale.");
      }
      records.delete(input.memoryId);
      return structuredClone(current);
    },
  };
}

async function readRecord(recordsDir: string, memoryId: string): Promise<PathDependency | undefined> {
  const file = recordPath(recordsDir, memoryId);
  const content = await fs.readFile(file, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw new PathDependencyFeatureError("path_dependency_repository_failure", `Could not read ${file}.`, { cause: error });
  });
  if (content === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch (error) {
    throw new PathDependencyFeatureError("path_dependency_snapshot_incompatible", `Stored path dependency ${memoryId} is not valid JSON.`, { cause: error });
  }
  const result = documentSchema.safeParse(raw);
  if (!result.success || result.data.dependency.id !== memoryId) {
    throw new PathDependencyFeatureError(
      "path_dependency_snapshot_incompatible",
      `Stored path dependency ${memoryId} is incompatible with ${PATH_DEPENDENCY_SCHEMA_VERSION}.`,
    );
  }
  return toPathDependency(result.data.dependency);
}

function toPathDependency(value: z.infer<typeof dependencySchema>): PathDependency {
  // The schema above proves the template-literal refinement before this
  // persisted JSON projection crosses the repository boundary.
  return toPersistedJsonShape({
    ...value,
    contentVersion: value.contentVersion as PathDependency["contentVersion"],
  });
}

async function writeRecord(recordsDir: string, dependency: PathDependency): Promise<void> {
  const file = recordPath(recordsDir, dependency.id);
  const tempDir = path.join(recordsDir, ".tmp");
  const temp = path.join(tempDir, `${encodeURIComponent(dependency.id)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const document: PathDependencyDocument = { schemaVersion: PATH_DEPENDENCY_SCHEMA_VERSION, dependency };
  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(recordsDir, { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await renameWithRetry(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function recordPath(recordsDir: string, memoryId: string): string {
  assertPathDependencyMemoryId(memoryId);
  return path.join(recordsDir, `${encodeURIComponent(memoryId)}.json`);
}

function decodeRecordName(name: string): string {
  try {
    const memoryId = decodeURIComponent(name.slice(0, -".json".length));
    assertPathDependencyMemoryId(memoryId);
    return memoryId;
  } catch (error) {
    if (error instanceof PathDependencyFeatureError && error.code === "path_dependency_invalid_input") {
      throw new PathDependencyFeatureError(
        "path_dependency_snapshot_incompatible",
        `Invalid path dependency record name ${name}.`,
        { cause: error },
      );
    }
    throw new PathDependencyFeatureError("path_dependency_snapshot_incompatible", `Invalid path dependency record name ${name}.`, { cause: error });
  }
}

function ownerKey(owner: PathDependency["owner"]): string {
  return owner.kind === "global" ? "global" : `${owner.kind}:${owner.id}`;
}
