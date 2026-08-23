import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type BigIntStats, type Dirent } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import {
  TOOL_OUTPUT_REF_PREFIX,
  ToolOutputStoreError,
  type RetainToolOutputInput,
  type ToolOutputReadWindow,
  type ToolOutputRetention,
  type ToolOutputSlice,
  type ToolOutputStore,
} from "../../app/tool-center/tool-output-store.js";
import { MAX_TOOL_OUTPUT_SOURCE_METADATA_JSON_CHARS } from "../../app/tool-center/tool-output-limits.js";
import {
  isUtf16CodeUnitBoundary,
  utf16SafeWindowEnd,
} from "../../app/tool-center/text-window.js";

const TOOL_EVIDENCE_SCHEMA_VERSION = "tool-evidence/v1" as const;
const METADATA_FILE = "metadata.json";
const CONTENT_FILE = "content.txt";

export const DEFAULT_DURABLE_TOOL_OUTPUT_MAX_ITEM_BYTES = 256 * 1024 * 1024;
export const DEFAULT_DURABLE_TOOL_OUTPUT_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
export const DEFAULT_DURABLE_TOOL_OUTPUT_MAX_ENTRIES = 10_000;
export const DEFAULT_DURABLE_TOOL_OUTPUT_READ_CACHE_BYTES = 64 * 1024 * 1024;

const CONTENT_READ_BUFFER_BYTES = 64 * 1024;

const metadataSchema = z.object({
  schemaVersion: z.literal(TOOL_EVIDENCE_SCHEMA_VERSION),
  ref: z.string().min(1),
  availability: z.literal("durable"),
  mediaType: z.enum(["text/plain", "application/json"]),
  sourceToolName: z.string().min(1),
  sourceCallId: z.string().min(1),
  sourceFactId: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),
  totalChars: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.string().min(1),
}).strict();

type ToolEvidenceMetadata = z.infer<typeof metadataSchema>;

export type FileSystemToolOutputStoreOptions = {
  readonly now?: () => number;
  readonly createRefToken?: () => string;
  readonly maxItemBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxEntries?: number;
  readonly maxReadCacheBytes?: number;
};

type FileIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly fileSize: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
};

type ContentCheckpoint = {
  readonly charOffset: number;
  readonly byteOffset: number;
};

type VerifiedFileEntry = {
  readonly identity: FileIdentity;
  readonly checkpoints: readonly ContentCheckpoint[];
};

type CachedContentEntry = {
  readonly content: string;
  readonly byteLength: number;
};

/**
 * Durable backing for oversized tool facts. Each opaque ref is committed as one
 * directory so a restart can observe either the complete evidence or no entry.
 */
export class FileSystemToolOutputStore implements ToolOutputStore {
  private readonly root: string;
  private readonly entriesRoot: string;
  private readonly now: () => number;
  private readonly createRefToken: () => string;
  private readonly maxItemBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxEntries: number;
  private readonly maxReadCacheBytes: number;
  private readonly verifiedFiles = new Map<string, VerifiedFileEntry>();
  private readonly cachedContent = new Map<string, CachedContentEntry>();
  private readonly pendingVerifications = new Map<string, Promise<VerifiedFileEntry>>();
  private readCacheBytes = 0;
  private usage: { entries: number; totalBytes: number } | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(root: string, options: FileSystemToolOutputStoreOptions = {}) {
    if (typeof root !== "string" || root.trim().length === 0) {
      throw new ToolOutputStoreError(
        "invalid_tool_output_store_configuration",
        "Tool evidence root must be a non-empty path.",
      );
    }
    this.root = path.resolve(root);
    if (path.dirname(this.root) === this.root) {
      throw new ToolOutputStoreError(
        "invalid_tool_output_store_configuration",
        "Tool evidence root cannot be a filesystem root.",
      );
    }
    this.entriesRoot = path.join(this.root, "entries");
    this.now = options.now ?? Date.now;
    this.createRefToken = options.createRefToken ?? randomUUID;
    this.maxItemBytes = positiveSafeIntegerOption(
      "maxItemBytes",
      options.maxItemBytes,
      DEFAULT_DURABLE_TOOL_OUTPUT_MAX_ITEM_BYTES,
    );
    this.maxTotalBytes = positiveSafeIntegerOption(
      "maxTotalBytes",
      options.maxTotalBytes,
      DEFAULT_DURABLE_TOOL_OUTPUT_MAX_TOTAL_BYTES,
    );
    this.maxEntries = positiveSafeIntegerOption(
      "maxEntries",
      options.maxEntries,
      DEFAULT_DURABLE_TOOL_OUTPUT_MAX_ENTRIES,
    );
    this.maxReadCacheBytes = positiveSafeIntegerOption(
      "maxReadCacheBytes",
      options.maxReadCacheBytes,
      DEFAULT_DURABLE_TOOL_OUTPUT_READ_CACHE_BYTES,
    );
  }

