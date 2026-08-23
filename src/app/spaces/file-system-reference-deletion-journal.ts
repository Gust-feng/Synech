import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, promises as fs, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { isNodeError, toPersistedJsonShape } from "../../kernel/values/index.js";
import { SpaceFeatureError, type SpaceReferenceItem } from "./contracts.js";
import { spaceReferenceAnnotationSchema, spaceReferenceImageCaptionsSchema, spaceReferenceSchema } from "./space-validation.js";

const SPACE_REFERENCE_DELETION_SCHEMA_VERSION = "space-reference-deletion/v1" as const;
const SAFE_DELETION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const JOURNAL_FILE_EXTENSION = ".json";
const TEMP_DIRECTORY_NAME = ".tmp";
const WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(["EINVAL", "EPERM", "ENOTSUP", "EISDIR"]);

export type SpaceReferenceDeletionPhase = "prepared" | "files_staged" | "metadata_committed";

export type SpaceReferenceDeletionTarget = {
  readonly referenceId: string;
  readonly kind: "local_file" | "managed_folder";
  readonly sourcePath: string;
  readonly stagedPath: string;
};

export type SpaceReferenceDeletionJournalRecord = {
  readonly schemaVersion: typeof SPACE_REFERENCE_DELETION_SCHEMA_VERSION;
  readonly deletionId: string;
  readonly phase: SpaceReferenceDeletionPhase;
  readonly rootReferenceId: string;
  readonly removedReferences: readonly SpaceReferenceItem[];
  /** Synech assets whose metadata is removed in the same committed deletion. */
  readonly ownedAssetIds?: readonly string[];
  readonly targets: readonly SpaceReferenceDeletionTarget[];
  readonly createdAt: string;
};

export interface SpaceReferenceDeletionJournalStore {
  readonly mutationKey: string;
  list(): Promise<readonly SpaceReferenceDeletionJournalRecord[]>;
  save(record: SpaceReferenceDeletionJournalRecord): Promise<void>;
  delete(deletionId: string): Promise<void>;
}

export function inspectFileSystemSpaceReferenceDeletionJournal(
  rootDir: string,
): "idle" | "pending" {
  const journalRoot = path.resolve(rootDir);
  try {
    if (!existsSync(journalRoot)) return "idle";
    const stat = lstatSync(journalRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw incompatibleJournal(`Space deletion journal root must be a real directory: ${journalRoot}`);
    }
    return readdirSync(journalRoot).some((entry) => entry.endsWith(JOURNAL_FILE_EXTENSION))
      ? "pending"
      : "idle";
  } catch (error) {
    throw normalizeJournalError(error, `Could not inspect Space deletion journals in ${journalRoot}`);
  }
}

const safeDeletionIdSchema = z.string().regex(SAFE_DELETION_ID);

const referenceItemSchema: z.ZodType<SpaceReferenceItem> = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  parentId: z.string().min(1).optional(),
  reference: spaceReferenceSchema,
  sourceIdentity: z.string().min(1).optional(),
  annotation: spaceReferenceAnnotationSchema.optional(),
  imageCaptions: spaceReferenceImageCaptionsSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

const deletionTargetSchema: z.ZodType<SpaceReferenceDeletionTarget> = z.object({
  referenceId: z.string().min(1),
  kind: z.enum(["local_file", "managed_folder"]),
  sourcePath: z.string().min(1),
  stagedPath: z.string().min(1),
}).strict();

