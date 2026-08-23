import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { isNodeError, toPersistedJsonShape } from "../../kernel/values/index.js";
import {
  assertRunSnapshotCodec,
  decodeRunSnapshot,
  requireRunId,
  RunSnapshotStoreError,
  validateRunSnapshotForStorage,
  type RunEnvelope,
  type RunSnapshotCodec,
  type RunSnapshotStore,
} from "./run-snapshot-contracts.js";

const RUN_SNAPSHOT_MANIFEST_SCHEMA_VERSION = "run-snapshot-manifest/v1" as const;

const snapshotDocumentSchema = z.object({
  schemaVersion: z.string().min(1),
  snapshot: z.unknown(),
}).strict();

const runEnvelopeSchema = z.object({
  runId: z.string().min(1),
  updatedAt: z.string().min(1),
  status: z.string().min(1),
  runKind: z.string().min(1).optional(),
  runMode: z.string().min(1).optional(),
  rootRunId: z.string().min(1).optional(),
  parentRunId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
}).strict();

const manifestDocumentSchema = z.object({
  schemaVersion: z.literal(RUN_SNAPSHOT_MANIFEST_SCHEMA_VERSION),
  snapshotSchemaVersion: z.string().min(1),
  entries: z.array(runEnvelopeSchema),
}).strict();

type SnapshotDocument = z.infer<typeof snapshotDocumentSchema>;

export function createFileSystemRunSnapshotStore<TSnapshot>(input: {
  readonly rootDir: string;
  readonly getEnvelope: (snapshot: TSnapshot) => RunEnvelope;
  readonly codec: RunSnapshotCodec<TSnapshot>;
  readonly fileName?: string;
}): RunSnapshotStore<TSnapshot> {
  assertRunSnapshotCodec(input.codec);
  const rootDir = requireRootDirectory(input.rootDir);
  const fileName = requireFileName(input.fileName ?? "record.json");
  const runQueues = new Map<string, Promise<void>>();
  let manifestQueue = Promise.resolve();
  let manifestEntries: Map<string, RunEnvelope> | undefined;
  let manifestDirty = false;

  function enqueueRun<TResult>(runId: string, operation: () => Promise<TResult>): Promise<TResult> {
    const previous = runQueues.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    runQueues.set(runId, tail);
    void tail.finally(() => {
      if (runQueues.get(runId) === tail) runQueues.delete(runId);
    });
    return result;
  }

  function enqueueManifest<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = manifestQueue.then(operation, operation);
    manifestQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function currentManifest(forceRepair = false): Promise<Map<string, RunEnvelope>> {
    if (!forceRepair && !manifestDirty && manifestEntries !== undefined) return manifestEntries;

    // A manifest is only a disposable projection. On cold start (and after any
    // index failure), rebuild from committed snapshot documents so a crash
    // between snapshot rename and manifest update cannot hide a run.
    const stored = forceRepair ? undefined : await readManifest(rootDir, input.codec.schemaVersion);
    const rebuilt = new Map((await scanSnapshotEnvelopes({
      rootDir,
      fileName,
      codec: input.codec,
      getEnvelope: input.getEnvelope,
    })).map((entry) => [entry.runId, entry]));
    manifestEntries = rebuilt;
    manifestDirty = false;
    if (stored === undefined || !sameManifestEntries(stored, rebuilt)) {
      try {
        await writeManifest(rootDir, input.codec.schemaVersion, sortedEnvelopes(rebuilt.values()));
      } catch {
        manifestDirty = true;
      }
    }
    return rebuilt;
  }

  async function updateManifest(update: (entries: Map<string, RunEnvelope>) => void): Promise<void> {
    await enqueueManifest(async () => {
      const next = new Map(await currentManifest());
      update(next);
      manifestEntries = next;
      try {
        await writeManifest(rootDir, input.codec.schemaVersion, sortedEnvelopes(next.values()));
        manifestDirty = false;
      } catch (error) {
        // The versioned snapshot document is the commit. Keep the in-process
        // projection usable and force a snapshot scan on the next index access.
        manifestDirty = true;
        throw error;
      }
    });
  }

  return {
    async upsert(snapshot: TSnapshot): Promise<TSnapshot> {
      const prepared = validateRunSnapshotForStorage({
        value: snapshot,
        codec: input.codec,
        getEnvelope: input.getEnvelope,
      });
      return enqueueRun(prepared.envelope.runId, async () => {
        const document: SnapshotDocument = {
          schemaVersion: input.codec.schemaVersion,
          snapshot: prepared.snapshot,
        };
        await writeJsonFileAtomically(
          snapshotPath(rootDir, prepared.envelope.runId, fileName),
          document,
        );
        await updateManifest((entries) => entries.set(prepared.envelope.runId, prepared.envelope))
          .catch(() => undefined);
        return toPersistedJsonShape(prepared.snapshot);
      });
    },

    async get(runId: string): Promise<TSnapshot | undefined> {
      const ownerId = requireRunId(runId);
      await (runQueues.get(ownerId) ?? Promise.resolve());
      const decoded = await readSnapshot({
        rootDir,
        fileName,
        runId: ownerId,
        codec: input.codec,
        getEnvelope: input.getEnvelope,
      });
      return decoded === undefined ? undefined : toPersistedJsonShape(decoded.snapshot);
    },

    async list(limit = 50): Promise<readonly TSnapshot[]> {
      const normalizedLimit = normalizedListLimit(limit);
      if (normalizedLimit === 0) return [];
      await Promise.allSettled([...runQueues.values()]);
      const indexed = await enqueueManifest(async () =>
        sortedEnvelopes((await currentManifest()).values()));
      const available: Array<{ readonly snapshot: TSnapshot; readonly envelope: RunEnvelope }> = [];
      const invalidRunIds: string[] = [];
      for (const entry of indexed) {
        try {
          const decoded = await readSnapshot({
            rootDir,
            fileName,
            runId: entry.runId,
            codec: input.codec,
            getEnvelope: input.getEnvelope,
          });
          if (decoded === undefined) {
            invalidRunIds.push(entry.runId);
            continue;
          }
          available.push(decoded);
        } catch (error) {
          if (!(error instanceof RunSnapshotStoreError)) throw error;
          invalidRunIds.push(entry.runId);
        }
      }
      if (invalidRunIds.length > 0) {
        await updateManifest((entries) => {
          for (const runId of invalidRunIds) entries.delete(runId);
        }).catch(() => undefined);
      }
      return available
        .sort((left, right) => compareRunEnvelopeByRecency(left.envelope, right.envelope))
        .slice(0, normalizedLimit)
        .map(({ snapshot }) => toPersistedJsonShape(snapshot));
    },

    delete(runId: string): Promise<void> {
      const ownerId = requireRunId(runId);
      return enqueueRun(ownerId, async () => {
        await fs.rm(runDirectory(rootDir, ownerId), { recursive: true, force: true });
        await updateManifest((entries) => entries.delete(ownerId)).catch(() => undefined);
      });
    },
  };
}