  retain(input: RetainToolOutputInput): Promise<ToolOutputRetention> {
    return this.mutate(async () => {
      const normalized = normalizeRetainInput(input);
      const incomingBytes = Buffer.byteLength(normalized.content, "utf8");
      if (incomingBytes > this.maxItemBytes) {
        throw new ToolOutputStoreError(
          "tool_output_item_too_large",
          `Tool output has ${incomingBytes} UTF-8 bytes; the durable per-item limit is ${this.maxItemBytes}.`,
          { incomingBytes, maxItemBytes: this.maxItemBytes },
        );
      }
      await fs.mkdir(this.entriesRoot, { recursive: true });
      const usage = await this.currentUsage();
      if (usage.entries >= this.maxEntries) {
        throw new ToolOutputStoreError(
          "tool_output_capacity_exceeded",
          `Durable tool evidence already contains the maximum ${this.maxEntries} entries.`,
          { retainedEntries: usage.entries, maxEntries: this.maxEntries },
        );
      }
      if (usage.totalBytes + incomingBytes > this.maxTotalBytes) {
        throw new ToolOutputStoreError(
          "tool_output_capacity_exceeded",
          `Retaining the tool output would exceed the ${this.maxTotalBytes} byte durable evidence limit.`,
          {
            retainedBytes: usage.totalBytes,
            incomingBytes,
            maxTotalBytes: this.maxTotalBytes,
          },
        );
      }
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const token = requireRefToken(this.createRefToken());
        const ref = `${TOOL_OUTPUT_REF_PREFIX}${token}`;
        const target = this.entryDirectory(token);
        if (await pathExists(target)) continue;

        const createdAt = isoTimestamp(this.now());
        const metadata: ToolEvidenceMetadata = {
          schemaVersion: TOOL_EVIDENCE_SCHEMA_VERSION,
          ref,
          availability: "durable",
          mediaType: normalized.mediaType,
          sourceToolName: normalized.sourceToolName,
          sourceCallId: normalized.sourceCallId,
          ...(normalized.sourceFactId === undefined ? {} : { sourceFactId: normalized.sourceFactId }),
          ...(normalized.ownerId === undefined ? {} : { ownerId: normalized.ownerId }),
          totalChars: normalized.content.length,
          byteLength: incomingBytes,
          sha256: sha256(normalized.content),
          createdAt,
        };
        const temporary = path.join(this.entriesRoot, `.${token}.${randomUUID()}.tmp`);
        try {
          await fs.mkdir(temporary);
          await fs.writeFile(path.join(temporary, CONTENT_FILE), normalized.content, {
            encoding: "utf8",
            mode: 0o600,
          });
          await fs.writeFile(path.join(temporary, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          await fs.rename(temporary, target);
          usage.entries += 1;
          usage.totalBytes += incomingBytes;
          return retentionFromMetadata(metadata);
        } catch (error) {
          if (await pathExists(target)) continue;
          throw error;
        } finally {
          await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      throw new ToolOutputStoreError(
        "tool_output_ref_generation_failed",
        "Tool evidence store could not produce a unique reference.",
      );
    });
  }

  async read(ref: string, window: ToolOutputReadWindow): Promise<ToolOutputSlice | undefined> {
    const token = refToken(ref);
    const normalizedWindow = normalizeReadWindow(window);
    const directory = this.entryDirectory(token);
    const metadata = await this.readMetadata(directory);
    if (metadata === undefined) {
      if (await pathExists(directory)) {
        throw corruptEvidence(ref, "Stored tool evidence metadata is missing.");
      }
      return undefined;
    }
    if (metadata.ref !== ref) {
      throw corruptEvidence(ref, "Stored metadata does not match the requested reference.");
    }

    if (normalizedWindow.startChar > metadata.totalChars) {
      throw new ToolOutputStoreError(
        "tool_output_window_out_of_range",
        `Tool output startChar ${normalizedWindow.startChar} exceeds totalChars ${metadata.totalChars}.`,
        { startChar: normalizedWindow.startChar, totalChars: metadata.totalChars },
      );
    }
    const slice = await this.readVerifiedWindow(ref, directory, metadata, normalizedWindow);
    const nextStartChar = normalizedWindow.startChar + slice.length;
    return {
      ...retentionFromMetadata(metadata),
      content: slice,
      startChar: normalizedWindow.startChar,
      textChars: slice.length,
      hasMoreAfter: nextStartChar < metadata.totalChars,
    };
  }

  release(ref: string): Promise<boolean> {
    return this.mutate(async () => {
      const directory = this.entryDirectory(refToken(ref));
      if (!(await pathExists(directory))) return false;
      const metadata = await this.readMetadata(directory);
      if (metadata === undefined) {
        throw corruptEvidence(ref, "Stored tool evidence metadata is missing.");
      }
      const usage = await this.currentUsage();
      await fs.rm(directory, { recursive: true, force: false });
      usage.entries = Math.max(0, usage.entries - 1);
      usage.totalBytes = Math.max(0, usage.totalBytes - metadata.byteLength);
      this.deleteVerifiedEntry(ref);
      return true;
    });
  }

  releaseOwner(ownerId: string): Promise<number> {
    return this.mutate(async () => {
      const normalizedOwner = nonEmptyText(ownerId, "ownerId");
      const usage = await this.currentUsage();
      let released = 0;
      for (const directory of await this.entryDirectories()) {
        const metadata = await this.readMetadata(directory);
        if (metadata === undefined) {
          throw corruptEvidence(path.basename(directory), "Stored tool evidence metadata is missing.");
        }
        if (metadata.ownerId !== normalizedOwner) continue;
        await fs.rm(directory, { recursive: true, force: false });
        usage.entries = Math.max(0, usage.entries - 1);
        usage.totalBytes = Math.max(0, usage.totalBytes - metadata.byteLength);
        this.deleteVerifiedEntry(metadata.ref);
        released += 1;
      }
      return released;
    });
  }

  clear(): Promise<void> {
    return this.mutate(async () => {
      for (const directory of await this.entryDirectories(true)) {
        await fs.rm(directory, { recursive: true, force: true });
      }
      this.usage = { entries: 0, totalBytes: 0 };
      this.clearVerifiedState();
    });
  }

  async close(): Promise<void> {
    await this.mutationTail;
    this.clearVerifiedState();
  }

  private entryDirectory(token: string): string {
    return path.join(this.entriesRoot, token);
  }

  private async entryDirectories(includeTemporary = false): Promise<readonly string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.entriesRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return entries.flatMap((entry) => {
      if (!entry.isDirectory()) return [];
      if (!includeTemporary && entry.name.startsWith(".")) return [];
      return [path.join(this.entriesRoot, entry.name)];
    });
  }

  private async readMetadata(directory: string): Promise<ToolEvidenceMetadata | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(directory, METADATA_FILE), "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw corruptEvidence(path.basename(directory), "Stored tool evidence metadata is not valid JSON.");
    }
    const result = metadataSchema.safeParse(parsed);
    if (!result.success) {
      throw corruptEvidence(
        path.basename(directory),
        `Stored tool evidence metadata is invalid at ${result.error.issues[0]?.path.join(".") || "root"}.`,
      );
    }
    if (!Number.isFinite(Date.parse(result.data.createdAt))) {
      throw corruptEvidence(result.data.ref, "Stored tool evidence createdAt is invalid.");
    }
    return result.data;
  }