const journalRecordSchema: z.ZodType<SpaceReferenceDeletionJournalRecord> = z.object({
  schemaVersion: z.literal(SPACE_REFERENCE_DELETION_SCHEMA_VERSION),
  deletionId: safeDeletionIdSchema,
  phase: z.enum(["prepared", "files_staged", "metadata_committed"]),
  rootReferenceId: z.string().min(1),
  removedReferences: z.array(referenceItemSchema).min(1),
  ownedAssetIds: z.array(z.string().min(1)).optional().default([]),
  targets: z.array(deletionTargetSchema),
  createdAt: z.string().min(1),
}).strict().superRefine((record, context) => {
  const references = new Map<string, SpaceReferenceItem>();
  for (const [index, reference] of record.removedReferences.entries()) {
    if (references.has(reference.id)) {
      context.addIssue({
        code: "custom",
        path: ["removedReferences", index, "id"],
        message: "removed reference ids must be unique",
      });
    }
    references.set(reference.id, reference);
  }
  if (!references.has(record.rootReferenceId)) {
    context.addIssue({
      code: "custom",
      path: ["rootReferenceId"],
      message: "root reference must be present in removedReferences",
    });
  }
  const targetReferenceIds = new Set<string>();
  for (const [index, target] of record.targets.entries()) {
    if (targetReferenceIds.has(target.referenceId)) {
      context.addIssue({
        code: "custom",
        path: ["targets", index, "referenceId"],
        message: "deletion target reference ids must be unique",
      });
    }
    targetReferenceIds.add(target.referenceId);
    const reference = references.get(target.referenceId);
    if (reference === undefined || reference.reference.kind !== target.kind) {
      context.addIssue({
        code: "custom",
        path: ["targets", index, "referenceId"],
        message: "deletion target must match an owned removed reference",
      });
      continue;
    }
    const sourcePath = path.resolve(reference.reference.path);
    if (target.sourcePath !== sourcePath) {
      context.addIssue({
        code: "custom",
        path: ["targets", index, "sourcePath"],
        message: "deletion target source must match its removed reference",
      });
    }
    const expectedStagedPath = path.join(
      path.dirname(sourcePath),
      `.${path.basename(sourcePath)}.synech-delete-${record.deletionId}-${index}`,
    );
    if (target.stagedPath !== expectedStagedPath) {
      context.addIssue({
        code: "custom",
        path: ["targets", index, "stagedPath"],
        message: "deletion target staged path must be the deterministic source sibling",
      });
    }
  }
});

export function createFileSystemSpaceReferenceDeletionJournal(
  rootDir: string,
): SpaceReferenceDeletionJournalStore {
  const journalRoot = path.resolve(rootDir);
  const tempRoot = path.join(journalRoot, TEMP_DIRECTORY_NAME);

  return {
    mutationKey: journalRoot,

    async list(): Promise<readonly SpaceReferenceDeletionJournalRecord[]> {
      try {
        await ensureDirectories(journalRoot, tempRoot);
        await removeOrphanedTempFiles(tempRoot);
        const entries = await fs.readdir(journalRoot, { withFileTypes: true });
        const records: SpaceReferenceDeletionJournalRecord[] = [];
        for (const entry of entries) {
          if (!entry.name.endsWith(JOURNAL_FILE_EXTENSION)) continue;
          if (!entry.isFile()) {
            throw incompatibleJournal(`Space deletion journal entry is not a regular file: ${entry.name}`);
          }
          const deletionId = entry.name.slice(0, -JOURNAL_FILE_EXTENSION.length);
          assertSafeDeletionId(deletionId, `Space deletion journal filename is invalid: ${entry.name}`);
          const filePath = path.join(journalRoot, entry.name);
          const record = await readJournalRecord(filePath);
          if (record.deletionId !== deletionId) {
            throw incompatibleJournal(`Space deletion journal id does not match its filename: ${entry.name}`);
          }
          records.push(record);
        }
        records.sort(compareDeletionIds);
        return records;
      } catch (error) {
        throw normalizeJournalError(error, `Could not list Space deletion journals in ${journalRoot}`);
      }
    },

    async save(record: SpaceReferenceDeletionJournalRecord): Promise<void> {
      const validated = validateJournalRecord(record, "Space deletion journal record is invalid");
      const targetPath = journalPath(journalRoot, validated.deletionId);
      const tempPath = path.join(
        tempRoot,
        `${validated.deletionId}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
      );
      try {
        await ensureDirectories(journalRoot, tempRoot);
        await writeSyncedTempFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`);
        await renameWithRetry(tempPath, targetPath);
        await fsyncDirectory(journalRoot);
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw normalizeJournalError(error, `Could not persist Space deletion journal ${validated.deletionId}`);
      }
    },

    async delete(deletionId: string): Promise<void> {
      assertSafeDeletionId(deletionId, "Space deletion journal id is invalid");
      try {
        await fs.mkdir(journalRoot, { recursive: true });
        await fs.rm(journalPath(journalRoot, deletionId), { force: true });
        await fsyncDirectory(journalRoot);
      } catch (error) {
        throw normalizeJournalError(error, `Could not delete Space deletion journal ${deletionId}`);
      }
    },
  };
}