async function readSnapshot<TSnapshot>(input: {
  readonly rootDir: string;
  readonly fileName: string;
  readonly runId: string;
  readonly codec: RunSnapshotCodec<TSnapshot>;
  readonly getEnvelope: (snapshot: TSnapshot) => RunEnvelope;
}): Promise<{ readonly snapshot: TSnapshot; readonly envelope: RunEnvelope } | undefined> {
  const raw = await readJsonFile(snapshotPath(input.rootDir, input.runId, input.fileName), input.runId);
  if (raw === undefined) return undefined;
  const document = snapshotDocumentSchema.safeParse(raw);
  if (!document.success) {
    throw new RunSnapshotStoreError(
      "snapshot_incompatible",
      `Run snapshot ${input.runId} has an invalid persistence document: ${z.prettifyError(document.error)}`,
    );
  }
  if (document.data.schemaVersion !== input.codec.schemaVersion) {
    throw new RunSnapshotStoreError(
      "snapshot_schema_version_mismatch",
      `Run snapshot ${input.runId} uses ${document.data.schemaVersion}; expected ${input.codec.schemaVersion}.`,
    );
  }
  return decodeRunSnapshot({
    value: document.data.snapshot,
    codec: input.codec,
    getEnvelope: input.getEnvelope,
    expectedRunId: input.runId,
  });
}

async function scanSnapshotEnvelopes<TSnapshot>(input: {
  readonly rootDir: string;
  readonly fileName: string;
  readonly codec: RunSnapshotCodec<TSnapshot>;
  readonly getEnvelope: (snapshot: TSnapshot) => RunEnvelope;
}): Promise<readonly RunEnvelope[]> {
  const entries = await fs.readdir(input.rootDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  });
  const decoded = await Promise.allSettled(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const runId = runIdFromDirectoryName(entry.name);
      if (runId === undefined) return undefined;
      return readSnapshot({ ...input, runId });
    }));
  const envelopes: RunEnvelope[] = [];
  for (const item of decoded) {
    if (item.status === "fulfilled") {
      if (item.value !== undefined) envelopes.push(item.value.envelope);
      continue;
    }
    if (item.reason instanceof RunSnapshotStoreError) continue;
    throw item.reason;
  }
  return sortedEnvelopes(envelopes);
}