  private async currentUsage(): Promise<{ entries: number; totalBytes: number }> {
    if (this.usage !== undefined) {
      return this.usage;
    }
    let entries = 0;
    let totalBytes = 0;
    for (const directory of await this.entryDirectories()) {
      const metadata = await this.readMetadata(directory);
      if (metadata === undefined) {
        throw corruptEvidence(path.basename(directory), "Stored tool evidence metadata is missing.");
      }
      entries += 1;
      totalBytes += metadata.byteLength;
      if (!Number.isSafeInteger(totalBytes)) {
        throw new ToolOutputStoreError(
          "tool_output_capacity_exceeded",
          "Durable tool evidence usage exceeds the supported accounting range.",
        );
      }
    }
    this.usage = { entries, totalBytes };
    return this.usage;
  }

  private async readVerifiedWindow(
    ref: string,
    directory: string,
    metadata: ToolEvidenceMetadata,
    window: ToolOutputReadWindow,
  ): Promise<string> {
    const contentPath = path.join(directory, CONTENT_FILE);
    const verified = await this.verifiedFile(ref, contentPath, metadata);
    const cached = this.cachedContent.get(ref);
    if (cached !== undefined) {
      this.cachedContent.delete(ref);
      this.cachedContent.set(ref, cached);
      return sliceVerifiedText(
        ref,
        cached.content,
        window.startChar,
        window.maxChars,
        window.startChar,
      );
    }
    return readIndexedWindow(contentPath, ref, metadata, verified, window);
  }

