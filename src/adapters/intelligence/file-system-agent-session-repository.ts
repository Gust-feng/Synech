import { stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  JsonlSessionRepo,
  type Session,
  type JsonlSessionMetadata,
} from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import {
  appendList, branchTip, deleteValue, insertEntry, insertUsage, laneState, list,
  operationMeta, operationScopeOf, operationState, operationToolArgsPrefix,
  pendingEntry, setValue, SessionUnknownTargetError,
  type ToolsOperation, type Write,
} from "@earendil-works/pi-agent-core/harness/session";
import {
  agentRuntimeExecutionEnv,
  type AgentRuntimeEnvironment,
  type AgentSessionHandle,
} from "./pi-agent/runtime-environment.js";
import type { ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  AgentSessionCheckpointKind,
  AgentSessionCheckpointPosition,
  AgentSessionCheckpointRef,
  AgentSessionAssistantEntry,
  AgentSessionRef,
  AgentSessionRepository,
} from "../../app/model-runtime/agent-session.js";
import { AgentSessionRepositoryError } from "../../app/model-runtime/agent-session.js";
import type { TranscriptEntryRef } from "./agent-transcript.js";
import type { ModelInputAttachmentRef } from "../../domain/intelligence/index.js";
import { canonicalToolResultMessage } from "../../app/model-runtime/tool-result-message.js";
import { parseLegacyV3SessionHeader } from "./session-legacy-diagnostic.js";
import {
  normalizeToolFactValue,
  toolInvocationId,
  type ProviderToolCall,
  type ToolCallResult,
} from "../../domain/tools/index.js";
import {
  SessionGenerationError,
  SessionWriteFence,
  getMainBranchPathTo,
  getMainBranchEntries,
  getMainLeafId,
  moveMainTip,
  type SessionStorageGenerationLease,
} from "./session-write-fence.js";

export type AgentSessionLease = {
  readonly ref: AgentSessionRef;
  readonly session: AgentSessionHandle<JsonlSessionMetadata>;
  /** Mints and persists one durable checkpoint owned by this writer. */
  recordCheckpoint(
    kind: AgentSessionCheckpointKind,
    entryRef: TranscriptEntryRef,
  ): Promise<AgentSessionCheckpointRef>;
  /**
   * Restores this writer's durable leaf to the transcript position behind one
   * product checkpoint. Resolution reads the writer's own Session handle, the
   * line shared with concurrent readers while this writer is live.
   */
  revokeTo(target: AgentSessionCheckpointRef | null): Promise<void>;
  release(): Promise<void>;
};

export type FileSystemAgentSessionRepositoryConfig = {
  readonly executionEnvironment: AgentRuntimeEnvironment;
  readonly sessionsRoot: string;
  /** Host-owned bounded reuse; standalone/scoped consumers default to immediate close. */
  readonly idleSessionCacheSize?: number;
};

/**
 * Protects JSONL transcript location and single-writer ownership. Session tree,
 * navigation, compaction, and append semantics remain owned by the dependency.
 */
