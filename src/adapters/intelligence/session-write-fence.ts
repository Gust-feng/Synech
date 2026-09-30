import type { Branch, Session, SessionMetadata } from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT, type Context } from "@earendil-works/pi-agent-core/harness/context";
import { branchTip, setValue } from "@earendil-works/pi-agent-core/harness/session";

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
  readonly session: Session<TMetadata>;
  status: GenerationStatus;
  /** `main` tip when this generation opened; a null revoke target restores it. */
  initialLeafId?: string | null;
  recoveryTargetLeafId?: string | null;
  revokedLeafId?: string | null;
  revocation?: {
    readonly targetLeafId: string | null;
    readonly promise: Promise<void>;
  };
  releasePromise?: Promise<void>;
  releaseError?: unknown;
};

export type SessionStorageGenerationLease<TMetadata extends SessionMetadata> = {
  readonly session: Session<TMetadata>;
  revokeTo(targetLeafId: string | null): Promise<void>;
  release(): Promise<void>;
};

/**
 * Serializes durable Session mutations and fences a cancelled writer before
 * its successor opens a fresh Pi Session.
 *
 * Pi owns commit ordering and the transcript tree. Synech owns the generation
 * revocation invariant that Pi's commit queue does not express: once a writer
 * generation has been revoked, its unfinished writes must not land.
 */
export class SessionWriteFence {
  private tail: Promise<void> = Promise.resolve();
  private currentGeneration?: StorageGeneration<SessionMetadata>;

  async acquire<TMetadata extends SessionMetadata>(
    openSession: () => Promise<Session<TMetadata>>,
  ): Promise<SessionStorageGenerationLease<TMetadata>> {
    return this.enqueue(async () => {
      this.assertIdle();
      const priorGeneration = this.currentGeneration;
      const session = await openSession();
      let initialLeafId: string | null;
      try {
        initialLeafId = await getMainLeafId(session);
      } catch (error) {
        try {
          await session.close(TODO_CONTEXT);
        } catch (closeError) {
          if (priorGeneration !== undefined) {
            priorGeneration.status = "revoke_failed";
            priorGeneration.releaseError = closeError;
          } else {
            this.currentGeneration = { session, status: "active", releaseError: closeError };
          }
        }
        throw error;
      }
      if (priorGeneration?.status === "revoked" && initialLeafId !== priorGeneration.revokedLeafId) {
        priorGeneration.status = "revoke_failed";
        try {
          await session.close(TODO_CONTEXT);
        } catch (closeError) {
          priorGeneration.releaseError = closeError;
        }
        throw new SessionGenerationError(
          "generation_revoke_failed",
          "The reopened Session does not expose the leaf restored by the revoked generation.",
        );
      }
      const generation: StorageGeneration<TMetadata> = { session, status: "active", initialLeafId };
      this.currentGeneration = generation;
      return {
        session: wrapSession(this, generation),
        revokeTo: (targetLeafId) => this.revoke(generation, targetLeafId),
        release: () => this.release(generation),
      };
    });
  }

