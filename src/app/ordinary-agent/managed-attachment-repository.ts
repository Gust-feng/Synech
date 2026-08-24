import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { isNodeError } from "../../kernel/values/index.js";

export const ORDINARY_MANAGED_ATTACHMENT_SCHEMA_VERSION = "ordinary-managed-attachment/v1" as const;

const ATTACHMENT_DIRECTORY_PREFIX = "attachment-";
const PENDING_DIRECTORY_PREFIX = ".pending-";
const PENDING_RECORD_PREFIX = ".pending-record-";
const RECORD_FILE_NAME = "record.json";
const CONTENT_FILE_NAME = "content";
const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_DIRECTORY_MODE = 0o700;
const MAX_ATTACHMENT_ID_BYTES = 180;

export type OrdinaryManagedAttachmentOwner =
  | { readonly kind: "draft"; readonly instanceId: string }
  | { readonly kind: "conversation"; readonly conversationId: string };

export type OrdinaryManagedAttachmentRecord = {
  readonly schemaVersion: typeof ORDINARY_MANAGED_ATTACHMENT_SCHEMA_VERSION;
  readonly attachmentId: string;
  readonly owner: OrdinaryManagedAttachmentOwner;
  readonly originalName: string;
  readonly mimeType?: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CreateOrdinaryManagedAttachmentDraftInput = {
  readonly attachmentId: string;
  readonly instanceId: string;
  readonly originalName: string;
  readonly mimeType?: string;
  readonly content: Uint8Array;
  readonly createdAt: string;
};

export type ClaimOrdinaryManagedAttachmentsInput = {
  readonly attachmentIds: readonly string[];
  readonly instanceId: string;
  readonly conversationId: string;
  readonly claimedAt: string;
};

export type CreateOrdinaryManagedAttachmentDraftResult = {
  readonly record: OrdinaryManagedAttachmentRecord;
  readonly created: boolean;
};

export type ClaimOrdinaryManagedAttachmentsResult = {
  readonly records: readonly OrdinaryManagedAttachmentRecord[];
  readonly newlyClaimedAttachmentIds: readonly string[];
};

export type ReleaseOrdinaryManagedAttachmentConversationClaimInput = {
  readonly attachmentIds: readonly string[];
  readonly instanceId: string;
  readonly conversationId: string;
  readonly releasedAt: string;
};

export type OrdinaryManagedAttachmentRepositoryErrorCode =
  | "ordinary_managed_attachment_invalid_id"
  | "ordinary_managed_attachment_invalid_input"
  | "ordinary_managed_attachment_not_found"
  | "ordinary_managed_attachment_ownership_conflict"
  | "ordinary_managed_attachment_storage_failure"
  | "ordinary_managed_attachment_corrupt_record";

export type OrdinaryManagedAttachmentPartialClaim = {
  readonly instanceId: string;
  readonly conversationId: string;
  readonly attachmentIds: readonly string[];
};

export class OrdinaryManagedAttachmentRepositoryError extends Error {
  readonly name = "OrdinaryManagedAttachmentRepositoryError";
  readonly partialClaim?: OrdinaryManagedAttachmentPartialClaim;

  constructor(
    readonly code: OrdinaryManagedAttachmentRepositoryErrorCode,
    message: string,
    options?: ErrorOptions & { readonly partialClaim?: OrdinaryManagedAttachmentPartialClaim },
  ) {
    super(message, options);
    this.partialClaim = options?.partialClaim;
  }
}

export interface OrdinaryManagedAttachmentRepository {
  createDraft(input: CreateOrdinaryManagedAttachmentDraftInput): Promise<CreateOrdinaryManagedAttachmentDraftResult>;
  get(attachmentId: string): Promise<OrdinaryManagedAttachmentRecord>;
  list(): Promise<readonly OrdinaryManagedAttachmentRecord[]>;
  resolveContentPath(attachmentId: string): Promise<string>;
  claimForConversation(input: ClaimOrdinaryManagedAttachmentsInput): Promise<ClaimOrdinaryManagedAttachmentsResult>;
  releaseConversationClaim(input: ReleaseOrdinaryManagedAttachmentConversationClaimInput): Promise<void>;
  delete(attachmentId: string, expectedOwner?: OrdinaryManagedAttachmentOwner): Promise<void>;
}

export function createFileSystemOrdinaryManagedAttachmentRepository(
  rootPath: string,
): OrdinaryManagedAttachmentRepository {
  return new FileSystemOrdinaryManagedAttachmentRepository(rootPath);
}

class FileSystemOrdinaryManagedAttachmentRepository implements OrdinaryManagedAttachmentRepository {
  private readonly rootPath: string;
  private writeQueue = Promise.resolve();

  constructor(rootPath: string) {
    if (typeof rootPath !== "string" || rootPath.length === 0 || rootPath.includes("\0")) {
      throw new OrdinaryManagedAttachmentRepositoryError(
        "ordinary_managed_attachment_invalid_input",
        "Managed attachment repository root path must be a non-empty path without NUL bytes.",
      );
    }
    this.rootPath = path.resolve(rootPath);
  }

  createDraft(input: CreateOrdinaryManagedAttachmentDraftInput): Promise<CreateOrdinaryManagedAttachmentDraftResult> {
    return this.serialized("create draft", async () => {
      const attachmentId = requireAttachmentId(input.attachmentId);
      const content = new Uint8Array(input.content);
      const digest = sha256(content);
      await this.ensureRoot();

      const existing = await this.readRecordIfPresent(attachmentId);
      if (existing !== undefined) {
        if (isSameDraftUpload(existing, input.instanceId, input.originalName, input.mimeType, content, digest)) {
          return { record: cloneRecord(existing), created: false };
        }
        throw ownershipConflict(
          attachmentId,
          "existing attachment does not match the same draft upload",
        );
      }

      const directoryName = attachmentDirectoryName(attachmentId);
      const finalDirectory = path.join(this.rootPath, directoryName);
      const pendingDirectory = path.join(this.rootPath, `${PENDING_DIRECTORY_PREFIX}${randomUUID()}`);
      const record: OrdinaryManagedAttachmentRecord = {
        schemaVersion: ORDINARY_MANAGED_ATTACHMENT_SCHEMA_VERSION,
        attachmentId,
        owner: { kind: "draft", instanceId: input.instanceId },
        originalName: input.originalName,
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
        byteLength: content.byteLength,
        sha256: digest,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };

      await fs.mkdir(pendingDirectory, { mode: DEFAULT_DIRECTORY_MODE });
      try {
        await fs.writeFile(path.join(pendingDirectory, CONTENT_FILE_NAME), content, {
          flag: "wx",
          mode: DEFAULT_FILE_MODE,
        });
        await writeRecordAtomically(pendingDirectory, record);
        await renameWithRetry(pendingDirectory, finalDirectory);
      } catch (error) {
        await fs.rm(pendingDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return { record: cloneRecord(record), created: true };
    });
  }

  get(attachmentId: string): Promise<OrdinaryManagedAttachmentRecord> {
    return this.serialized("get attachment", async () => {
      const normalizedId = requireAttachmentId(attachmentId);
      await this.ensureRoot();
      const record = await this.readRecordIfPresent(normalizedId);
      if (record === undefined) {
        throw notFound(normalizedId);
      }
      return cloneRecord(record);
    });
  }

  list(): Promise<readonly OrdinaryManagedAttachmentRecord[]> {
    return this.serialized("list attachments", async () => {
      await this.ensureRoot();
      return (await this.readAllRecords()).map(cloneRecord);
    });
  }

  resolveContentPath(attachmentId: string): Promise<string> {
    return this.serialized("resolve attachment content", async () => {
      const normalizedId = requireAttachmentId(attachmentId);
      await this.ensureRoot();
      const record = await this.readRecordIfPresent(normalizedId);
      if (record === undefined) {
        throw notFound(normalizedId);
      }
      return contentPath(this.rootPath, record.attachmentId);
    });
  }

  claimForConversation(
    input: ClaimOrdinaryManagedAttachmentsInput,
  ): Promise<ClaimOrdinaryManagedAttachmentsResult> {
    return this.serialized("claim attachments for conversation", async () => {
      const attachmentIds = input.attachmentIds.map(requireAttachmentId);
      await this.ensureRoot();
      const records = await Promise.all(attachmentIds.map(async (attachmentId) => {
        const record = await this.readRecordIfPresent(attachmentId);
        if (record === undefined) {
          throw notFound(attachmentId);
        }
        assertClaimable(record, input.instanceId, input.conversationId);
        return record;
      }));

      // Every record is read and ownership-checked above before the first rewrite.
      const claimed: OrdinaryManagedAttachmentRecord[] = [];
      const newlyClaimedAttachmentIds: string[] = [];
      try {
        for (const record of records) {
          if (record.owner.kind === "conversation") {
            claimed.push(record);
            continue;
          }
          const next: OrdinaryManagedAttachmentRecord = {
            ...record,
            owner: { kind: "conversation", conversationId: input.conversationId },
            updatedAt: input.claimedAt,
          };
          await writeRecordAtomically(directoryPath(this.rootPath, record.attachmentId), next);
          claimed.push(next);
          newlyClaimedAttachmentIds.push(record.attachmentId);
        }
      } catch (error) {
        throw new OrdinaryManagedAttachmentRepositoryError(
          "ordinary_managed_attachment_storage_failure",
          `Managed attachment claim failed after ${newlyClaimedAttachmentIds.length} owner update(s).`,
          {
            cause: error,
            ...(newlyClaimedAttachmentIds.length === 0 ? {} : {
              partialClaim: {
                instanceId: input.instanceId,
                conversationId: input.conversationId,
                attachmentIds: [...newlyClaimedAttachmentIds],
              },
            }),
          },
        );
      }
      return {
        records: claimed.map(cloneRecord),
        newlyClaimedAttachmentIds,
      };
    });
  }

  releaseConversationClaim(input: ReleaseOrdinaryManagedAttachmentConversationClaimInput): Promise<void> {
    return this.serialized("release conversation attachment claim", async () => {
      const attachmentIds = input.attachmentIds.map(requireAttachmentId);
      await this.ensureRoot();
      const records = await Promise.all(attachmentIds.map(async (attachmentId) => {
        const record = await this.readRecordIfPresent(attachmentId);
        if (record === undefined) throw notFound(attachmentId);
        assertReleasable(record, input.instanceId, input.conversationId);
        return record;
      }));

      // Validate the complete requested claim set before changing any owner.
      for (const record of records) {
        if (record.owner.kind === "draft") continue;
        const next: OrdinaryManagedAttachmentRecord = {
          ...record,
          owner: { kind: "draft", instanceId: input.instanceId },
          updatedAt: input.releasedAt,
        };
        await writeRecordAtomically(directoryPath(this.rootPath, record.attachmentId), next);
      }
    });
  }

  delete(attachmentId: string, expectedOwner?: OrdinaryManagedAttachmentOwner): Promise<void> {
    return this.serialized("delete attachment", async () => {
      const normalizedId = requireAttachmentId(attachmentId);
      await this.ensureRoot();
      if (expectedOwner !== undefined) {
        const record = await this.readRecordIfPresent(normalizedId);
        if (record === undefined) return;
        if (!sameOwner(record.owner, expectedOwner)) {
          throw ownershipConflict(normalizedId, "attachment owner changed before deletion");
        }
      }
      await fs.rm(directoryPath(this.rootPath, normalizedId), { recursive: true, force: true });
    });
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootPath, { recursive: true, mode: DEFAULT_DIRECTORY_MODE });
    const stat = await fs.stat(this.rootPath);
    if (!stat.isDirectory()) throw new Error(`Managed attachment root is not a directory: ${this.rootPath}`);
  }

  private async readRecordIfPresent(attachmentId: string): Promise<OrdinaryManagedAttachmentRecord | undefined> {
    const directory = directoryPath(this.rootPath, attachmentId);
    const stat = await fs.lstat(directory).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    if (stat === undefined) return undefined;
    if (!stat.isDirectory()) throw corruptRecord(attachmentId, "attachment directory is not a directory");
    return await readRecordFromDirectory(directory, attachmentId);
  }

  private async readAllRecords(): Promise<readonly OrdinaryManagedAttachmentRecord[]> {
    const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    const records: OrdinaryManagedAttachmentRecord[] = [];
    for (const entry of attachmentEntries(entries)) {
      const directory = path.join(this.rootPath, entry.name);
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory()) throw corruptRecord(entry.name, "attachment entry is not a directory");
      const record = await readRecordFromDirectory(directory, entry.name);
      if (attachmentDirectoryName(record.attachmentId) !== entry.name) {
        throw corruptRecord(record.attachmentId, "attachment directory identity does not match record identity");
      }
      records.push(record);
    }
    return records;
  }

  private serialized<T>(operation: string, action: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      try {
        return await action();
      } catch (error) {
        if (error instanceof OrdinaryManagedAttachmentRepositoryError) throw error;
        throw new OrdinaryManagedAttachmentRepositoryError(
          "ordinary_managed_attachment_storage_failure",
          `Managed attachment ${operation} failed under ${this.rootPath}.`,
          { cause: error },
        );
      }
    };
    const result = this.writeQueue.then(execute, execute);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function readRecordFromDirectory(
  directory: string,
  identity: string,
): Promise<OrdinaryManagedAttachmentRecord> {
  const recordFile = path.join(directory, RECORD_FILE_NAME);
  const contentFile = path.join(directory, CONTENT_FILE_NAME);
  const recordStat = await fs.lstat(recordFile).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) throw corruptRecord(identity, "record.json is missing");
    throw error;
  });
  if (!recordStat.isFile()) throw corruptRecord(identity, "record.json is not a regular file");

  const content = await fs.readFile(recordFile, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch (error) {
    throw corruptRecord(identity, "record.json is not valid JSON", error);
  }
  const record = parseStoredRecord(raw, identity);
  if (attachmentDirectoryName(record.attachmentId) !== path.basename(directory)) {
    throw corruptRecord(identity, "attachment directory identity does not match record identity");
  }

  const contentStat = await fs.lstat(contentFile).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) throw corruptRecord(record.attachmentId, "content file is missing");
    throw error;
  });
  if (!contentStat.isFile() || contentStat.size !== record.byteLength) {
    throw corruptRecord(record.attachmentId, "content file is not a regular file with the recorded byte length");
  }
  return record;
}