export class FileSystemAgentSessionRepository implements AgentSessionRepository {
  private readonly sessionsRoot: string;
  private readonly jsonlRepository: JsonlSessionRepo;
  private readonly fileSystem: ReturnType<typeof agentRuntimeExecutionEnv>;
  private readonly writeFences = new Map<string, SessionWriteFence>();
  /**
   * Pi permits only one open handle per session. This gate coordinates the
   * repository-owned handles without serializing unrelated sessions.
   */
  private readonly sessionAccessGates = new Map<string, SessionAccessGate>();
  /**
   * Live writer per session. Pi opens a session only once, so this handle is the
   * only readable line while a writer exists: readers run through it and the
   * checkpoint mapping commits on it.
   */
  private readonly writerSessions = new Map<string, Session<JsonlSessionMetadata>>();
  private readonly idleSessions = new Map<string, {
    readonly session: Session<JsonlSessionMetadata>;
    readonly revision: string;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly idleSessionCacheSize: number;
  private released = false;

  constructor(config: FileSystemAgentSessionRepositoryConfig) {
    this.sessionsRoot = path.resolve(config.sessionsRoot);
    this.idleSessionCacheSize = config.idleSessionCacheSize ?? 0;
    this.fileSystem = agentRuntimeExecutionEnv(config.executionEnvironment);
    this.jsonlRepository = new JsonlSessionRepo({
      fileSystem: this.fileSystem,
      sessionsRoot: this.sessionsRoot,
    });
  }

  async create(input: { readonly sessionId: string; readonly sessionCwd: string }): Promise<AgentSessionRef> {
    requireNonEmpty(input.sessionId, "sessionId");
    requireNonEmpty(input.sessionCwd, "sessionCwd");
    return this.runInSessionAccess(input.sessionId, async () => {
      const duplicate = (await this.jsonlRepository.list({ cwd: input.sessionCwd }, TODO_CONTEXT))
        .some((metadata) => metadata.id === input.sessionId);
      if (duplicate) {
        throw new AgentSessionRepositoryError(
          "agent_session_duplicate",
          `Agent session ${input.sessionId} already exists.`,
        );
      }
      const session = await this.jsonlRepository.create(
        { id: input.sessionId, cwd: input.sessionCwd },
        TODO_CONTEXT,
      );
      try {
        return this.refFromMetadata(session.metadata);
      } finally {
        await session.close(TODO_CONTEXT);
      }
    });
  }

  async acquire(ref: AgentSessionRef): Promise<AgentSessionLease> {
    this.validateRef(ref);
    return this.runInSessionAccess(ref.sessionId, async () => {
      const fence = this.writeFence(ref.sessionId);
      let generation: SessionStorageGenerationLease<JsonlSessionMetadata>;
      try {
        generation = await fence.acquire(async () => {
          const session = await this.openForAccess(ref);
          // Fence close ends this generation. Only the underlying Pi handle may
          // remain reusable; the old generation's proxy remains permanently revoked.
          return new Proxy(session, {
            get: (target, property) => property === "close"
              ? () => this.releaseToIdle(ref, target)
              : typeof Reflect.get(target, property) === "function"
                ? Reflect.get(target, property).bind(target)
                : Reflect.get(target, property),
          });
        });
      } catch (error) {
        if (error instanceof SessionGenerationError && error.code === "generation_active") {
          throw new AgentSessionRepositoryError(
            "agent_session_writer_active",
            `Agent session ${ref.sessionId} already has an active writer.`,
            { cause: error },
          );
        }
        if (error instanceof SessionGenerationError && error.code === "generation_revoke_failed") {
          throw new AgentSessionRepositoryError(
            "agent_session_revoke_failed",
            `Agent session ${ref.sessionId} cannot open a new writer because its durable leaf was not restored.`,
            { cause: error },
          );
        }
        throw error;
      }
      this.beginWriter(ref, generation.session);
      let revocation: { readonly target: AgentSessionCheckpointRef | null; readonly promise: Promise<void> } | undefined;
      let releasePromise: Promise<void> | undefined;
      return {
        ref,
        session: generation.session,
        recordCheckpoint: (kind, entryRef) => this.mintCheckpoint(generation.session, ref, kind, entryRef),
        revokeTo: (target) => {
          if (revocation !== undefined) {
            const previous = revocation.target;
            if (previous === null ? target === null : target !== null &&
                previous.sessionId === target.sessionId &&
                previous.checkpointId === target.checkpointId && previous.kind === target.kind) {
              return revocation.promise;
            }
            return Promise.reject(new SessionGenerationError(
              "generation_revoked",
              "The Session generation already has a different recovery checkpoint.",
            ));
          }
          // Register resolution and rollback together before either can yield.
          // Release waits outside the fence queue, which rollback itself needs.
          const ownedTarget = target === null ? null : { ...target };
          const promise = Promise.resolve().then(async () => {
            if (ownedTarget === null) {
              await generation.revokeTo(null);
              return;
            }
            this.assertCheckpointIdentity(ref, ownedTarget);
            const index = await readEntireCheckpointIndex(generation.session);
            const entryId = recordedCheckpointEntryId(index, ownedTarget);
            if (entryId === undefined) {
              throw new AgentSessionRepositoryError(
                "agent_session_checkpoint_unknown",
                "Agent session " + ref.sessionId + " has no recorded checkpoint " + ownedTarget.checkpointId + ".",
              );
            }
            await generation.revokeTo(entryId);
          });
          const attempt = { target: ownedTarget, promise };
          revocation = attempt;
          void promise.catch(() => {
            if (revocation === attempt) revocation = undefined;
          });
          return promise;
        },
        release: () => {
          releasePromise ??= this.runInSessionAccess(ref.sessionId, async () => {
            // Close even after a failed rollback; the fence retains its poison.
            await revocation?.promise.catch(() => undefined);
            await generation.release();
            this.endWriter(ref, generation.session);
          });
          return releasePromise;
        },
      };
    });
  }

  /** Publishes the writer's own handle for the whole writer generation. */
  private beginWriter(ref: AgentSessionRef, session: Session<JsonlSessionMetadata>): void {
    this.writerSessions.set(ref.sessionId, session);
  }

  private endWriter(ref: AgentSessionRef, session: Session<JsonlSessionMetadata>): void {
    if (this.writerSessions.get(ref.sessionId) === session) this.writerSessions.delete(ref.sessionId);
  }

  /**
   * Runs one read on the live writer's own handle while this session is being
   * written, and inside a scoped handle otherwise. Pi opens a session only once,
   * so a reader that opened a second handle would be refused: the writer's line
   * is the readable one, and a run reads its own commits through the same line.
   * That line is generation-checked, so a read that lands on a revoked or
   * released writer reports a writer conflict instead of a stale answer.
   *
   * A read that leaves its own handle open permanently blocks the session for
   * every later read and writer, so the scoped handle always closes.
   *
   * The per-session gate closes the writer/open race. A writer cannot register
   * or unregister while a scoped read is opening, using, and closing its handle.
   * There is therefore no provider-error retry loop here.
   */
  private async readFromSession<T>(
    ref: AgentSessionRef,
    operation: (session: Session<JsonlSessionMetadata>) => Promise<T>,
  ): Promise<T> {
    this.validateRef(ref);
    return this.runInSessionAccess(ref.sessionId, async () => {
      const writer = this.writerSessions.get(ref.sessionId);
      if (writer !== undefined) {
        this.assertMetadataMatches(ref, writer.metadata);
        try {
          return await operation(writer);
        } catch (error) {
          if (!(error instanceof SessionGenerationError)) throw error;
          throw new AgentSessionRepositoryError(
            "agent_session_writer_active",
            `Agent session ${ref.sessionId} cannot be read because its writer is no longer active.`,
            { cause: error },
          );
        }
      }
      const session = await this.openForRead(ref);
      try {
        return await operation(session);
      } finally {
        await this.releaseToIdle(ref, session);
      }
    });
  }

  async moveActiveCheckpoint(
    ref: AgentSessionRef,
    target: AgentSessionCheckpointRef | null,
  ): Promise<AgentSessionCheckpointRef | null> {
    this.validateRef(ref);
    if (target !== null) this.assertCheckpointIdentity(ref, target);
    const lease = await this.acquire(ref);
    try {
      const index = target === null ? [] : await readEntireCheckpointIndex(lease.session);
      const targetLeafId = target === null ? null : recordedCheckpointEntryId(index, target);
      if (targetLeafId === undefined) throw new AgentSessionRepositoryError(
        "agent_session_checkpoint_unknown", `Agent session ${ref.sessionId} has no checkpoint ${target?.checkpointId}.`,
      );
      try {
        await moveMainTip(lease.session, targetLeafId);
      } catch (error) {
        if (!(error instanceof SessionUnknownTargetError)) throw error;
        throw new AgentSessionRepositoryError(
          "agent_session_ref_invalid",
          `Agent session checkpoint ${target?.checkpointId ?? "root"} does not name a durable entry.`,
          { cause: error },
        );
      }
      const restored = await getMainLeafId(lease.session);
      if (restored !== targetLeafId) {
        throw new AgentSessionRepositoryError(
          "agent_session_ref_invalid",
          `Agent session ${ref.sessionId} did not restore its active branch to checkpoint ${target?.checkpointId ?? "root"}.`,
        );
      }
      return target;
    } finally {
      await lease.release();
    }
  }

  /**
   * Transcript positions in branch order. Provider-internal: the product never
   * receives an entry id, so a change of provider ids cannot change which
   * positions exist.
   */
  async activeTranscriptPositions(ref: AgentSessionRef): Promise<readonly TranscriptEntryRef[]> {
    const entries = await this.readFromSession(ref, getMainBranchEntries);
    return entries.map((entry) => ({ sessionId: ref.sessionId, entryId: entry.id }));
  }

  async locateSessionCheckpoints(input: {
    readonly sessionRef: AgentSessionRef;
    readonly checkpoints: readonly AgentSessionCheckpointRef[];
  }): Promise<readonly AgentSessionCheckpointPosition[]> {
    for (const checkpoint of input.checkpoints) this.assertCheckpointIdentity(input.sessionRef, checkpoint);
    const unique = new Map(input.checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint] as const));
    if (unique.size === 0) return [];
    return this.readFromSession(input.sessionRef, async (session) => {
      const index = await readEntireCheckpointIndex(session);
      const resolved = resolveRecordedCheckpoints(input.sessionRef, [...unique.values()], index);
      const entries = await getMainBranchEntries(session);
      const positionByEntryId = new Map(entries.map((entry, position) => [entry.id, position] as const));
      return resolved.flatMap(({ checkpoint, entryRef }) => {
        const position = positionByEntryId.get(entryRef.entryId);
        return position === undefined ? [] : [{ checkpoint, position }];
      });
    });
  }

  /** Mints and persists the product identity of one existing durable entry. */
  async recordSessionCheckpoint(input: {
    readonly sessionRef: AgentSessionRef;
    readonly kind: AgentSessionCheckpointKind;
    readonly entryRef: TranscriptEntryRef;
  }): Promise<AgentSessionCheckpointRef> {
    this.validateRef(input.sessionRef);
    this.assertEntryBelongsToSession(input.sessionRef, input.entryRef);
    return this.recordCheckpointOnWriter(input.sessionRef, input.kind, input.entryRef);
  }

  async readAssistantEntriesByCheckpoint(input: {
    readonly sessionRef: AgentSessionRef;
    readonly checkpoints: readonly AgentSessionCheckpointRef[];
  }): Promise<readonly AgentSessionAssistantEntry[]> {
    for (const checkpoint of input.checkpoints) {
      this.assertCheckpointIdentity(input.sessionRef, checkpoint);
    }
    if (input.checkpoints.length === 0) return [];
    return this.readFromSession(input.sessionRef, async (session) => {
      const index = await readEntireCheckpointIndex(session);
      const records = resolveRecordedCheckpoints(input.sessionRef, input.checkpoints, index);
      const texts = await Promise.all(records.map((record) => this.readAssistantText(session, record.entryRef)));
      return input.checkpoints.map((checkpoint, index) => ({ checkpoint, text: texts[index] ?? "" }));
    });
  }

  /** Mints a checkpoint on the live writer's own mutation line. */
  private async recordCheckpointOnWriter(
    ref: AgentSessionRef,
    kind: AgentSessionCheckpointKind,
    entryRef: TranscriptEntryRef,
  ): Promise<AgentSessionCheckpointRef> {
    const session = this.writerSessions.get(ref.sessionId);
    if (session === undefined) {
      // Recovery records mappings for entries a previous writer already
      // committed, so it takes a short writer of its own. The live run keeps
      // the atomic path through the lease.
      const lease = await this.acquire(ref);
      try {
        return await this.mintCheckpoint(lease.session, ref, kind, entryRef, true);
      } finally {
        await lease.release();
      }
    }
    this.assertMetadataMatches(ref, session.metadata);
    return this.mintCheckpoint(session, ref, kind, entryRef, true);
  }

  /**
   * Derives one product identity from the durable checkpoint index and records
   * the transcript position behind it in the same mutation line.
   *
   * A per-kind counter held only in memory would let two writer generations of
   * one Session mint the same identity for different entries, silently
   * overwriting the earlier mapping.
   */
  private async mintCheckpoint(
    session: Session<JsonlSessionMetadata>,
    ref: AgentSessionRef,
    kind: AgentSessionCheckpointKind,
    entryRef: TranscriptEntryRef,
    requireDurableEntry = false,
  ): Promise<AgentSessionCheckpointRef> {
    this.assertEntryBelongsToSession(ref, entryRef);
    requireNonEmpty(entryRef.entryId, "entryId");
    return session.mutate(async (mutator) => {
      const recorded = await readEntireCheckpointIndex(mutator);
      if (requireDurableEntry && !(await mutator.getEntries([entryRef.entryId], TODO_CONTEXT)).has(entryRef.entryId)) {
        throw new AgentSessionRepositoryError(
          "agent_session_ref_invalid",
          `Agent session recovery entry ${entryRef.entryId} does not exist.`,
        );
      }
      // Live message_end carries a preallocated id before Pi commits the entry.
      const ordinal = recorded.filter((record) => record.kind === kind).length + 1;
      const checkpoint: AgentSessionCheckpointRef = {
        sessionId: ref.sessionId,
        checkpointId: kind + "#" + ordinal,
        kind,
      };
      if (recorded.some((record) => record.checkpointId === checkpoint.checkpointId)) {
        throw checkpointIndexConflict(`Checkpoint ${checkpoint.checkpointId} is already recorded.`);
      }
      await mutator.commit(
        [appendList(checkpointIndexAddress(), {
          checkpointId: checkpoint.checkpointId,
          kind,
          entryId: entryRef.entryId,
        })],
        TODO_CONTEXT,
      );
      return checkpoint;
    }, TODO_CONTEXT);
  }

  /** Durable checkpoint index; an absent index simply means no checkpoint yet. */
  private async readCheckpointIndex(ref: AgentSessionRef): Promise<readonly StoredCheckpoint[]> {
    return this.readFromSession(ref, readEntireCheckpointIndex);
  }

  /**
   * Resolves the transcript position behind each product checkpoint, in input
   * order. A missing or conflicting mapping is an explicit failure: the caller
   * must not guess an entry, silently rebuild the mapping, or fall back to the
   * current branch tip.
   */
  private async resolveTranscriptEntries(
    ref: AgentSessionRef,
    checkpoints: readonly AgentSessionCheckpointRef[],
  ): Promise<readonly RecordedCheckpoint[]> {
    if (checkpoints.length === 0) return [];
    for (const checkpoint of checkpoints) this.assertCheckpointIdentity(ref, checkpoint);
    const index = await this.readCheckpointIndex(ref);
    return resolveRecordedCheckpoints(ref, checkpoints, index);
  }

  private async resolveTranscriptEntry(
    ref: AgentSessionRef,
    checkpoint: AgentSessionCheckpointRef,
  ): Promise<TranscriptEntryRef> {
    const resolved = await this.resolveTranscriptEntries(ref, [checkpoint]);
    return resolved[0]!.entryRef;
  }

  private async readTranscriptAssistantTexts(
    ref: AgentSessionRef,
    records: readonly RecordedCheckpoint[],
  ): Promise<readonly string[]> {
    for (const record of records) this.assertEntryBelongsToSession(ref, record.entryRef);
    return this.readFromSession(ref, (session) =>
      Promise.all(records.map((record) => this.readAssistantText(session, record.entryRef))));
  }

  private async readAssistantText(
    session: Session<JsonlSessionMetadata>,
    entryRef: TranscriptEntryRef,
  ): Promise<string> {
    const entry = await session.getEntry(entryRef.entryId, TODO_CONTEXT);
    if (entry?.type !== "message" || entry.message.role !== "assistant") {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session entry " + entryRef.entryId + " is not an assistant message.",
      );
    }
    return entry.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  private assertCheckpointIdentity(
    sessionRef: AgentSessionRef,
    checkpoint: AgentSessionCheckpointRef,
  ): void {
    if (checkpoint.sessionId !== sessionRef.sessionId) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session checkpoint belongs to a different session.",
      );
    }
    if (checkpoint.checkpointId.trim().length === 0) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session checkpointId must not be empty.",
      );
    }
  }

  async readToolCalls(input: {
    readonly sessionRef: AgentSessionRef;
    readonly assistantEntryRef: TranscriptEntryRef;
  }): Promise<readonly ProviderToolCall[]> {
    this.assertEntryBelongsToSession(input.sessionRef, input.assistantEntryRef);
    const entryRef = input.assistantEntryRef;
    return this.readFromSession(input.sessionRef, async (session) => {
      const entry = await session.getEntry(entryRef.entryId, TODO_CONTEXT);
    if (entry?.type !== "message" || entry.message.role !== "assistant") {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        `Agent session entry ${input.assistantEntryRef.entryId} is not an assistant message.`,
      );
    }
    return entry.message.content
      .filter((block) => block.type === "toolCall")
      .map((call) => ({
        providerCallId: call.id,
        toolName: call.name,
        input: normalizeToolFactValue(call.arguments),
        // The assistant entry id is the per-message roundId; same value
        // the live loop captured at the originating `message_end` so the
        // invocation id minted by Ordinary is stable across this read.
        roundId: input.assistantEntryRef.entryId,
      }));
    });
  }

  async readToolCallsByCheckpoint(input: {
    readonly sessionRef: AgentSessionRef;
    readonly checkpoint: AgentSessionCheckpointRef;
  }): Promise<readonly ProviderToolCall[]> {
    const entryRef = await this.resolveTranscriptEntry(input.sessionRef, input.checkpoint);
    return this.readToolCalls({ sessionRef: input.sessionRef, assistantEntryRef: entryRef });
  }

  async reconcileToolResultEntries(input: {
    readonly sessionRef: AgentSessionRef;
    readonly assistantCheckpoint: AgentSessionCheckpointRef;
    readonly recoveryCheckpoint?: AgentSessionCheckpointRef | null;
    readonly orderedResults: readonly ToolCallResult[];
  }): Promise<AgentSessionCheckpointRef> {
    const assistantEntryRef = await this.resolveTranscriptEntry(input.sessionRef, input.assistantCheckpoint);
    const recoveryEntryRef = input.recoveryCheckpoint === undefined || input.recoveryCheckpoint === null
      ? input.recoveryCheckpoint ?? null
      : await this.resolveTranscriptEntry(input.sessionRef, input.recoveryCheckpoint);
    if (input.orderedResults.some((result) => result.parentInvocationId !== undefined) ||
        new Set(input.orderedResults.map(toolInvocationId)).size !== input.orderedResults.length) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session reconciliation requires unique root tool results.",
      );
    }
    const lease = await this.acquire(input.sessionRef);
    try {
      let branch = await getMainBranchEntries(lease.session);
      let assistantIndex = branch.findIndex((entry) => entry.id === assistantEntryRef.entryId);
      if (assistantIndex < 0) {
        await this.validatePendingAssistantBranch(lease.session, assistantEntryRef, recoveryEntryRef);
        branch = await getMainBranchPathTo(lease.session, assistantEntryRef.entryId);
        assistantIndex = branch.length - 1;
      }
      const assistantEntry = branch[assistantIndex];
      if (assistantEntry?.type !== "message" || assistantEntry.message.role !== "assistant") {
        throw new AgentSessionRepositoryError(
          "agent_session_ref_invalid",
          "Agent session reconciliation target is not an assistant message.",
        );
      }
      const expectedCalls = assistantEntry.message.content
        .flatMap((block, sourceIndex) => block.type === "toolCall"
          ? [{ callId: block.id, toolName: block.name, sourceIndex }]
          : []);
      if (expectedCalls.length !== input.orderedResults.length || expectedCalls.some((call, index) => {
        const result = input.orderedResults[index];
        return result === undefined || result.providerCallId !== call.callId || result.toolName !== call.toolName;
      })) {
        throw new AgentSessionRepositoryError(
          "agent_session_ref_invalid",
          "Agent session tool results do not match the assistant tool-call order.",
        );
      }
      const suffix = branch.slice(assistantIndex + 1);
      if (suffix.some((entry) => entry.type !== "message" || entry.message.role !== "toolResult")) {
        throw new AgentSessionRepositoryError(
          "agent_session_ref_invalid",
          "Agent session active branch advanced beyond the pending tool-result group.",
        );
      }
      let matchingSuffixLength = suffix.length;
      for (let index = 0; index < suffix.length; index += 1) {
        const expected = input.orderedResults[index];
        const entry = suffix[index];
        if (expected === undefined) throw invalidToolRecovery("Session has extra tool-result entries.");
        if (entry?.type !== "message" || entry.message.role !== "toolResult" ||
            !toolResultMessageMatches(entry.message, expected)) {
          matchingSuffixLength = 0;
        }
      }
      const operation = await readRecoveryToolBatch(lease.session, assistantEntryRef.entryId);
      if (operation !== undefined &&
          (operation.state.batch.calls.length !== expectedCalls.length ||
           new Set(operation.state.batch.calls.map((call) => call.resultEntryId)).size !== expectedCalls.length)) {
        throw invalidToolRecovery("Pi tool batch does not match the assistant result group.");
      }
      const writes: Write[] = [];
      let leafId = matchingSuffixLength === 0
        ? assistantEntryRef.entryId
        : suffix[matchingSuffixLength - 1]!.id;
      // Build and validate the whole group before any branch or pending write.
      for (const [index, result] of input.orderedResults.entries()) {
        const call = operation?.state.batch.calls[index];
        if (operation !== undefined && call?.sourceIndex !== expectedCalls[index]?.sourceIndex) {
          throw invalidToolRecovery("Pi tool batch does not match the assistant source indices.");
        }
        if (index < matchingSuffixLength) {
          const entry = suffix[index];
          if (call !== undefined && (call.status !== "completed" || call.resultEntryId !== entry?.id ||
              entry?.type !== "message" || (entry.terminate === true) !== call.terminate)) {
            throw invalidToolRecovery("Pi completed result does not match the active transcript.");
          }
          continue;
        }
        const modelMessage = canonicalToolResultMessage(result);
        let message: ToolResultMessage = {
          role: "toolResult",
          toolCallId: result.providerCallId,
          toolName: result.toolName,
          content: [
            { type: "text", text: modelMessage.content },
            ...toolResultImageContentFromAttachments(modelMessage.attachments),
          ],
          isError: result.status !== "completed",
          timestamp: Date.now(),
        };
        const entryId = call?.resultEntryId ?? lease.session.idGenerator.next();
        let alreadyPlaced = false;
        if (call?.status === "completed") {
          const entry = await lease.session.getEntry(entryId, TODO_CONTEXT);
          if (entry?.type !== "message" || entry.message.role !== "toolResult" || entry.parentId !== leafId ||
              (entry.terminate === true) !== call.terminate) {
            throw invalidToolRecovery("Pi completed result is not on the proven assistant path.");
          }
          message = entry.message;
          alreadyPlaced = true;
        } else if (call?.status === "outcome_ready") {
          const pending = await lease.session.getValue(pendingEntry(entryId), TODO_CONTEXT);
          if (pending?.value.type !== "message" || pending.value.payload.role !== "toolResult") {
            throw invalidToolRecovery("Pi tool batch is missing its pending result.");
          }
          message = pending.value.payload;
          writes.push(deleteValue(pendingEntry(entryId)));
        }
        if (!toolResultMessageMatches(message, result)) {
          throw invalidToolRecovery("Pi tool result does not match the accepted call, text or status.");
        }
        if (!alreadyPlaced) {
          writes.push(insertEntry({ id: entryId, parentId: leafId, type: "message", message,
            ...((call?.status === "outcome_ready" && call.terminate) ? { terminate: true } : {}),
          }));
          if (message.usage !== undefined) {
            writes.push(insertUsage({ id: lease.session.idGenerator.next(), usage: message.usage,
              entryId, adjustment: false }));
          }
        }
        leafId = entryId;
      }
      if (operation !== undefined) {
        // Pi's placement boundary, expressed only through its public Session
        // writes. Keep the operation open for the existing startup abort path;
        // it must not place the recovered outcomes a second time.
        const allTerminate = operation.state.batch.calls.every((call) =>
          (call.status === "completed" || call.status === "outcome_ready") && call.terminate);
        writes.push(setValue(operationState(operation.id), {
          ...operationScopeOf(operation.state), at: "checkpoint", triggerEntryId: leafId,
          continuation: allTerminate
            ? { kind: "may_finish", includeFinalAssistant: false }
            : { kind: "need_assistant", overflowRecoveryUsed: false },
        }));
        const args = await lease.session.scanValues(
          operationToolArgsPrefix(operation.id, operation.state.batch.turnId), TODO_CONTEXT);
        writes.push(...args.map(({ address }) => deleteValue(address)));
      }
      if (writes.length > 0 || leafId !== await getMainLeafId(lease.session)) {
        writes.push(setValue(branchTip("main"), leafId));
        await lease.session.mutate((mutator) => mutator.commit(writes, TODO_CONTEXT), TODO_CONTEXT);
      }
      // A retried reconciliation of the same durable round must reuse the identity
      // it already minted instead of stacking a second checkpoint on one leaf.
      const existing = (await readEntireCheckpointIndex(lease.session))
        .find((item) => item.kind === "tool_results_committed" && item.entryId === leafId);
      if (existing !== undefined) {
        return { sessionId: input.sessionRef.sessionId, checkpointId: existing.checkpointId, kind: existing.kind };
      }
      return await lease.recordCheckpoint("tool_results_committed", {
        sessionId: input.sessionRef.sessionId,
        entryId: leafId,
      });
    } finally {
      await lease.release();
    }
  }

  /**
   * A terminal Ordinary outcome may have revoked the active leaf to its last
   * accepted prefix while Pi still retains the pending assistant branch. Only
   * accept that path when the caller proves the active leaf is the same
   * rollback target and Pi confirms the target is its ancestor. Validation
   * leaves the branch untouched until every tool result has been proven.
   */
  private async validatePendingAssistantBranch(
    session: Session<JsonlSessionMetadata>,
    assistantEntryRef: TranscriptEntryRef,
    recoveryEntryRef: TranscriptEntryRef | null | undefined,
  ): Promise<void> {
    const recovery = recoveryEntryRef;
    if (recovery === undefined || (recovery !== null && recovery.sessionId !== assistantEntryRef.sessionId)) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session assistant entry is not on the active branch.",
      );
    }
    const assistantEntry = await session.getEntry(assistantEntryRef.entryId, TODO_CONTEXT);
    if (assistantEntry?.type !== "message" || assistantEntry.message.role !== "assistant") {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session pending checkpoint does not name a durable assistant entry.",
      );
    }
    const activeLeafId = await getMainLeafId(session);
    if ((recovery?.entryId ?? null) !== activeLeafId) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session recovery leaf does not match the active branch.",
      );
    }
    const assistantPath = await getMainBranchPathTo(session, assistantEntryRef.entryId);
    if (assistantPath.at(-1)?.id !== assistantEntryRef.entryId) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session pending assistant entry does not exist.",
      );
    }
    const recoveryIndex = recovery === null
      ? -1
      : assistantPath.findIndex((entry) => entry.id === recovery.entryId);
    if (recovery !== null && recoveryIndex < 0) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session recovery leaf is not an ancestor of the pending assistant entry.",
      );
    }
  }

  async delete(ref: AgentSessionRef): Promise<void> {
    this.validateRef(ref);
    await this.runInSessionAccess(ref.sessionId, async () => {
      if (this.writerSessions.has(ref.sessionId)) {
        throw new AgentSessionRepositoryError(
          "agent_session_writer_active",
          `Agent session ${ref.sessionId} cannot be deleted while its writer is active.`,
        );
      }
      try {
        await this.writeFence(ref.sessionId).runWhenIdle(async () => {
          let persistedMetadata: JsonlSessionMetadata;
          try {
            persistedMetadata = await this.readSessionMetadata(ref);
          } catch (error) {
            if (error instanceof AgentSessionRepositoryError && error.code === "agent_session_not_found") return;
            throw error;
          }
          await this.closeIdleSession(ref.sessionId);
          const session = await this.openValidatedSession(ref, persistedMetadata);
          const metadata = session.metadata;
          await session.close(TODO_CONTEXT);
          await this.jsonlRepository.delete(metadata, TODO_CONTEXT);
        });
      } catch (error) {
        if (error instanceof SessionGenerationError && error.code === "generation_active") {
          throw new AgentSessionRepositoryError(
            "agent_session_writer_active",
            `Agent session ${ref.sessionId} cannot be deleted while its writer is active.`,
            { cause: error },
          );
        }
        if (error instanceof SessionGenerationError && error.code === "generation_revoke_failed") {
          throw new AgentSessionRepositoryError(
            "agent_session_revoke_failed",
            `Agent session ${ref.sessionId} cannot be deleted because its durable leaf was not restored.`,
            { cause: error },
          );
        }
        throw error;
      }
      this.writeFences.delete(ref.sessionId);
    });
  }

  private async openValidatedSession(
    ref: AgentSessionRef,
    metadata: JsonlSessionMetadata,
  ): Promise<Session<JsonlSessionMetadata>> {
    const headerLines = await this.fileSystem.readTextLines(metadata.path, { maxLines: 1 }, TODO_CONTEXT);
    if (!headerLines.ok) throw headerLines.error;
    const legacyHeader = parseLegacyV3SessionHeader(headerLines.value[0]);
    if (legacyHeader !== undefined) {
      throw new AgentSessionRepositoryError(
        "agent_session_legacy_requires_reset",
        `Agent session ${legacyHeader.id} uses legacy v3 JSONL; back up the Product Home, then explicitly reset the entire Product Home before creating new sessions.`,
      );
    }
    this.assertMetadataMatches(ref, metadata);
    const session = await this.jsonlRepository.open(metadata, TODO_CONTEXT);
    try {
      this.assertMetadataMatches(ref, session.metadata);
      return session;
    } catch (error) {
      await session.close(TODO_CONTEXT).catch(() => undefined);
      throw error;
    }
  }

  private sessionAccessGate(sessionId: string): SessionAccessGate {
    let gate = this.sessionAccessGates.get(sessionId);
    if (gate === undefined) {
      gate = new SessionAccessGate();
      this.sessionAccessGates.set(sessionId, gate);
    }
    return gate;
  }

  private runInSessionAccess<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.sessionAccessGate(sessionId).run(operation);
  }

  private writeFence(sessionId: string): SessionWriteFence {
    let fence = this.writeFences.get(sessionId);
    if (fence === undefined) {
      fence = new SessionWriteFence();
      this.writeFences.set(sessionId, fence);
    }
    return fence;
  }

  /**
   * Opens a scoped read handle for a session no writer owns. A writer that
   * appears during this method cannot race the check because callers hold the
   * session access gate. An open failure is therefore either a provider error
   * or a real missing session already proven by the listing check; it must not
   * be guessed from an error message.
   */
  private async sessionFileRevision(ref: AgentSessionRef): Promise<string> {
    const info = await stat(this.requirePathInsideRoot(path.join(this.sessionsRoot, ref.storageKey)), { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  }

  private async openForAccess(ref: AgentSessionRef): Promise<Session<JsonlSessionMetadata>> {
    const idle = this.idleSessions.get(ref.sessionId);
    if (idle !== undefined) {
      this.assertMetadataMatches(ref, idle.session.metadata);
      const revision = await this.sessionFileRevision(ref).catch(async (error) => {
        await this.closeIdleSession(ref.sessionId);
        throw error;
      });
      if (revision === idle.revision) {
        clearTimeout(idle.timer);
        this.idleSessions.delete(ref.sessionId);
        return idle.session;
      }
      await this.closeIdleSession(ref.sessionId);
    }
    const metadata = await this.readSessionMetadata(ref);
    return this.openValidatedSession(ref, metadata);
  }

  private async releaseToIdle(ref: AgentSessionRef, session: Session<JsonlSessionMetadata>): Promise<void> {
    if (this.released || this.idleSessionCacheSize === 0) {
      await session.close(TODO_CONTEXT);
      return;
    }
    let revision: string;
    try { revision = await this.sessionFileRevision(ref); }
    catch (error) { await session.close(TODO_CONTEXT); throw error; }
    const timer = setTimeout(() => {
      void this.runInSessionAccess(ref.sessionId, async () => {
        if (this.idleSessions.get(ref.sessionId)?.session === session) await this.closeIdleSession(ref.sessionId);
      }).catch((error) => console.error("Failed to release an idle Agent Session", error));
    }, 60_000);
    timer.unref();
    this.idleSessions.set(ref.sessionId, { session, revision, timer });
    while (this.idleSessions.size > this.idleSessionCacheSize) {
      await this.closeIdleSession(this.idleSessions.keys().next().value!);
    }
  }

  private async closeIdleSession(sessionId: string): Promise<void> {
    const idle = this.idleSessions.get(sessionId);
    if (idle === undefined) return;
    // Remove before awaiting close so another session cannot evict this handle twice.
    this.idleSessions.delete(sessionId);
    clearTimeout(idle.timer);
    try { await idle.session.close(TODO_CONTEXT); }
    catch (error) { this.idleSessions.set(sessionId, idle); throw error; }
  }

  async release(): Promise<void> {
    this.released = true;
    for (const sessionId of [...this.idleSessions.keys()]) {
      await this.runInSessionAccess(sessionId, () => this.closeIdleSession(sessionId));
    }
  }

  private async openForRead(ref: AgentSessionRef): Promise<Session<JsonlSessionMetadata>> {
    this.validateRef(ref);
    if (this.writerSessions.has(ref.sessionId)) {
      throw new AgentSessionRepositoryError("agent_session_writer_active", `Agent session ${ref.sessionId} has an active writer.`);
    }
    return this.openForAccess(ref);
  }

  private assertEntryBelongsToSession(ref: AgentSessionRef, entryRef: TranscriptEntryRef): void {
    if (entryRef.sessionId !== ref.sessionId) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session entry ref belongs to a different session.",
      );
    }
  }

  private refFromMetadata(metadata: JsonlSessionMetadata): AgentSessionRef {
    const resolvedPath = this.requirePathInsideRoot(metadata.path);
    return {
      sessionId: metadata.id,
      storageKey: path.relative(this.sessionsRoot, resolvedPath).split(path.sep).join("/"),
      sessionCwd: metadata.cwd,
      createdAt: new Date(metadata.createdAt).toISOString(),
    };
  }

  /**
   * Pi 0.87 removed the typed not-found error, so existence is proven through
   * the repository listing instead of matching provider error text.
   */
  private async readSessionMetadata(ref: AgentSessionRef): Promise<JsonlSessionMetadata> {
    const metadata = (await this.jsonlRepository.list({ cwd: ref.sessionCwd }, TODO_CONTEXT))
      .find((metadata) => metadata.id === ref.sessionId);
    if (metadata === undefined) {
      throw new AgentSessionRepositoryError(
        "agent_session_not_found",
        `Agent session ${ref.sessionId} was not found.`,
      );
    }
    return metadata;
  }

  private validateRef(ref: AgentSessionRef): void {
    requireNonEmpty(ref.sessionId, "sessionId");
    requireNonEmpty(ref.storageKey, "storageKey");
    requireNonEmpty(ref.sessionCwd, "sessionCwd");
    requireNonEmpty(ref.createdAt, "createdAt");
    this.pathFromStorageKey(ref.storageKey);
  }

  private assertMetadataMatches(ref: AgentSessionRef, metadata: JsonlSessionMetadata): void {
    const actual = this.refFromMetadata(metadata);
    if (actual.sessionId !== ref.sessionId
      || actual.storageKey !== normalizeStorageKey(ref.storageKey)
      || actual.sessionCwd !== ref.sessionCwd
      || actual.createdAt !== ref.createdAt) {
      throw new AgentSessionRepositoryError(
        "agent_session_metadata_mismatch",
        `Agent session ${ref.sessionId} metadata does not match its persisted reference.`,
      );
    }
  }

  private pathFromStorageKey(storageKey: string): string {
    if (path.isAbsolute(storageKey)) {
      throw new AgentSessionRepositoryError("agent_session_ref_invalid", "Agent session storageKey must be relative.");
    }
    return this.requirePathInsideRoot(path.resolve(this.sessionsRoot, storageKey));
  }

  private requirePathInsideRoot(candidate: string): string {
    const resolved = path.resolve(candidate);
    const relative = path.relative(this.sessionsRoot, resolved);
    if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session storage path must stay inside the configured sessions root.",
      );
    }
    return resolved;
  }
}