  async runWhenIdle<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.assertIdle();
      return operation();
    });
  }

  executeRead<TMetadata extends SessionMetadata, TValue>(
    generation: StorageGeneration<TMetadata>,
    operation: (session: Session<TMetadata>) => Promise<TValue>,
  ): Promise<TValue> {
    this.assertActive(generation);
    return operation(generation.session);
  }

  executeWrite<TMetadata extends SessionMetadata, TValue>(
    generation: StorageGeneration<TMetadata>,
    operation: (session: Session<TMetadata>) => Promise<TValue>,
  ): Promise<TValue> {
    return this.enqueue(async () => {
      this.assertActive(generation);
      return operation(generation.session);
    });
  }

  private revoke<TMetadata extends SessionMetadata>(
    generation: StorageGeneration<TMetadata>,
    targetLeafId: string | null,
  ): Promise<void> {
    // A null target means "undo this generation's writes": the branch returns
    // to the tip the generation opened on, not to a detached empty branch.
    const resolvedTargetLeafId = targetLeafId ?? generation.initialLeafId ?? null;
    if (generation.status === "released") return Promise.reject(this.revokedError(generation));
    if (generation.recoveryTargetLeafId !== undefined && generation.recoveryTargetLeafId !== resolvedTargetLeafId) {
      return Promise.reject(new SessionGenerationError(
        "generation_revoked",
        "The Session generation already has a different durable recovery leaf.",
      ));
    }
    generation.recoveryTargetLeafId ??= resolvedTargetLeafId;
    if (generation.status === "revoked") {
      return generation.revokedLeafId === resolvedTargetLeafId
        ? Promise.resolve()
        : Promise.reject(new SessionGenerationError(
            "generation_revoked",
            "The Session generation was already revoked to a different leaf.",
          ));
    }
    if (generation.revocation !== undefined) {
      return generation.revocation.targetLeafId === resolvedTargetLeafId
        ? generation.revocation.promise
        : Promise.reject(new SessionGenerationError(
            "generation_revoked",
            "The Session generation is already being revoked to a different leaf.",
          ));
    }

    const operation = this.enqueue(async () => {
      if (generation.status === "released" || generation.status === "revoked") return;
      if (this.currentGeneration !== generation) throw this.revokedError(generation);
      try {
        generation.status = "revoking";
        if (await getMainLeafId(generation.session) !== resolvedTargetLeafId) {
          await generation.session.mutate(
            (mutator) => mutator.commit([setValue(branchTip("main"), resolvedTargetLeafId)], TODO_CONTEXT),
            TODO_CONTEXT,
          );
        }
        generation.status = "revoked";
        generation.revokedLeafId = resolvedTargetLeafId;
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
    generation.revocation = { targetLeafId: resolvedTargetLeafId, promise: tracked };
    return tracked;
  }

  private release<TMetadata extends SessionMetadata>(generation: StorageGeneration<TMetadata>): Promise<void> {
    generation.releasePromise ??= Promise.resolve().then(() => {
      const revocation = generation.revocation;
      if (revocation !== undefined) {
        // Do not wait from inside the fence queue: revoke is itself queued and
        // release may have been requested first in the same turn.
        return revocation.promise.then(
          () => this.enqueue(() => this.closeGeneration(generation)),
          () => this.enqueue(() => this.closeGeneration(generation)),
        );
      }
      return this.enqueue(() => this.closeGeneration(generation));
    });
    return generation.releasePromise;
  }

  private async closeGeneration<TMetadata extends SessionMetadata>(
    generation: StorageGeneration<TMetadata>,
  ): Promise<void> {
    if (generation.status === "released") return;
    try {
      await generation.session.close(TODO_CONTEXT);
    } catch (error) {
      // Keep the generation installed until close succeeds. Otherwise a later
      // acquire could silently collide with the still-open provider handle.
      generation.releaseError = error;
      throw error;
    }

    // A failed revoke is a durable safety fact, not a cleanup state. The
    // handle is closed, but the fence must remain poisoned for later writers.
    if (generation.status === "revoke_failed") return;
    generation.status = "released";
    if (this.currentGeneration === generation) this.currentGeneration = undefined;
  }

  private assertIdle(): void {
    const generation = this.currentGeneration;
    if (generation?.status === "revoke_failed") {
      throw new SessionGenerationError(
        "generation_revoke_failed",
        "The current Session generation could not restore its durable leaf.",
      );
    }
    if (generation?.status === "active" || generation?.status === "revoking" || generation?.releaseError !== undefined) {
      throw new SessionGenerationError("generation_active", "The current Session generation is still active.");
    }
  }

  private assertActive<TMetadata extends SessionMetadata>(generation: StorageGeneration<TMetadata>): void {
    if (generation.status !== "active" || this.currentGeneration !== generation) throw this.revokedError(generation);
  }

  private revokedError<TMetadata extends SessionMetadata>(generation: StorageGeneration<TMetadata>): SessionGenerationError {
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

const SESSION_WRITE_METHODS = new Set([
  "beginMutation", "mutate", "setValue", "deleteValue", "appendList", "deleteList",
  "setName", "setLabel", "close",
]);

const BRANCH_WRITE_METHODS = new Set(["appendMessage", "appendCustomEntry"]);

/**
 * Routes every Session call through the fence so a revoked generation is
 * rejected even when Pi's own mutation line would still accept it. The proxy
 * forwards the whole Session interface; the fence only decides admission and
 * ordering, never transcript semantics.
 */
function wrapSession<TMetadata extends SessionMetadata>(
  fence: SessionWriteFence,
  generation: StorageGeneration<TMetadata>,
): Session<TMetadata> {
  return new Proxy(generation.session, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "branch") {
        return (...args: unknown[]) => fence.executeRead(generation, async (session) => {
          const branch = await session.branch(args[0] as string, args[1] as Context);
          return branch === undefined ? undefined : wrapBranch(fence, generation, branch);
        });
      }
      if (SESSION_WRITE_METHODS.has(String(property))) {
        return (...args: unknown[]) => fence.executeWrite(generation, (session) => value.apply(session, args));
      }
      return (...args: unknown[]) => fence.executeRead(generation, (session) => value.apply(session, args));
    },
  });
}

function wrapBranch<TMetadata extends SessionMetadata>(
  fence: SessionWriteFence,
  generation: StorageGeneration<TMetadata>,
  branch: Branch,
): Branch {
  return new Proxy(branch, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (BRANCH_WRITE_METHODS.has(String(property))) {
        return (...args: unknown[]) => fence.executeWrite(generation, () => value.apply(target, args));
      }
      return (...args: unknown[]) => fence.executeRead(generation, () => value.apply(target, args));
    },
  });
}