async function readManifest(
  rootDir: string,
  snapshotSchemaVersion: string,
): Promise<Map<string, RunEnvelope> | undefined> {
  try {
    const raw = await readJsonFile(manifestPath(rootDir), "manifest");
    if (raw === undefined) return undefined;
    const parsed = manifestDocumentSchema.safeParse(raw);
    if (!parsed.success || parsed.data.snapshotSchemaVersion !== snapshotSchemaVersion) return undefined;
    return new Map(parsed.data.entries.map((entry) => [entry.runId, entry]));
  } catch {
    // The manifest is disposable, including filesystem-shape corruption such as
    // a directory at manifest.json. Snapshot documents remain authoritative.
    return undefined;
  }
}
async function writeManifest(
  rootDir: string,
  snapshotSchemaVersion: string,
  entries: readonly RunEnvelope[],
): Promise<void> {
  const manifest = manifestDocumentSchema.parse({
    schemaVersion: RUN_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    snapshotSchemaVersion,
    entries,
  });
  await writeJsonFileAtomically(manifestPath(rootDir), manifest);
}

function sameManifestEntries(stored: Map<string, RunEnvelope>, rebuilt: Map<string, RunEnvelope>): boolean {
  if (stored.size !== rebuilt.size) return false;
  for (const [runId, envelope] of rebuilt) {
    if (JSON.stringify(stored.get(runId)) !== JSON.stringify(envelope)) return false;
  }
  return true;
}

function sortedEnvelopes(entries: Iterable<RunEnvelope>): RunEnvelope[] {
  return [...entries].sort(compareRunEnvelopeByRecency);
}

function compareRunEnvelopeByRecency(left: RunEnvelope, right: RunEnvelope): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function normalizedListLimit(limit: number): number {
  if (!Number.isFinite(limit)) return limit > 0 ? Number.MAX_SAFE_INTEGER : 0;
  return Math.max(0, Math.floor(limit));
}

function requireRootDirectory(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunSnapshotStoreError(
      "invalid_snapshot_store_configuration",
      "Run snapshot rootDir must be a non-empty path.",
    );
  }
  return path.resolve(value);
}

function requireFileName(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value === "." ||
    value === ".." ||
    path.basename(value) !== value
  ) {
    throw new RunSnapshotStoreError(
      "invalid_snapshot_store_configuration",
      "Run snapshot fileName must be one non-empty path segment.",
    );
  }
  return value;
}

function snapshotPath(rootDir: string, runId: string, fileName: string): string {
  return path.join(runDirectory(rootDir, runId), fileName);
}

function runDirectory(rootDir: string, runId: string): string {
  return path.join(rootDir, safeRunDirectoryName(runId));
}

function safeRunDirectoryName(runId: string): string {
  const encoded = encodeURIComponent(requireRunId(runId));
  if (encoded === ".") return "%2E";
  if (encoded === "..") return "%2E%2E";
  return encoded;
}

function runIdFromDirectoryName(directoryName: string): string | undefined {
  try {
    const runId = decodeURIComponent(directoryName);
    requireRunId(runId);
    return safeRunDirectoryName(runId) === directoryName ? runId : undefined;
  } catch {
    return undefined;
  }
}

function manifestPath(rootDir: string): string {
  return path.join(rootDir, "manifest.json");
}

async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const targetDirectory = path.dirname(filePath);
  const tempPath = path.join(
    targetDirectory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.mkdir(targetDirectory, { recursive: true });
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await renameWithRetry(tempPath, filePath).catch(async (error: unknown) => {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  });
}

async function readJsonFile(filePath: string, ownerId: string): Promise<unknown | undefined> {
  let content: string | undefined;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (isNodeError(error, "EISDIR") || isNodeError(error, "ENOTDIR")) {
      throw new RunSnapshotStoreError(
        "snapshot_incompatible",
        `Run snapshot persistence entry ${ownerId} has an invalid filesystem shape.`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    return JSON.parse(content) as unknown;
  } catch (cause) {
    throw new RunSnapshotStoreError(
      "snapshot_incompatible",
      `Run snapshot persistence entry ${ownerId} contains invalid JSON.`,
      { cause },
    );
  }
}