/** Resolve reserved result IDs from the current main operation, never call-ID history. */
async function readRecoveryToolBatch(
  session: Session,
  assistantEntryId: string,
): Promise<{ readonly id: string; readonly state: ToolsOperation } | undefined> {
  const lane = await session.getValue(laneState("main"), TODO_CONTEXT);
  const id = lane?.value.currentOperationId;
  if (id === undefined || id === null) return undefined;
  const meta = await session.getValue(operationMeta(id), TODO_CONTEXT);
  const state = await session.getValue(operationState(id), TODO_CONTEXT);
  if (meta?.value.operationId !== id || meta.value.lane !== "main" ||
      meta.value.intent.kind !== "run" || state === undefined) {
    throw invalidToolRecovery("Pi main operation has inconsistent metadata.");
  }
  if (state.value.at !== "tools" || state.value.batch.assistantEntryId !== assistantEntryId) return undefined;
  return { id, state: state.value };
}

function invalidToolRecovery(message: string): AgentSessionRepositoryError {
  return new AgentSessionRepositoryError("agent_session_ref_invalid", message);
}

function toolResultMessageMatches(message: ToolResultMessage, result: ToolCallResult): boolean {
  const canonical = canonicalToolResultMessage(result);
  const images = message.content.filter((block): block is ImageContent => block.type === "image");
  const inlineImages = toolResultImageContentFromAttachments(canonical.attachments);
  const refs = result.modelAttachmentRefs ?? [];
  // Inline payloads and durable manifests must agree as well. A count check
  // alone cannot prove that the recovered bytes are the accepted images.
  if ((inlineImages.length > 0 && JSON.stringify(images) !== JSON.stringify(inlineImages)) ||
      (refs.length > 0 && !imageRefsMatch(images, refs)) ||
      (refs.length === 0 && inlineImages.length === 0 && images.length > 0)) {
    throw new AgentSessionRepositoryError("agent_session_attachment_mismatch",
      `Agent session tool result ${result.providerCallId} image manifest does not match its Session payload.`);
  }
  const texts = message.content.filter((block) => block.type === "text");
  return message.toolCallId === result.providerCallId && message.toolName === result.toolName &&
    message.isError === (result.status !== "completed") && texts.length === 1 &&
    texts[0]?.text === canonical.content;
}