async function writeRecordAtomically(
  directory: string,
  record: OrdinaryManagedAttachmentRecord,
): Promise<void> {
  const target = path.join(directory, RECORD_FILE_NAME);
  const temporary = path.join(directory, `${PENDING_RECORD_PREFIX}${randomUUID()}`);
  const previousMode = await fs.lstat(target).then((stat) => stat.mode & 0o777).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return DEFAULT_FILE_MODE;
    throw error;
  });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: previousMode,
    });
    await fs.chmod(temporary, previousMode);
    await renameWithRetry(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseStoredRecord(value: unknown, identity: string): OrdinaryManagedAttachmentRecord {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "schemaVersion", "attachmentId", "owner", "originalName", "mimeType", "byteLength", "sha256", "createdAt", "updatedAt",
  ])) {
    throw corruptRecord(identity, "record.json has an invalid object shape");
  }
  if (value.schemaVersion !== ORDINARY_MANAGED_ATTACHMENT_SCHEMA_VERSION) {
    throw corruptRecord(identity, "record.json has an unsupported schema version");
  }
  const attachmentId = storedAttachmentId(value.attachmentId, identity);
  const owner = parseStoredOwner(value.owner, identity);
  const originalName = storedText(value.originalName, identity, "originalName");
  const mimeType = value.mimeType === undefined ? undefined : storedText(value.mimeType, identity, "mimeType");
  if (typeof value.byteLength !== "number" || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
    throw corruptRecord(identity, "record.json has an invalid byteLength");
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw corruptRecord(identity, "record.json has an invalid sha256");
  }
  const createdAt = storedText(value.createdAt, identity, "createdAt");
  const updatedAt = storedText(value.updatedAt, identity, "updatedAt");
  return {
    schemaVersion: ORDINARY_MANAGED_ATTACHMENT_SCHEMA_VERSION,
    attachmentId,
    owner,
    originalName,
    ...(mimeType === undefined ? {} : { mimeType }),
    byteLength: value.byteLength,
    sha256: value.sha256,
    createdAt,
    updatedAt,
  };
}