  private async verifiedFile(
    ref: string,
    contentPath: string,
    metadata: ToolEvidenceMetadata,
  ): Promise<VerifiedFileEntry> {
    const currentIdentity = fileIdentity(await statEvidenceContent(contentPath, ref));
    const verified = this.verifiedFiles.get(ref);
    if (verified !== undefined && sameFileIdentity(verified.identity, currentIdentity)) {
      return verified;
    }
    if (verified !== undefined) {
      this.deleteVerifiedEntry(ref);
    }

    const pending = this.pendingVerifications.get(ref);
    if (pending !== undefined) {
      const entry = await pending;
      const latestIdentity = fileIdentity(await statEvidenceContent(contentPath, ref));
      if (sameFileIdentity(entry.identity, latestIdentity)) {
        return entry;
      }
      this.deleteVerifiedEntry(ref);
    }

    const verification = verifyEvidenceFile(contentPath, ref, metadata, this.maxReadCacheBytes)
      .then(({ entry, content }) => {
        this.verifiedFiles.set(ref, entry);
        if (content !== undefined) {
          this.cacheVerifiedContent(ref, { content, byteLength: metadata.byteLength });
        }
        return entry;
      })
      .finally(() => {
        if (this.pendingVerifications.get(ref) === verification) {
          this.pendingVerifications.delete(ref);
        }
      });
    this.pendingVerifications.set(ref, verification);
    return verification;
  }

  private cacheVerifiedContent(ref: string, entry: CachedContentEntry): void {
    if (entry.byteLength > this.maxReadCacheBytes) {
      return;
    }
    while (this.readCacheBytes + entry.byteLength > this.maxReadCacheBytes) {
      const oldestRef = this.cachedContent.keys().next().value as string | undefined;
      if (oldestRef === undefined) break;
      this.deleteReadCacheEntry(oldestRef);
    }
    this.cachedContent.set(ref, entry);
    this.readCacheBytes += entry.byteLength;
  }