function toolResultImageContentFromAttachments(
  attachments: ReturnType<typeof canonicalToolResultMessage>["attachments"],
): ImageContent[] {
  return (attachments ?? []).flatMap((attachment) => {
    if (attachment.kind !== "image" || attachment.source.kind !== "data") return [];
    return [{ type: "image" as const, mimeType: attachment.source.mimeType, data: attachment.source.data }];
  });
}

function imageRefsMatch(
  actualImages: readonly ImageContent[],
  expectedRefs: readonly ModelInputAttachmentRef[],
): boolean {
  if (actualImages.length !== expectedRefs.length) return false;
  return actualImages.every((image, index) => {
    const expected = expectedRefs[index];
    if (expected === undefined) return false;
    const actualBytes = Buffer.from(image.data, "base64");
    return image.mimeType === expected.mimeType &&
      (expected.byteLength === undefined || expected.byteLength === actualBytes.byteLength) &&
      createHash("sha256").update(actualBytes).digest("hex") === expected.sha256;
  });
}

function normalizeStorageKey(storageKey: string): string {
  return storageKey.split("/").join(path.sep).split(path.sep).join("/");
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new AgentSessionRepositoryError("agent_session_ref_invalid", `Agent session ${name} must not be empty.`);
  }
}

/** Durable checkpoint mapping lives in the Session value store under our namespace. */
const CHECKPOINT_NAMESPACE = "synech.checkpoint";
const CHECKPOINT_INDEX_KEY = "recorded";