export async function getMainLeafId(session: Session): Promise<string | null> {
  const branch = await session.branch("main", TODO_CONTEXT);
  return branch?.getTipId(TODO_CONTEXT) ?? null;
}

export async function getMainBranch(session: Session): Promise<Branch | undefined> {
  return session.branch("main", TODO_CONTEXT);
}

/** Moves the active `main` branch tip through one atomic Pi value commit. */
export async function moveMainTip(session: Session, targetLeafId: string | null): Promise<void> {
  await session.mutate(
    (mutator) => mutator.commit([setValue(branchTip("main"), targetLeafId)], TODO_CONTEXT),
    TODO_CONTEXT,
  );
}

/** Appends one AgentMessage to the active `main` branch. */
type MainBranch = NonNullable<Awaited<ReturnType<Session["branch"]>>>;
type AgentMessageParam = Parameters<MainBranch["appendMessage"]>[0];

export async function appendMainMessage(
  session: Session,
  message: AgentMessageParam,
): Promise<void> {
  const branch = await session.branch("main", TODO_CONTEXT);
  if (branch === undefined) throw new Error("Pi main branch is not available.");
  await branch.appendMessage(message, TODO_CONTEXT);
}

/**
 * Active `main` branch from root to tip. The ordering is load-bearing: callers
 * compute rollback boundaries with `findIndex` and `slice`, so newest-first
 * would silently shift every index.
 */
export async function getMainBranchEntries(session: Session): Promise<Awaited<ReturnType<Branch["findEntries"]>>> {
  const branch = await session.branch("main", TODO_CONTEXT);
  return branch?.findEntries({ order: "oldestFirst" }, TODO_CONTEXT) ?? [];
}

/** Root-to-entry path ending at `entryId`, used for ancestry checks. */
export async function getMainBranchPathTo(
  session: Session,
  entryId: string,
): Promise<Awaited<ReturnType<Branch["findEntries"]>>> {
  const branch = await session.branch("main", TODO_CONTEXT);
  return branch?.findEntries({ start: entryId, order: "oldestFirst" }, TODO_CONTEXT) ?? [];
}
