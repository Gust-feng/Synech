import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { isNodeError } from "../../kernel/values/index.js";

export const ORDINARY_MANAGED_ATTACHMENT_SCHEMA_VERSION = "ordinary-managed-attachment/v1" as const;

const ATTACHMENT_DIRECTORY_PREFIX = "attachment-";
const PENDING_DIRECTORY_PREFIX = ".pending-";
const DELETING_DIRECTORY_PREFIX = ".deleting-";
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

export type OrdinaryManagedAttachmentDurableClaim = {
  readonly conversationId: string;
  readonly attachmentIds: readonly string[];
};

export type RecoverOrdinaryManagedAttachmentsAtStartupInput = {
  readonly activeInstanceId: string;
  readonly durableClaims: readonly OrdinaryManagedAttachmentDurableClaim[];
  readonly preserveConversationIds: readonly string[];
};

export type DiscardOrdinaryManagedAttachmentDraftInput = {
  readonly attachmentId: string;
  readonly instanceId: string;
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

export type OrdinaryManagedAttachmentRecoveryIssue = {
  readonly identity: string;
  readonly error: OrdinaryManagedAttachmentRepositoryError;
};

export type OrdinaryManagedAttachmentRecoveryResult = {
  readonly issues: readonly OrdinaryManagedAttachmentRecoveryIssue[];
};

export interface OrdinaryManagedAttachmentRepository {
  createDraft(input: CreateOrdinaryManagedAttachmentDraftInput): Promise<CreateOrdinaryManagedAttachmentDraftResult>;
  get(attachmentId: string): Promise<OrdinaryManagedAttachmentRecord>;
  resolveContentPath(attachmentId: string): Promise<string>;
  claimForConversation(input: ClaimOrdinaryManagedAttachmentsInput): Promise<ClaimOrdinaryManagedAttachmentsResult>;
  releaseConversationClaim(input: ReleaseOrdinaryManagedAttachmentConversationClaimInput): Promise<void>;
  discardDraft(input: DiscardOrdinaryManagedAttachmentDraftInput): Promise<void>;
  deleteConversation(conversationId: string): Promise<void>;
  removeDraftsOwnedBy(instanceId: string): Promise<void>;
  recoverAtStartup(
    input: RecoverOrdinaryManagedAttachmentsAtStartupInput,
  ): Promise<OrdinaryManagedAttachmentRecoveryResult>;
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
      const normalized = normalizeCreateInput(input);
      await this.ensureRoot();

      const existing = await this.readRecordIfPresent(normalized.attachmentId);
      if (existing !== undefined) {
        if (isSameDraftUpload(existing, normalized)) {
          return { record: cloneRecord(existing), created: false };
        }
        throw ownershipConflict(
          normalized.attachmentId,
          "existing attachment does not match the same draft upload",
        );
      }

      const directoryName = attachmentDirectoryName(normalized.attachmentId);
      const finalDirectory = path.join(this.rootPath, directoryName);
      const pendingDirectory = path.join(this.rootPath, `${PENDING_DIRECTORY_PREFIX}${randomUUID()}`);
      const record: OrdinaryManagedAttachmentRecord = {
        schemaVersion: ORDINARY_MANAGED_ATTACHMENT_SCHEMA_VERSION,
        attachmentId: normalized.attachmentId,
        owner: { kind: "draft", instanceId: normalized.instanceId },
        originalName: normalized.originalName,
        ...(normalized.mimeType === undefined ? {} : { mimeType: normalized.mimeType }),
        byteLength: normalized.content.byteLength,
        sha256: normalized.sha256,
        createdAt: normalized.createdAt,
        updatedAt: normalized.createdAt,
      };

      await fs.mkdir(pendingDirectory, { mode: DEFAULT_DIRECTORY_MODE });
      try {
        await fs.writeFile(path.join(pendingDirectory, CONTENT_FILE_NAME), normalized.content, {
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
      const normalized = normalizeClaimInput(input);
      await this.ensureRoot();
      const records = await Promise.all(normalized.attachmentIds.map(async (attachmentId) => {
        const record = await this.readRecordIfPresent(attachmentId);
        if (record === undefined) {
          throw notFound(attachmentId);
        }
        assertClaimable(record, normalized.instanceId, normalized.conversationId);
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
            owner: { kind: "conversation", conversationId: normalized.conversationId },
            updatedAt: normalized.claimedAt,
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
                instanceId: normalized.instanceId,
                conversationId: normalized.conversationId,
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
      const normalized = normalizeReleaseClaimInput(input);
      await this.ensureRoot();
      const records = await Promise.all(normalized.attachmentIds.map(async (attachmentId) => {
        const record = await this.readRecordIfPresent(attachmentId);
        if (record === undefined) throw notFound(attachmentId);
        assertReleasable(record, normalized.instanceId, normalized.conversationId);
        return record;
      }));

      // Validate the complete requested claim set before changing any owner.
      for (const record of records) {
        if (record.owner.kind === "draft") continue;
        const next: OrdinaryManagedAttachmentRecord = {
          ...record,
          owner: { kind: "draft", instanceId: normalized.instanceId },
          updatedAt: normalized.releasedAt,
        };
        await writeRecordAtomically(directoryPath(this.rootPath, record.attachmentId), next);
      }
    });
  }

  discardDraft(input: DiscardOrdinaryManagedAttachmentDraftInput): Promise<void> {
    return this.serialized("discard draft", async () => {
      if (!isObject(input)) {
        throw new OrdinaryManagedAttachmentRepositoryError(
          "ordinary_managed_attachment_invalid_input",
          "discardDraft input must be an object.",
        );
      }
      const normalizedId = requireAttachmentId(input.attachmentId);
      const instanceId = requireNonBlankText(input.instanceId, "instanceId");
      await this.ensureRoot();
      const record = await this.readRecordIfPresent(normalizedId);
      if (record === undefined) return;
      if (record.owner.kind !== "draft" || record.owner.instanceId !== instanceId) {
        throw ownershipConflict(normalizedId, "discard requires the draft owner instance");
      }
      await this.stageAndRemove(normalizedId);
    });
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.serialized("delete conversation attachments", async () => {
      const normalizedConversationId = requireNonBlankText(conversationId, "conversationId");
      await this.ensureRoot();
      const records = await this.readAllRecords();
      const owned = records.filter((record) =>
        record.owner.kind === "conversation" && record.owner.conversationId === normalizedConversationId);
      for (const record of owned) await this.stageAndRemove(record.attachmentId);
    });
  }

  removeDraftsOwnedBy(instanceId: string): Promise<void> {
    return this.serialized("remove draft attachments", async () => {
      const normalizedInstanceId = requireNonBlankText(instanceId, "instanceId");
      await this.ensureRoot();
      const records = await this.readAllRecords();
      const owned = records.filter((record) =>
        record.owner.kind === "draft" && record.owner.instanceId === normalizedInstanceId);
      for (const record of owned) await this.stageAndRemove(record.attachmentId);
    });
  }

  recoverAtStartup(
    input: RecoverOrdinaryManagedAttachmentsAtStartupInput,
  ): Promise<OrdinaryManagedAttachmentRecoveryResult> {
    return this.serialized("recover attachments at startup", async () => {
      const normalized = normalizeRecoveryInput(input);
      await this.ensureRoot();
      await removeCrashDebris(this.rootPath);
      const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
      const issues: OrdinaryManagedAttachmentRecoveryIssue[] = [];
      for (const entry of attachmentEntries(entries)) {
        const directory = path.join(this.rootPath, entry.name);
        try {
          const stat = await fs.lstat(directory);
          if (!stat.isDirectory()) throw corruptRecord(entry.name, "attachment entry is not a directory");
          const record = await readRecordFromDirectory(directory, entry.name);
          await removeRecordTempFiles(directory);
          const durableConversationId = normalized.durableClaims.get(record.attachmentId);
          if (durableConversationId !== undefined) {
            if (record.owner.kind !== "conversation" || record.owner.conversationId !== durableConversationId) {
              issues.push({
                identity: entry.name,
                error: ownershipConflict(
                  record.attachmentId,
                  `durable claim belongs to conversation ${durableConversationId}`,
                ),
              });
            }
            continue;
          }
          if (record.owner.kind === "draft") {
            if (record.owner.instanceId !== normalized.activeInstanceId) {
              await this.stageAndRemove(record.attachmentId);
            }
            continue;
          }
          if (!normalized.preserveConversationIds.has(record.owner.conversationId)) {
            await this.stageAndRemove(record.attachmentId);
          }
        } catch (error) {
          issues.push(recoveryIssue(entry.name, error));
        }
      }
      return { issues };
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

  private async stageAndRemove(attachmentId: string): Promise<void> {
    const source = directoryPath(this.rootPath, attachmentId);
    const staged = path.join(this.rootPath, `${DELETING_DIRECTORY_PREFIX}${randomUUID()}`);
    try {
      await renameWithRetry(source, staged);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    await fs.rm(staged, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
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

  let content: string;
  try {
    content = await fs.readFile(recordFile, "utf8");
  } catch (error) {
    throw error;
  }
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

async function removeCrashDebris(rootPath: string): Promise<void> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name.startsWith(PENDING_DIRECTORY_PREFIX) ||
      entry.name.startsWith(DELETING_DIRECTORY_PREFIX) ||
      entry.name.startsWith(PENDING_RECORD_PREFIX)
    ) {
      await fs.rm(path.join(rootPath, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
}

async function removeRecordTempFiles(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(PENDING_RECORD_PREFIX)) {
      await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
    }
  }
}

function normalizeCreateInput(input: CreateOrdinaryManagedAttachmentDraftInput): {
  readonly attachmentId: string;
  readonly instanceId: string;
  readonly originalName: string;
  readonly mimeType?: string;
  readonly content: Uint8Array;
  readonly sha256: string;
  readonly createdAt: string;
} {
  if (!isObject(input)) {
    throw new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_invalid_input",
      "createDraft input must be an object.",
    );
  }
  const attachmentId = requireAttachmentId(input.attachmentId);
  const instanceId = requireNonBlankText(input.instanceId, "instanceId");
  const originalName = requireNonBlankText(input.originalName, "originalName");
  const mimeType = input.mimeType === undefined ? undefined : requireNonBlankText(input.mimeType, "mimeType");
  const createdAt = requireNonBlankText(input.createdAt, "createdAt");
  if (!(input.content instanceof Uint8Array)) {
    throw new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_invalid_input",
      "Managed attachment content must be a Uint8Array.",
    );
  }
  const content = new Uint8Array(input.content);
  return {
    attachmentId,
    instanceId,
    originalName,
    ...(mimeType === undefined ? {} : { mimeType }),
    content,
    sha256: sha256(content),
    createdAt,
  };
}

function normalizeClaimInput(input: ClaimOrdinaryManagedAttachmentsInput): {
  readonly attachmentIds: readonly string[];
  readonly instanceId: string;
  readonly conversationId: string;
  readonly claimedAt: string;
} {
  if (!isObject(input)) {
    throw new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_invalid_input",
      "claimForConversation input must be an object.",
    );
  }
  return {
    attachmentIds: normalizeAttachmentIds(input.attachmentIds, "claimForConversation"),
    instanceId: requireNonBlankText(input.instanceId, "instanceId"),
    conversationId: requireNonBlankText(input.conversationId, "conversationId"),
    claimedAt: requireNonBlankText(input.claimedAt, "claimedAt"),
  };
}

function normalizeReleaseClaimInput(input: ReleaseOrdinaryManagedAttachmentConversationClaimInput): {
  readonly attachmentIds: readonly string[];
  readonly instanceId: string;
  readonly conversationId: string;
  readonly releasedAt: string;
} {
  if (!isObject(input)) {
    throw new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_invalid_input",
      "releaseConversationClaim input must be an object.",
    );
  }
  return {
    attachmentIds: normalizeAttachmentIds(input.attachmentIds, "releaseConversationClaim"),
    instanceId: requireNonBlankText(input.instanceId, "instanceId"),
    conversationId: requireNonBlankText(input.conversationId, "conversationId"),
    releasedAt: requireNonBlankText(input.releasedAt, "releasedAt"),
  };
}

function normalizeRecoveryInput(input: RecoverOrdinaryManagedAttachmentsAtStartupInput): {
  readonly activeInstanceId: string;
  readonly durableClaims: ReadonlyMap<string, string>;
  readonly preserveConversationIds: ReadonlySet<string>;
} {
  if (!isObject(input)) {
    throw new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_invalid_input",
      "recoverAtStartup input must be an object.",
    );
  }
  if (!Array.isArray(input.durableClaims) || !Array.isArray(input.preserveConversationIds)) {
    throw new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_invalid_input",
      "durableClaims and preserveConversationIds must be arrays.",
    );
  }
  const durableClaims = new Map<string, string>();
  for (const [index, claim] of input.durableClaims.entries()) {
    if (!isObject(claim)) {
      throw new OrdinaryManagedAttachmentRepositoryError(
        "ordinary_managed_attachment_invalid_input",
        `durableClaims[${index}] must be an object.`,
      );
    }
    const conversationId = requireNonBlankText(claim.conversationId, `durableClaims[${index}].conversationId`);
    const attachmentIds = normalizeAttachmentIds(
      claim.attachmentIds,
      `recoverAtStartup durableClaims[${index}]`,
    );
    for (const attachmentId of attachmentIds) {
      if (durableClaims.has(attachmentId)) {
        throw new OrdinaryManagedAttachmentRepositoryError(
          "ordinary_managed_attachment_invalid_input",
          `recoverAtStartup durableClaims contain duplicate attachment ID ${attachmentId}.`,
        );
      }
      durableClaims.set(attachmentId, conversationId);
    }
  }
  const preserveConversationIds = input.preserveConversationIds.map((conversationId, index) =>
    requireNonBlankText(conversationId, `preserveConversationIds[${index}]`));
  if (new Set(preserveConversationIds).size !== preserveConversationIds.length) {
    throw new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_invalid_input",
      "recoverAtStartup does not accept duplicate preserveConversationIds.",
    );
  }
  return {
    activeInstanceId: requireNonBlankText(input.activeInstanceId, "activeInstanceId"),
    durableClaims,
    preserveConversationIds: new Set(preserveConversationIds),
  };
}

function normalizeAttachmentIds(value: unknown, operation: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_invalid_input",
      `${operation} attachmentIds must be an array.`,
    );
  }
  const attachmentIds = value.map(requireAttachmentId);
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_invalid_input",
      `${operation} does not accept duplicate attachment IDs.`,
    );
  }
  return attachmentIds;
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