type StoredCheckpoint = {
  readonly checkpointId: string;
  readonly kind: AgentSessionCheckpointKind;
  readonly entryId: string;
};

const storedCheckpointSchema = z.object({
  checkpointId: z.string().min(1),
  kind: z.enum([
    "run_started", "input_committed", "assistant_tool_calls_committed",
    "tool_results_committed", "compaction_committed", "assistant_response_committed",
  ]),
  entryId: z.string().min(1),
});

type RecordedCheckpoint = {
  readonly checkpoint: AgentSessionCheckpointRef;
  readonly entryRef: TranscriptEntryRef;
};

/**
 * The Session's own checkpoint index. Keeping the mapping in the same durable
 * store as the transcript, rather than in a sidecar, keeps mapping and
 * transcript in one place and lets a new repository instance resolve the same
 * identities.
 */
function checkpointIndexAddress(): ReturnType<typeof list<StoredCheckpoint>> {
  return list<StoredCheckpoint>(CHECKPOINT_NAMESPACE, CHECKPOINT_INDEX_KEY);
}

/**
 * Reads the whole checkpoint index. Pi caps a single readList at 10_000
 * elements and defaults to the OLDEST 1_000, so an index that only grows would
 * silently stop resolving its newest records without paging by seq cursor.
 */