function validateJournalRecord(
  value: unknown,
  message: string,
): SpaceReferenceDeletionJournalRecord {
  const result = journalRecordSchema.safeParse(value);
  if (!result.success) {
    throw incompatibleJournal(`${message}: ${z.prettifyError(result.error)}`);
  }
  return toPersistedJsonShape(result.data);
}

async function readJournalRecord(filePath: string): Promise<SpaceReferenceDeletionJournalRecord> {
  const content = await fs.readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw incompatibleJournal(`Space deletion journal JSON is invalid: ${filePath}`, error);
  }
  return validateJournalRecord(parsed, `Space deletion journal is incompatible: ${filePath}`);
}

function assertSafeDeletionId(deletionId: string, message: string): void {
  if (!safeDeletionIdSchema.safeParse(deletionId).success) throw incompatibleJournal(message);
}

function journalPath(rootDir: string, deletionId: string): string {
  return path.join(rootDir, `${deletionId}${JOURNAL_FILE_EXTENSION}`);
}

async function ensureDirectories(journalRoot: string, tempRoot: string): Promise<void> {
  await fs.mkdir(journalRoot, { recursive: true });
  await assertRealDirectory(journalRoot, "Space deletion journal root");
  await fs.mkdir(tempRoot, { recursive: true });
  await assertRealDirectory(tempRoot, "Space deletion journal temp root");
}

async function assertRealDirectory(directoryPath: string, label: string): Promise<void> {
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw incompatibleJournal(`${label} must be a real directory: ${directoryPath}`);
  }
}

async function removeOrphanedTempFiles(tempRoot: string): Promise<void> {
  const entries = await fs.readdir(tempRoot, { withFileTypes: true });
  let removed = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await fs.rm(path.join(tempRoot, entry.name), { force: true });
    removed = true;
  }
  if (removed) await fsyncDirectory(tempRoot);
}

async function writeSyncedTempFile(filePath: string, content: string): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  let writeFailure: unknown;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    writeFailure = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (writeFailure === undefined) throw error;
    }
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let primaryFailure: unknown;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedWindowsDirectoryFsync(error)) {
      primaryFailure = error;
      throw error;
    }
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      if (primaryFailure === undefined) throw error;
    }
  }
}

function isUnsupportedWindowsDirectoryFsync(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  for (const code of WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES) {
    if (isNodeError(error, code)) return true;
  }
  return false;
}

function incompatibleJournal(message: string, cause?: unknown): SpaceFeatureError {
  return new SpaceFeatureError("space_deletion_journal_failure", message, cause === undefined ? undefined : { cause });
}

function normalizeJournalError(error: unknown, message: string): SpaceFeatureError {
  if (error instanceof SpaceFeatureError) return error;
  return new SpaceFeatureError("space_deletion_journal_failure", message, { cause: error });
}

function compareDeletionIds(
  left: SpaceReferenceDeletionJournalRecord,
  right: SpaceReferenceDeletionJournalRecord,
): number {
  return left.deletionId < right.deletionId ? -1 : left.deletionId > right.deletionId ? 1 : 0;
}