function isSameDraftUpload(
  record: OrdinaryManagedAttachmentRecord,
  input: ReturnType<typeof normalizeCreateInput>,
): boolean {
  return record.owner.kind === "draft" &&
    record.owner.instanceId === input.instanceId &&
    record.originalName === input.originalName &&
    record.mimeType === input.mimeType &&
    record.byteLength === input.content.byteLength &&
    record.sha256 === input.sha256;
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
  if (hasUnpairedSurrogate(value)) return "it must contain valid Unicode scalar values";
  if (Buffer.byteLength(value, "utf8") > MAX_ATTACHMENT_ID_BYTES) {
    return `its UTF-8 representation must be at most ${MAX_ATTACHMENT_ID_BYTES} bytes`;
  }
  return undefined;
}

function requireNonBlankText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_invalid_input",
      `${field} must be a non-blank string.`,
    );
  }
  return value;
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

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
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

function recoveryIssue(identity: string, error: unknown): OrdinaryManagedAttachmentRecoveryIssue {
  if (error instanceof OrdinaryManagedAttachmentRepositoryError) return { identity, error };
  return {
    identity,
    error: new OrdinaryManagedAttachmentRepositoryError(
      "ordinary_managed_attachment_storage_failure",
      `Managed attachment recovery failed for ${identity}.`,
      { cause: error },
    ),
  };
}

function corruptRecord(identity: string, reason: string, cause?: unknown): OrdinaryManagedAttachmentRepositoryError {
  return new OrdinaryManagedAttachmentRepositoryError(
    "ordinary_managed_attachment_corrupt_record",
    `Managed attachment record ${identity} is corrupt: ${reason}.`,
    cause === undefined ? undefined : { cause },
  );
}