async function readEntireCheckpointIndex(
  reader: Pick<Session, "readList">,
): Promise<readonly StoredCheckpoint[]> {
  const records: StoredCheckpoint[] = [];
  const checkpointIds = new Set<string>();
  let cursor: { seq: number } | undefined;
  for (;;) {
    const page = await reader.readList(
      checkpointIndexAddress(),
      { limit: 10_000, ...(cursor === undefined ? {} : { cursor }) },
      TODO_CONTEXT,
    );
    if (page.length === 0) break;
    for (const element of page) {
      const parsed = storedCheckpointSchema.safeParse(element.value);
      if (!parsed.success) {
        throw checkpointIndexConflict("Agent session checkpoint index contains an invalid record.", parsed.error);
      }
      if (checkpointIds.has(parsed.data.checkpointId)) {
        throw checkpointIndexConflict(`Checkpoint ${parsed.data.checkpointId} is recorded more than once.`);
      }
      checkpointIds.add(parsed.data.checkpointId);
      records.push(parsed.data);
    }
    if (page.length < 10_000) break;
    cursor = { seq: page[page.length - 1]!.seq };
  }
  return records;
}

function checkpointIndexConflict(message: string, cause?: unknown): AgentSessionRepositoryError {
  return new AgentSessionRepositoryError("agent_session_checkpoint_conflict", message, { cause });
}