  private deleteReadCacheEntry(ref: string): void {
    const cached = this.cachedContent.get(ref);
    if (cached === undefined) return;
    this.cachedContent.delete(ref);
    this.readCacheBytes = Math.max(0, this.readCacheBytes - cached.byteLength);
  }

  private clearVerifiedState(): void {
    this.verifiedFiles.clear();
    this.cachedContent.clear();
    this.readCacheBytes = 0;
  }

  private deleteVerifiedEntry(ref: string): void {
    this.verifiedFiles.delete(ref);
    this.deleteReadCacheEntry(ref);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.mutationTail = previous.then(() => current, () => current);
    return previous.catch(() => undefined).then(operation).finally(release);
  }
}

async function verifyEvidenceFile(
  contentPath: string,
  ref: string,
  metadata: ToolEvidenceMetadata,
  maxReadCacheBytes: number,
): Promise<{ readonly entry: VerifiedFileEntry; readonly content?: string }> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(contentPath, "r");
  } catch (error) {
    if (isNotFound(error)) {
      throw corruptEvidence(ref, "Stored tool evidence content is missing.");
    }
    throw error;
  }

  let result: { readonly entry: VerifiedFileEntry; readonly content?: string };
  try {
    const initialStat = await handle.stat({ bigint: true });
    if (!initialStat.isFile()) {
      throw corruptEvidence(ref, "Stored tool evidence content is not a regular file.");
    }
    const initialIdentity = fileIdentity(initialStat);
    const decoder = new StringDecoder("utf8");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CONTENT_READ_BUFFER_BYTES);
    const checkpoints: ContentCheckpoint[] = [{ charOffset: 0, byteOffset: 0 }];
    const contentParts = initialStat.size <= BigInt(maxReadCacheBytes) ? [] as string[] : undefined;
    let position = 0;
    let decodedByteOffset = 0;
    let totalChars = 0;

    // Checkpoints are recorded only after StringDecoder emits complete UTF-8,
    // so each byte offset is also a valid UTF-16 window starting point.
    const acceptDecoded = (decoded: string): void => {
      if (decoded.length === 0) return;
      totalChars += decoded.length;
      decodedByteOffset += Buffer.byteLength(decoded, "utf8");
      contentParts?.push(decoded);
      checkpoints.push({ charOffset: totalChars, byteOffset: decodedByteOffset });
    };

    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      position += bytesRead;
      acceptDecoded(decoder.write(chunk));
    }
    acceptDecoded(decoder.end());

    const finalStat = await handle.stat({ bigint: true });
    const finalIdentity = fileIdentity(finalStat);
    const digest = hash.digest("hex");
    if (
      !sameFileIdentity(initialIdentity, finalIdentity) ||
      position !== metadata.byteLength ||
      decodedByteOffset !== metadata.byteLength ||
      totalChars !== metadata.totalChars ||
      digest !== metadata.sha256
    ) {
      throw corruptEvidence(ref, "Stored tool evidence content does not match its metadata.");
    }
    result = {
      entry: { identity: finalIdentity, checkpoints },
      ...(contentParts === undefined ? {} : { content: contentParts.join("") }),
    };
  } finally {
    await handle.close();
  }

  const pathIdentity = fileIdentity(await statEvidenceContent(contentPath, ref));
  if (!sameFileIdentity(result.entry.identity, pathIdentity)) {
    throw corruptEvidence(ref, "Stored tool evidence content changed while it was being verified.");
  }
  return result;
}

