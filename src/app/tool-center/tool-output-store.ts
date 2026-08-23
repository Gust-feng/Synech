import { createHash, randomUUID } from "node:crypto";
import { isUtf16CodeUnitBoundary, utf16SafeWindowEnd } from "./text-window.js";
import { MAX_TOOL_OUTPUT_SOURCE_METADATA_JSON_CHARS } from "./tool-output-limits.js";

export const TOOL_OUTPUT_REF_PREFIX = "tool-output://";

export type ToolOutputMediaType = "text/plain" | "application/json";
export type ToolOutputAvailability = "live_only" | "durable";

export type RetainToolOutputInput = {
  readonly mediaType: ToolOutputMediaType;
  readonly content: string;
  readonly sourceToolName: string;
  readonly sourceCallId: string;
  readonly sourceFactId?: string;
  /** Runtime trace that owns the retained fact; never exposed through the opaque ref. */
  readonly ownerId?: string;
};

export type ToolOutputRetention = {
  readonly ref: string;
  readonly availability: ToolOutputAvailability;
  readonly mediaType: ToolOutputMediaType;
  readonly sourceToolName: string;
  readonly sourceCallId: string;
  readonly sourceFactId?: string;
  readonly totalChars: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
};

export type ToolOutputReadWindow = {
  readonly startChar: number;
  readonly maxChars: number;
};

export type ToolOutputSlice = ToolOutputRetention & {
  readonly content: string;
  readonly startChar: number;
  readonly textChars: number;
  readonly hasMoreAfter: boolean;
};

export interface ToolOutputStore {
  retain(input: RetainToolOutputInput): Promise<ToolOutputRetention>;
  read(ref: string, window: ToolOutputReadWindow): Promise<ToolOutputSlice | undefined>;
  release(ref: string): Promise<boolean>;
  releaseOwner(ownerId: string): Promise<number>;
  clear(): Promise<void>;
  /** Releases process resources without deleting durable evidence. */
  close?(): Promise<void>;
}

export type ToolOutputStoreErrorCode =
  | "invalid_tool_output_store_configuration"
  | "invalid_tool_output"
  | "invalid_tool_output_ref"
  | "invalid_tool_output_window"
  | "tool_output_window_out_of_range"
  | "tool_output_item_too_large"
  | "tool_output_capacity_exceeded"
  | "tool_output_ref_generation_failed"
  | "tool_output_not_found"
  | "tool_output_corrupt"
  | "tool_output_read_budget_exceeded"
  | "tool_output_source_metadata_too_large";

export class ToolOutputStoreError extends Error {
  constructor(
    readonly code: ToolOutputStoreErrorCode,
    message: string,
    readonly facts: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
    this.name = "ToolOutputStoreError";
  }
}

export type InMemoryToolOutputStoreOptions = {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxItemChars?: number;
  readonly maxTotalChars?: number;
  readonly now?: () => number;
  readonly createRefToken?: () => string;
};

export const DEFAULT_TOOL_OUTPUT_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_TOOL_OUTPUT_MAX_ENTRIES = 128;
export const DEFAULT_TOOL_OUTPUT_MAX_ITEM_CHARS = 4_000_000;
export const DEFAULT_TOOL_OUTPUT_MAX_TOTAL_CHARS = 32_000_000;

type StoredToolOutput = ToolOutputRetention & {
  readonly availability: "live_only";
  readonly expiresAt: string;
  readonly content: string;
  readonly expiresAtMs: number;
  readonly ownerId?: string;
};

/**
 * Process-local backing for exact tool-result continuation. It is deliberately
 * bounded and non-enumerable; callers can retain, read by opaque ref, release
 * an exact ref/owner, or clear the process-local cache.
 */
export class InMemoryToolOutputStore implements ToolOutputStore {
  private readonly entries = new Map<string, StoredToolOutput>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxItemChars: number;
  private readonly maxTotalChars: number;
  private readonly now: () => number;
  private readonly createRefToken: () => string;
  private totalChars = 0;