/** Transcript position recorded for one checkpoint, or undefined when unmapped. */
function recordedCheckpointEntryId(
  index: readonly StoredCheckpoint[],
  checkpoint: AgentSessionCheckpointRef,
): string | undefined {
  const stored = index.find((item) => item.checkpointId === checkpoint.checkpointId);
  if (stored === undefined) return undefined;
  if (stored.kind !== checkpoint.kind) {
    throw new AgentSessionRepositoryError(
      "agent_session_checkpoint_conflict",
      "Agent session checkpoint " + checkpoint.checkpointId + " is recorded as " + stored.kind +
        ", not " + checkpoint.kind + ".",
    );
  }
  return stored.entryId;
}

/** Serializes repository-owned open handles for one Pi session. */
class SessionAccessGate {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function resolveRecordedCheckpoints(
  ref: AgentSessionRef,
  checkpoints: readonly AgentSessionCheckpointRef[],
  index: readonly StoredCheckpoint[],
): readonly RecordedCheckpoint[] {
  return checkpoints.map((checkpoint) => {
    const entryId = recordedCheckpointEntryId(index, checkpoint);
    if (entryId === undefined) throw new AgentSessionRepositoryError(
      "agent_session_checkpoint_unknown", `Agent session ${ref.sessionId} has no recorded checkpoint ${checkpoint.checkpointId}.`,
    );
    return { checkpoint, entryRef: { sessionId: ref.sessionId, entryId } };
  });
}