async function readIndexedWindow(
  contentPath: string,
  ref: string,
  metadata: ToolEvidenceMetadata,
  verified: VerifiedFileEntry,
  window: ToolOutputReadWindow,
): Promise<string> {
  const checkpoint = checkpointAtOrBefore(verified.checkpoints, window.startChar);
  const relativeStart = window.startChar - checkpoint.charOffset;
  const remainingChars = metadata.totalChars - checkpoint.charOffset;
  const requestedWithBoundaryLookahead = relativeStart + Math.min(window.maxChars, remainingChars) + 1;
  const targetChars = Math.min(remainingChars, requestedWithBoundaryLookahead);

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(contentPath, "r");
  } catch (error) {
    if (isNotFound(error)) {
      throw corruptEvidence(ref, "Stored tool evidence content is missing.");
    }
    throw error;
  }

  let decoded = "";
  try {
    const initialIdentity = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(initialIdentity, verified.identity)) {
      throw corruptEvidence(ref, "Stored tool evidence content changed after verification.");
    }
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(CONTENT_READ_BUFFER_BYTES);
    let bytePosition = checkpoint.byteOffset;
    while (decoded.length < targetChars && bytePosition < metadata.byteLength) {
      const bytesToRead = Math.min(buffer.length, metadata.byteLength - bytePosition);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, bytePosition);
      if (bytesRead === 0) break;
      bytePosition += bytesRead;
      decoded += decoder.write(buffer.subarray(0, bytesRead));
    }
    if (bytePosition === metadata.byteLength) {
      decoded += decoder.end();
    }
    const finalIdentity = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(finalIdentity, verified.identity)) {
      throw corruptEvidence(ref, "Stored tool evidence content changed while a window was being read.");
    }
  } finally {
    await handle.close();
  }

  const pathIdentity = fileIdentity(await statEvidenceContent(contentPath, ref));
  if (!sameFileIdentity(pathIdentity, verified.identity)) {
    throw corruptEvidence(ref, "Stored tool evidence content changed while a window was being read.");
  }
  if (decoded.length < targetChars) {
    throw corruptEvidence(ref, "Stored tool evidence content ended before the requested window.");
  }
  return sliceVerifiedText(
    ref,
    decoded,
    relativeStart,
    window.maxChars,
    window.startChar,
  );
}

function sliceVerifiedText(
  ref: string,
  content: string,
  startChar: number,
  maxChars: number,
  requestedStartChar: number,
): string {
  if (!isUtf16CodeUnitBoundary(content, startChar)) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_window",
      "Tool output startChar must not split a UTF-16 surrogate pair.",
      { ref, startChar: requestedStartChar },
    );
  }
  const endChar = utf16SafeWindowEnd(content, startChar, maxChars);
  return content.slice(startChar, endChar);
}

function checkpointAtOrBefore(
  checkpoints: readonly ContentCheckpoint[],
  startChar: number,
): ContentCheckpoint {
  let low = 0;
  let high = checkpoints.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((checkpoints[middle]?.charOffset ?? Number.MAX_SAFE_INTEGER) <= startChar) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return checkpoints[low] ?? { charOffset: 0, byteOffset: 0 };
}

async function statEvidenceContent(contentPath: string, ref: string): Promise<BigIntStats> {
  try {
    const stat = await fs.stat(contentPath, { bigint: true });
    if (!stat.isFile()) {
      throw corruptEvidence(ref, "Stored tool evidence content is not a regular file.");
    }
    return stat;
  } catch (error) {
    if (isNotFound(error)) {
      throw corruptEvidence(ref, "Stored tool evidence content is missing.");
    }
    throw error;
  }
}

function fileIdentity(stat: BigIntStats): FileIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    fileSize: stat.size,
    modifiedAtNs: stat.mtimeNs,
    changedAtNs: stat.ctimeNs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.fileSize === right.fileSize &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs;
}

function positiveSafeIntegerOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_store_configuration",
      `${name} must be a positive safe integer.`,
      { option: name, value: resolved },
    );
  }
  return resolved;
}