function parseStoredOwner(value: unknown, identity: string): OrdinaryManagedAttachmentOwner {
  if (!isObject(value)) throw corruptRecord(identity, "record.json has an invalid owner");
  if (value.kind === "draft" && hasOnlyKeys(value, ["kind", "instanceId"])) {
    return { kind: "draft", instanceId: storedText(value.instanceId, identity, "owner.instanceId") };
  }
  if (value.kind === "conversation" && hasOnlyKeys(value, ["kind", "conversationId"])) {
    return { kind: "conversation", conversationId: storedText(value.conversationId, identity, "owner.conversationId") };
  }
  throw corruptRecord(identity, "record.json has an invalid owner discriminator");
}

function storedAttachmentId(value: unknown, identity: string): string {
  if (typeof value !== "string" || attachmentIdProblem(value) !== undefined) {
    throw corruptRecord(identity, "record.json has an invalid attachmentId");
  }
  return value;
}

function storedText(value: unknown, identity: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw corruptRecord(identity, `record.json has an invalid ${field}`);
  }
  return value;
}

function assertClaimable(
  record: OrdinaryManagedAttachmentRecord,
  instanceId: string,
  conversationId: string,
): void {
  if (record.owner.kind === "conversation" && record.owner.conversationId === conversationId) return;
  if (record.owner.kind === "draft" && record.owner.instanceId === instanceId) return;
  throw ownershipConflict(record.attachmentId, "attachment is owned by another draft instance or conversation");
}

