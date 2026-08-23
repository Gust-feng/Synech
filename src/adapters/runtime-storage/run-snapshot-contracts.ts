export type RunEnvelope = {
  readonly runId: string;
  readonly updatedAt: string;
  readonly status: string;
  readonly runKind?: string;
  readonly runMode?: string;
  readonly rootRunId?: string;
  readonly parentRunId?: string;
  readonly conversationId?: string;
};

export type RunSnapshotCodec<TSnapshot> = {
  /** Stable persisted schema version owned by the feature that defines TSnapshot. */
  readonly schemaVersion: string;
  /** Decode and validate the JSON value stored inside the persistence document. */
  readonly decode: (value: unknown) => TSnapshot;
};

export type RunSnapshotStoreErrorCode =
  | "invalid_snapshot_store_configuration"
  | "invalid_run_id"
  | "snapshot_serialization_failed"
  | "snapshot_incompatible"
  | "snapshot_schema_version_mismatch"
  | "snapshot_identity_mismatch";

export class RunSnapshotStoreError extends Error {
  constructor(
    readonly code: RunSnapshotStoreErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RunSnapshotStoreError";
  }
}

export interface RunSnapshotStore<TSnapshot> {
  upsert(snapshot: TSnapshot): Promise<TSnapshot>;
  get(runId: string): Promise<TSnapshot | undefined>;
  list(limit?: number): Promise<readonly TSnapshot[]>;
  delete(runId: string): Promise<void>;
}

export function createInMemoryRunSnapshotStore<TSnapshot>(input: {
  readonly getEnvelope: (snapshot: TSnapshot) => RunEnvelope;
  readonly codec: RunSnapshotCodec<TSnapshot>;
}): RunSnapshotStore<TSnapshot> {
  assertRunSnapshotCodec(input.codec);
  const snapshots = new Map<string, TSnapshot>();
  return {
    async upsert(snapshot: TSnapshot): Promise<TSnapshot> {
      const stored = validateRunSnapshotForStorage({
        value: snapshot,
        codec: input.codec,
        getEnvelope: input.getEnvelope,
      }).snapshot;
      snapshots.set(validatedRunEnvelope(input.getEnvelope(stored)).runId, stored);
      return cloneJson(stored);
    },
    async get(runId: string): Promise<TSnapshot | undefined> {
      requireRunId(runId);
      const snapshot = snapshots.get(runId);
      return snapshot === undefined ? undefined : cloneJson(snapshot);
    },
    async list(limit = 50): Promise<readonly TSnapshot[]> {
      return [...snapshots.values()]
        .sort((left, right) => compareRunEnvelopeByRecency(input.getEnvelope(left), input.getEnvelope(right)))
        .slice(0, Math.max(0, Math.floor(limit)))
        .map((snapshot) => cloneJson(snapshot));
    },
    async delete(runId: string): Promise<void> {
      requireRunId(runId);
      snapshots.delete(runId);
    },
  };
}

export function assertRunSnapshotCodec<TSnapshot>(codec: RunSnapshotCodec<TSnapshot>): void {
  if (typeof codec.schemaVersion !== "string" || codec.schemaVersion.trim().length === 0) {
    throw new RunSnapshotStoreError(
      "invalid_snapshot_store_configuration",
      "Run snapshot codec schemaVersion must be a non-empty string.",
    );
  }
  if (typeof codec.decode !== "function") {
    throw new RunSnapshotStoreError(
      "invalid_snapshot_store_configuration",
      "Run snapshot codec decode must be a function.",
    );
  }
}

export function validateRunSnapshotForStorage<TSnapshot>(input: {
  readonly value: TSnapshot;
  readonly codec: RunSnapshotCodec<TSnapshot>;
  readonly getEnvelope: (snapshot: TSnapshot) => RunEnvelope;
  readonly expectedRunId?: string;
}): { readonly snapshot: TSnapshot; readonly envelope: RunEnvelope } {
  const jsonValue = jsonRoundTrip(input.value);
  return decodeRunSnapshot({
    value: jsonValue,
    codec: input.codec,
    getEnvelope: input.getEnvelope,
    expectedRunId: input.expectedRunId,
  });
}

export function decodeRunSnapshot<TSnapshot>(input: {
  readonly value: unknown;
  readonly codec: RunSnapshotCodec<TSnapshot>;
  readonly getEnvelope: (snapshot: TSnapshot) => RunEnvelope;
  readonly expectedRunId?: string;
}): { readonly snapshot: TSnapshot; readonly envelope: RunEnvelope } {
  let snapshot: TSnapshot;
  try {
    snapshot = input.codec.decode(input.value);
  } catch (cause) {
    throw new RunSnapshotStoreError(
      "snapshot_incompatible",
      `Run snapshot is incompatible with ${input.codec.schemaVersion}.`,
      { cause },
    );
  }
  let envelope: RunEnvelope;
  try {
    envelope = validatedRunEnvelope(input.getEnvelope(snapshot));
  } catch (cause) {
    if (cause instanceof RunSnapshotStoreError) throw cause;
    throw new RunSnapshotStoreError(
      "snapshot_incompatible",
      "Run snapshot envelope could not be decoded.",
      { cause },
    );
  }
  if (input.expectedRunId !== undefined && envelope.runId !== input.expectedRunId) {
    throw new RunSnapshotStoreError(
      "snapshot_identity_mismatch",
      `Run snapshot identity ${envelope.runId} does not match owner ${input.expectedRunId}.`,
    );
  }
  return { snapshot: cloneJson(snapshot), envelope: { ...envelope } };
}

export function validatedRunEnvelope(envelope: RunEnvelope): RunEnvelope {
  const runId = requireRunId(envelope.runId);
  const updatedAt = requireEnvelopeText(envelope.updatedAt, "updatedAt");
  const status = requireEnvelopeText(envelope.status, "status");
  return {
    runId,
    updatedAt,
    status,
    ...optionalEnvelopeText("runKind", envelope.runKind),
    ...optionalEnvelopeText("runMode", envelope.runMode),
    ...optionalEnvelopeText("rootRunId", envelope.rootRunId),
    ...optionalEnvelopeText("parentRunId", envelope.parentRunId),
    ...optionalEnvelopeText("conversationId", envelope.conversationId),
  };
}

export function requireRunId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new RunSnapshotStoreError("invalid_run_id", "Run id must be non-empty and must not contain NUL.");
  }
  return value;
}

function compareRunEnvelopeByRecency(left: RunEnvelope, right: RunEnvelope): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function cloneJson<T>(value: T): T {
  return jsonRoundTrip(value) as T;
}

function jsonRoundTrip(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("value is not JSON serializable");
    }
    return JSON.parse(serialized) as unknown;
  } catch (cause) {
    if (cause instanceof RunSnapshotStoreError) throw cause;
    throw new RunSnapshotStoreError(
      "snapshot_serialization_failed",
      "Run snapshot must be JSON serializable.",
      { cause },
    );
  }
}

function requireEnvelopeText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunSnapshotStoreError(
      "snapshot_incompatible",
      `Run snapshot envelope ${field} must be a non-empty string.`,
    );
  }
  return value;
}

function optionalEnvelopeText<TKey extends keyof RunEnvelope>(
  key: TKey,
  value: RunEnvelope[TKey],
): Partial<Pick<RunEnvelope, TKey>> {
  return value === undefined
    ? {}
    : { [key]: requireEnvelopeText(value as string, String(key)) } as Partial<Pick<RunEnvelope, TKey>>;
}