function normalizeRetainInput(input: RetainToolOutputInput): RetainToolOutputInput {
  if (input.mediaType !== "text/plain" && input.mediaType !== "application/json") {
    throw new ToolOutputStoreError(
      "invalid_tool_output",
      "Tool output mediaType must be text/plain or application/json.",
    );
  }
  if (typeof input.content !== "string") {
    throw new ToolOutputStoreError("invalid_tool_output", "Tool output content must be a string.");
  }
  const sourceToolName = nonEmptyText(input.sourceToolName, "sourceToolName");
  const sourceCallId = nonEmptyText(input.sourceCallId, "sourceCallId");
  const sourceFactId = input.sourceFactId === undefined
    ? undefined
    : nonEmptyText(input.sourceFactId, "sourceFactId");
  const ownerId = input.ownerId === undefined ? undefined : nonEmptyText(input.ownerId, "ownerId");
  const sourceMetadataChars = JSON.stringify({ sourceToolName, sourceCallId, sourceFactId }).length;
  if (sourceMetadataChars > MAX_TOOL_OUTPUT_SOURCE_METADATA_JSON_CHARS) {
    throw new ToolOutputStoreError(
      "tool_output_source_metadata_too_large",
      "Tool output provenance metadata exceeds the readable continuation budget.",
      { sourceMetadataChars, maxSourceMetadataChars: MAX_TOOL_OUTPUT_SOURCE_METADATA_JSON_CHARS },
    );
  }
  return {
    mediaType: input.mediaType,
    content: input.content,
    sourceToolName,
    sourceCallId,
    ...(sourceFactId === undefined ? {} : { sourceFactId }),
    ...(ownerId === undefined ? {} : { ownerId }),
  };
}

function retentionFromMetadata(metadata: ToolEvidenceMetadata): ToolOutputRetention {
  return {
    ref: metadata.ref,
    availability: metadata.availability,
    mediaType: metadata.mediaType,
    sourceToolName: metadata.sourceToolName,
    sourceCallId: metadata.sourceCallId,
    ...(metadata.sourceFactId === undefined ? {} : { sourceFactId: metadata.sourceFactId }),
    totalChars: metadata.totalChars,
    byteLength: metadata.byteLength,
    sha256: metadata.sha256,
    createdAt: metadata.createdAt,
  };
}

function normalizeReadWindow(window: ToolOutputReadWindow): ToolOutputReadWindow {
  if (!Number.isSafeInteger(window.startChar) || window.startChar < 0) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_window",
      "Tool output startChar must be a non-negative safe integer.",
      { startChar: window.startChar },
    );
  }
  if (!Number.isSafeInteger(window.maxChars) || window.maxChars <= 0) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_window",
      "Tool output maxChars must be a positive safe integer.",
      { maxChars: window.maxChars },
    );
  }
  return { startChar: window.startChar, maxChars: window.maxChars };
}

function refToken(ref: string): string {
  if (typeof ref !== "string" || !ref.startsWith(TOOL_OUTPUT_REF_PREFIX)) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_ref",
      `Tool output ref must use the ${TOOL_OUTPUT_REF_PREFIX} scheme.`,
    );
  }
  return requireRefToken(ref.slice(TOOL_OUTPUT_REF_PREFIX.length));
}

function requireRefToken(token: string): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(token)) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_ref",
      "Tool output ref contains an invalid token.",
    );
  }
  return token;
}

function nonEmptyText(value: string, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolOutputStoreError(
      "invalid_tool_output",
      `${fieldName} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function isoTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_store_configuration",
      "Tool evidence store clock must return a non-negative safe integer timestamp.",
      { value: Number.isFinite(value) ? value : String(value) },
    );
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_store_configuration",
      "Tool evidence store clock is outside the supported date range.",
      { value },
    );
  }
  return timestamp.toISOString();
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function corruptEvidence(ref: string, message: string): ToolOutputStoreError {
  return new ToolOutputStoreError("tool_output_corrupt", message, { ref });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT";
}