function assertReleasable(
  record: OrdinaryManagedAttachmentRecord,
  instanceId: string,
  conversationId: string,
): void {
  if (record.owner.kind === "conversation" && record.owner.conversationId === conversationId) return;
  if (record.owner.kind === "draft" && record.owner.instanceId === instanceId) return;
  throw ownershipConflict(record.attachmentId, "release requires the claimed conversation or released draft owner");
}

function sameOwner(left: OrdinaryManagedAttachmentOwner, right: OrdinaryManagedAttachmentOwner): boolean {
  if (left.kind === "draft") return right.kind === "draft" && left.instanceId === right.instanceId;
  return right.kind === "conversation" && left.conversationId === right.conversationId;
}

function isSameDraftUpload(
  record: OrdinaryManagedAttachmentRecord,
  instanceId: string,
  originalName: string,
  mimeType: string | undefined,
  content: Uint8Array,
  contentSha256: string,
): boolean {
  return record.owner.kind === "draft" &&
    record.owner.instanceId === instanceId &&
    record.originalName === originalName &&
    record.mimeType === mimeType &&
    record.byteLength === content.byteLength &&
    record.sha256 === contentSha256;
}

function requireAttachmentId(value: unknown): string {
  const problem = attachmentIdProblem(value);
  if (problem === undefined) return value as string;
  throw new OrdinaryManagedAttachmentRepositoryError(
    "ordinary_managed_attachment_invalid_id",
    `Invalid managed attachment ID: ${problem}.`,
  );
}

function attachmentIdProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return "it must be a non-empty string";
  if (value.trim().length === 0) return "it must contain a non-whitespace character";
  if (Buffer.byteLength(value, "utf8") > MAX_ATTACHMENT_ID_BYTES) {
    return `its UTF-8 representation must be at most ${MAX_ATTACHMENT_ID_BYTES} bytes`;
  }
  return undefined;
}

function attachmentEntries<T extends { readonly name: string }>(entries: readonly T[]): readonly T[] {
  return entries
    .filter((entry) => entry.name.startsWith(ATTACHMENT_DIRECTORY_PREFIX))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function attachmentDirectoryName(attachmentId: string): string {
  return `${ATTACHMENT_DIRECTORY_PREFIX}${Buffer.from(attachmentId, "utf8").toString("base64url")}`;
}

function directoryPath(rootPath: string, attachmentId: string): string {
  return path.join(rootPath, attachmentDirectoryName(attachmentId));
}

function contentPath(rootPath: string, attachmentId: string): string {
  return path.join(directoryPath(rootPath, attachmentId), CONTENT_FILE_NAME);
}

function cloneRecord(record: OrdinaryManagedAttachmentRecord): OrdinaryManagedAttachmentRecord {
  return { ...record, owner: { ...record.owner } };
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFound(attachmentId: string): OrdinaryManagedAttachmentRepositoryError {
  return new OrdinaryManagedAttachmentRepositoryError(
    "ordinary_managed_attachment_not_found",
    `Managed attachment ${attachmentId} was not found.`,
  );
}

function ownershipConflict(attachmentId: string, reason: string): OrdinaryManagedAttachmentRepositoryError {
  return new OrdinaryManagedAttachmentRepositoryError(
    "ordinary_managed_attachment_ownership_conflict",
    `Managed attachment ${attachmentId} ownership conflict: ${reason}.`,
  );
}

function corruptRecord(identity: string, reason: string, cause?: unknown): OrdinaryManagedAttachmentRepositoryError {
  return new OrdinaryManagedAttachmentRepositoryError(
    "ordinary_managed_attachment_corrupt_record",
    `Managed attachment record ${identity} is corrupt: ${reason}.`,
    cause === undefined ? undefined : { cause },
  );
}
