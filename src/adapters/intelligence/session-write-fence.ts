import type {
  SessionMetadata,
  SessionStorage,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

export type SessionGenerationErrorCode =
  | "generation_active"
  | "generation_revoked"
  | "generation_revoke_failed";

export class SessionGenerationError extends Error {
  readonly code: SessionGenerationErrorCode;

  constructor(code: SessionGenerationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionGenerationError";
    this.code = code;
  }
}

type GenerationStatus = "active" | "revoking" | "revoked" | "revoke_failed" | "released";

type StorageGeneration<TMetadata extends SessionMetadata> = {
  readonly id: number;
  readonly storage: SessionStorage<TMetadata>;
  status: GenerationStatus;
  recoveryTargetLeafId?: string | null;
  revokedLeafId?: string | null;
  revocation?: {
    readonly targetLeafId: string | null;
    readonly promise: Promise<void>;
  };
  releasePromise?: Promise<void>;
};

export type SessionStorageGenerationLease<TMetadata extends SessionMetadata> = {
  readonly storage: SessionStorage<TMetadata>;
  revokeTo(targetLeafId: string | null): Promise<void>;
  release(): Promise<void>;
};

/**
 * Serializes durable writes for one Session and fences a cancelled writer before
 * its successor opens a fresh storage view. Session tree semantics stay in Pi.
 */
export class SessionWriteFence {
  private tail: Promise<void> = Promise.resolve();
  private nextGenerationId = 1;
  private currentGeneration?: StorageGeneration<SessionMetadata>;

  async acquire<TMetadata extends SessionMetadata>(
    openStorage: () => Promise<SessionStorage<TMetadata>>,
  ): Promise<SessionStorageGenerationLease<TMetadata>> {
    return this.enqueue(async () => {
      if (this.currentGeneration?.status === "active") {
        throw new SessionGenerationError(
          "generation_active",
          "The current Session generation is still active.",
        );
      }
      if (this.currentGeneration?.status === "revoke_failed") {
        throw new SessionGenerationError(
          "generation_revoke_failed",
          "The current Session generation could not restore its durable leaf.",
        );
      }
      const priorGeneration = this.currentGeneration;
      const storage = await openStorage();
      if (priorGeneration?.status === "revoked"
        && await storage.getLeafId() !== priorGeneration.revokedLeafId) {
        priorGeneration.status = "revoke_failed";
        throw new SessionGenerationError(
          "generation_revoke_failed",
          "The reopened Session does not expose the leaf restored by the revoked generation.",
        );
      }
      const generation: StorageGeneration<TMetadata> = {
        id: this.nextGenerationId++,
        storage,
        status: "active",
      };
      this.currentGeneration = generation;
      return {
        storage: new GenerationSessionStorage(this, generation),
        revokeTo: (targetLeafId) => this.revoke(generation, targetLeafId),
        release: () => this.release(generation),
      };
    });
  }

  async runWhenIdle<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (this.currentGeneration?.status === "active") {
        throw new SessionGenerationError(
          "generation_active",
          "The current Session generation is still active.",
        );
      }
      if (this.currentGeneration?.status === "revoke_failed") {
        throw new SessionGenerationError(
          "generation_revoke_failed",
          "The current Session generation could not restore its durable leaf.",
        );
      }
      return operation();
    });
  }

  executeWrite<TMetadata extends SessionMetadata, TValue>(
    generation: StorageGeneration<TMetadata>,
    operation: (storage: SessionStorage<TMetadata>) => Promise<TValue>,
  ): Promise<TValue> {
    return this.enqueue(async () => {
      this.assertActive(generation);
      return operation(generation.storage);
    });
  }

  async executeRead<TMetadata extends SessionMetadata, TValue>(
    generation: StorageGeneration<TMetadata>,
    operation: (storage: SessionStorage<TMetadata>) => Promise<TValue>,
  ): Promise<TValue> {
    this.assertActive(generation);
    return operation(generation.storage);
  }

  private revoke<TMetadata extends SessionMetadata>(
    generation: StorageGeneration<TMetadata>,
    targetLeafId: string | null,
  ): Promise<void> {
    if (generation.status === "released") {
      return Promise.reject(new SessionGenerationError(
        "generation_revoked",
        "The released Session generation can no longer restore a durable leaf.",
      ));
    }
    if (generation.recoveryTargetLeafId !== undefined
      && generation.recoveryTargetLeafId !== targetLeafId) {
      return Promise.reject(new SessionGenerationError(
        "generation_revoked",
        "The Session generation already has a different durable recovery leaf.",
      ));
    }
    generation.recoveryTargetLeafId ??= targetLeafId;
    if (generation.status === "revoked") {
      return generation.revokedLeafId === targetLeafId
        ? Promise.resolve()
        : Promise.reject(new SessionGenerationError(
            "generation_revoked",
            "The Session generation was already revoked to a different leaf.",
          ));
    }
    if (generation.revocation !== undefined) {
      return generation.revocation.targetLeafId === targetLeafId
        ? generation.revocation.promise
        : Promise.reject(new SessionGenerationError(
            "generation_revoked",
            "The Session generation is already being revoked to a different leaf.",
          ));
    }

    const operation = this.enqueue(async () => {
      if (generation.status === "released") return;
      if (generation.status === "revoked") return;
      if (this.currentGeneration !== generation) {
        throw this.revokedError(generation);
      }
      try {
        generation.status = "revoking";
        const currentLeafId = await generation.storage.getLeafId();
        if (currentLeafId !== targetLeafId) {
          await generation.storage.setLeafId(targetLeafId);
        }
        generation.status = "revoked";
        generation.revokedLeafId = targetLeafId;
      } catch (error) {
        generation.status = "revoke_failed";
        throw new SessionGenerationError(
          "generation_revoke_failed",
          "The Session generation could not restore its durable leaf.",
          { cause: error },
        );
      }
    });
    const tracked = operation.catch((error: unknown) => {
      generation.revocation = undefined;
      throw error;
    });
    generation.revocation = { targetLeafId, promise: tracked };
    return tracked;
  }

  private release<TMetadata extends SessionMetadata>(
    generation: StorageGeneration<TMetadata>,
  ): Promise<void> {
    generation.releasePromise ??= this.enqueue(async () => {
      if (generation.status === "revoke_failed") return;
      // A revoke requested in the same turn owns the durable leaf restore even
      // when ordinary cleanup happened to enqueue release first.
      if (generation.status === "active" && generation.revocation !== undefined) return;
      if (generation.status === "active") generation.status = "released";
      if (this.currentGeneration === generation) this.currentGeneration = undefined;
    });
    return generation.releasePromise;
  }

  private assertActive<TMetadata extends SessionMetadata>(generation: StorageGeneration<TMetadata>): void {
    if (generation.status !== "active" || this.currentGeneration !== generation) {
      throw this.revokedError(generation);
    }
  }

  private revokedError<TMetadata extends SessionMetadata>(
    generation: StorageGeneration<TMetadata>,
  ): SessionGenerationError {
    return new SessionGenerationError(
      generation.status === "revoke_failed" ? "generation_revoke_failed" : "generation_revoked",
      generation.status === "revoke_failed"
        ? "The Session generation could not restore its durable leaf."
        : "The Session generation is no longer allowed to access durable storage.",
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class GenerationSessionStorage<TMetadata extends SessionMetadata>
implements SessionStorage<TMetadata> {
  constructor(
    private readonly fence: SessionWriteFence,
    private readonly generation: StorageGeneration<TMetadata>,
  ) {}

  getMetadata(): Promise<TMetadata> {
    return this.read((storage) => storage.getMetadata());
  }

  getLeafId(): Promise<string | null> {
    return this.read((storage) => storage.getLeafId());
  }

  setLeafId(leafId: string | null): Promise<void> {
    return this.write((storage) => storage.setLeafId(leafId));
  }

  createEntryId(): Promise<string> {
    return this.read((storage) => storage.createEntryId());
  }

  appendEntry(entry: SessionTreeEntry): Promise<void> {
    return this.write((storage) => storage.appendEntry(entry));
  }

  getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return this.read((storage) => storage.getEntry(id));
  }

  findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return this.read((storage) => storage.findEntries(type));
  }

  getLabel(id: string): Promise<string | undefined> {
    return this.read((storage) => storage.getLabel(id));
  }

  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    return this.read((storage) => storage.getPathToRoot(leafId));
  }

  getEntries(): Promise<SessionTreeEntry[]> {
    return this.read((storage) => storage.getEntries());
  }

  private read<TValue>(
    operation: (storage: SessionStorage<TMetadata>) => Promise<TValue>,
  ): Promise<TValue> {
    return this.fence.executeRead(this.generation, operation);
  }

  private write<TValue>(
    operation: (storage: SessionStorage<TMetadata>) => Promise<TValue>,
  ): Promise<TValue> {
    return this.fence.executeWrite(this.generation, operation);
  }
}