  constructor(options: InMemoryToolOutputStoreOptions = {}) {
    this.ttlMs = positiveSafeIntegerOption("ttlMs", options.ttlMs, DEFAULT_TOOL_OUTPUT_TTL_MS);
    this.maxEntries = positiveSafeIntegerOption(
      "maxEntries",
      options.maxEntries,
      DEFAULT_TOOL_OUTPUT_MAX_ENTRIES,
    );
    this.maxItemChars = positiveSafeIntegerOption(
      "maxItemChars",
      options.maxItemChars,
      DEFAULT_TOOL_OUTPUT_MAX_ITEM_CHARS,
    );
    this.maxTotalChars = positiveSafeIntegerOption(
      "maxTotalChars",
      options.maxTotalChars,
      DEFAULT_TOOL_OUTPUT_MAX_TOTAL_CHARS,
    );
    this.now = options.now ?? Date.now;
    this.createRefToken = options.createRefToken ?? randomUUID;
  }

  async retain(input: RetainToolOutputInput): Promise<ToolOutputRetention> {
    const normalized = normalizeRetainInput(input);
    const nowMs = this.currentTimeMs();
    this.cleanupExpired(nowMs);

    if (normalized.content.length > this.maxItemChars) {
      throw new ToolOutputStoreError(
        "tool_output_item_too_large",
        `Tool output has ${normalized.content.length} characters; the per-item limit is ${this.maxItemChars}.`,
        {
          totalChars: normalized.content.length,
          maxItemChars: this.maxItemChars,
        },
      );
    }
    if (this.entries.size >= this.maxEntries) {
      throw new ToolOutputStoreError(
        "tool_output_capacity_exceeded",
        `Tool output store already contains the maximum ${this.maxEntries} live entries.`,
        {
          liveEntries: this.entries.size,
          maxEntries: this.maxEntries,
        },
      );
    }
    if (this.totalChars + normalized.content.length > this.maxTotalChars) {
      throw new ToolOutputStoreError(
        "tool_output_capacity_exceeded",
        `Retaining the tool output would exceed the ${this.maxTotalChars} character store limit.`,
        {
          retainedChars: this.totalChars,
          incomingChars: normalized.content.length,
          maxTotalChars: this.maxTotalChars,
        },
      );
    }

    const ref = this.createUniqueRef();
    const expiresAtMs = nowMs + this.ttlMs;
    const retention: ToolOutputRetention & {
      readonly availability: "live_only";
      readonly expiresAt: string;
    } = {
      ref,
      availability: "live_only",
      mediaType: normalized.mediaType,
      sourceToolName: normalized.sourceToolName,
      sourceCallId: normalized.sourceCallId,
      ...(normalized.sourceFactId === undefined ? {} : { sourceFactId: normalized.sourceFactId }),
      totalChars: normalized.content.length,
      byteLength: Buffer.byteLength(normalized.content, "utf8"),
      sha256: createHash("sha256").update(normalized.content, "utf8").digest("hex"),
      createdAt: isoTimestamp(nowMs, "current time"),
      expiresAt: isoTimestamp(expiresAtMs, "expiration time"),
    };
    this.entries.set(ref, {
      ...retention,
      content: normalized.content,
      expiresAtMs,
      ...(normalized.ownerId === undefined ? {} : { ownerId: normalized.ownerId }),
    });
    this.totalChars += normalized.content.length;
    return { ...retention };
  }

  async read(ref: string, window: ToolOutputReadWindow): Promise<ToolOutputSlice | undefined> {
    const normalizedRef = requireToolOutputRef(ref);
    const normalizedWindow = normalizeReadWindow(window);
    const nowMs = this.currentTimeMs();
    this.cleanupExpired(nowMs);
    const entry = this.entries.get(normalizedRef);
    if (entry === undefined) {
      return undefined;
    }
    if (normalizedWindow.startChar > entry.totalChars) {
      throw new ToolOutputStoreError(
        "tool_output_window_out_of_range",
        `Tool output startChar ${normalizedWindow.startChar} exceeds totalChars ${entry.totalChars}.`,
        {
          startChar: normalizedWindow.startChar,
          totalChars: entry.totalChars,
        },
      );
    }

    if (!isUtf16CodeUnitBoundary(entry.content, normalizedWindow.startChar)) {
      throw new ToolOutputStoreError(
        "invalid_tool_output_window",
        "Tool output startChar must not split a UTF-16 surrogate pair.",
        { startChar: normalizedWindow.startChar },
      );
    }

    const endChar = utf16SafeWindowEnd(
      entry.content,
      normalizedWindow.startChar,
      normalizedWindow.maxChars,
    );
    const content = entry.content.slice(normalizedWindow.startChar, endChar);
    const nextStartChar = normalizedWindow.startChar + content.length;
    return {
      ref: entry.ref,
      mediaType: entry.mediaType,
      sourceToolName: entry.sourceToolName,
      sourceCallId: entry.sourceCallId,
      ...(entry.sourceFactId === undefined ? {} : { sourceFactId: entry.sourceFactId }),
      availability: entry.availability,
      totalChars: entry.totalChars,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      content,
      startChar: normalizedWindow.startChar,
      textChars: content.length,
      hasMoreAfter: nextStartChar < entry.totalChars,
    };
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.totalChars = 0;
  }

  async close(): Promise<void> {
    await this.clear();
  }

  async release(ref: string): Promise<boolean> {
    const normalizedRef = requireToolOutputRef(ref);
    const entry = this.entries.get(normalizedRef);
    if (entry === undefined) {
      return false;
    }
    this.deleteEntry(normalizedRef, entry);
    return true;
  }

  async releaseOwner(ownerId: string): Promise<number> {
    const normalizedOwnerId = nonEmptyText(ownerId, "ownerId");
    let released = 0;
    for (const [ref, entry] of this.entries) {
      if (entry.ownerId === normalizedOwnerId) {
        this.deleteEntry(ref, entry);
        released += 1;
      }
    }
    return released;
  }

  private currentTimeMs(): number {
    const value = this.now();
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
      throw new ToolOutputStoreError(
        "invalid_tool_output_store_configuration",
        "Tool output store clock must return a non-negative safe integer timestamp.",
        { value: Number.isFinite(value) ? value : String(value) },
      );
    }
    return value;
  }

  private cleanupExpired(nowMs: number): void {
    for (const [ref, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) {
        this.deleteEntry(ref, entry);
      }
    }
  }

  private deleteEntry(ref: string, entry: StoredToolOutput): void {
    if (this.entries.delete(ref)) {
      this.totalChars = Math.max(0, this.totalChars - entry.totalChars);
    }
  }

  private createUniqueRef(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const token = this.createRefToken();
      if (!isValidRefToken(token)) {
        throw new ToolOutputStoreError(
          "tool_output_ref_generation_failed",
          "Tool output ref generator returned an invalid token.",
        );
      }
      const ref = `${TOOL_OUTPUT_REF_PREFIX}${token}`;
      if (!this.entries.has(ref)) {
        return ref;
      }
    }
    throw new ToolOutputStoreError(
      "tool_output_ref_generation_failed",
      "Tool output ref generator could not produce a unique ref.",
    );
  }
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
      {
        sourceMetadataChars,
        maxSourceMetadataChars: MAX_TOOL_OUTPUT_SOURCE_METADATA_JSON_CHARS,
      },
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

function requireToolOutputRef(value: string): string {
  if (typeof value !== "string" || !value.startsWith(TOOL_OUTPUT_REF_PREFIX)) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_ref",
      `Tool output ref must use the ${TOOL_OUTPUT_REF_PREFIX} scheme.`,
    );
  }
  const token = value.slice(TOOL_OUTPUT_REF_PREFIX.length);
  if (!isValidRefToken(token)) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_ref",
      "Tool output ref contains an invalid token.",
    );
  }
  return value;
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

function isValidRefToken(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value);
}

function isoTimestamp(value: number, label: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new ToolOutputStoreError(
      "invalid_tool_output_store_configuration",
      `Tool output ${label} is outside the supported date range.`,
      { value },
    );
  }
  return timestamp.toISOString();
}
