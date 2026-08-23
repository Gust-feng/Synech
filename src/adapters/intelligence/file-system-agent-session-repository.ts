import path from "node:path";
import { createHash } from "node:crypto";
import {
  JsonlSessionRepo,
  Session,
  SessionError,
  type ExecutionEnv,
  type JsonlSessionMetadata,
} from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  AgentSessionEntryRef,
  AgentSessionAssistantEntry,
  AgentSessionRef,
  AgentSessionRepository,
} from "../../app/model-runtime/agent-session.js";
import type { ModelInputAttachmentRef } from "../../domain/intelligence/index.js";
import { canonicalToolResultMessage } from "../../app/model-runtime/tool-result-message.js";
import {
  normalizeToolFactValue,
  toolCallFactId,
  type ToolCallResult,
} from "../../domain/tools/index.js";
import {
  SessionGenerationError,
  SessionWriteFence,
  type SessionStorageGenerationLease,
} from "./session-write-fence.js";

export type AgentSessionRepositoryErrorCode =
  | "agent_session_duplicate"
  | "agent_session_ref_invalid"
  | "agent_session_metadata_mismatch"
  | "agent_session_attachment_mismatch"
  | "agent_session_not_found"
  | "agent_session_revoke_failed"
  | "agent_session_writer_active";

export class AgentSessionRepositoryError extends Error {
  readonly code: AgentSessionRepositoryErrorCode;

  constructor(code: AgentSessionRepositoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSessionRepositoryError";
    this.code = code;
  }
}

export type AgentSessionLease = {
  readonly ref: AgentSessionRef;
  readonly session: Session<JsonlSessionMetadata>;
  revokeTo(target: AgentSessionEntryRef | null): Promise<void>;
  release(): Promise<void>;
};

export type FileSystemAgentSessionRepositoryConfig = {
  readonly fileSystem: ExecutionEnv;
  readonly sessionsRoot: string;
};

/**
 * Protects JSONL transcript location and single-writer ownership. Session tree,
 * navigation, compaction, and append semantics remain owned by the dependency.
 */
export class FileSystemAgentSessionRepository implements AgentSessionRepository {
  private readonly sessionsRoot: string;
  private readonly jsonlRepository: JsonlSessionRepo;
  private readonly writeFences = new Map<string, SessionWriteFence>();

  constructor(config: FileSystemAgentSessionRepositoryConfig) {
    this.sessionsRoot = path.resolve(config.sessionsRoot);
    this.jsonlRepository = new JsonlSessionRepo({ fs: config.fileSystem, sessionsRoot: this.sessionsRoot });
  }

  async create(input: { readonly sessionId: string; readonly sessionCwd: string }): Promise<AgentSessionRef> {
    requireNonEmpty(input.sessionId, "sessionId");
    requireNonEmpty(input.sessionCwd, "sessionCwd");
    const duplicate = (await this.jsonlRepository.list()).some((metadata) => metadata.id === input.sessionId);
    if (duplicate) {
      throw new AgentSessionRepositoryError(
        "agent_session_duplicate",
        `Agent session ${input.sessionId} already exists.`,
      );
    }
    const session = await this.jsonlRepository.create({ id: input.sessionId, cwd: input.sessionCwd });
    return this.refFromMetadata(await session.getMetadata());
  }

  async acquire(ref: AgentSessionRef): Promise<AgentSessionLease> {
    this.validateRef(ref);
    const metadata = this.metadataFromRef(ref);
    const fence = this.writeFence(ref.sessionId);
    let generation: SessionStorageGenerationLease<JsonlSessionMetadata>;
    try {
      generation = await fence.acquire(async () => {
        const opened = await this.jsonlRepository.open(metadata);
        this.assertMetadataMatches(ref, await opened.getMetadata());
        return opened.getStorage();
      });
    } catch (error) {
      if (error instanceof SessionError && error.code === "not_found") {
        throw new AgentSessionRepositoryError(
          "agent_session_not_found",
          `Agent session ${ref.sessionId} was not found.`,
          { cause: error },
        );
      }
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
    const session = new Session(generation.storage);
    return {
      ref,
      session,
      revokeTo: async (target) => {
        if (target !== null && target.sessionId !== ref.sessionId) {
          throw new AgentSessionRepositoryError(
            "agent_session_ref_invalid",
            "Agent session entry ref belongs to a different session.",
          );
        }
        await generation.revokeTo(target?.entryId ?? null);
      },
      release: generation.release,
    };
  }

  async getActiveLeaf(ref: AgentSessionRef): Promise<AgentSessionEntryRef | null> {
    const session = await this.openForRead(ref);
    const entryId = await session.getLeafId();
    return entryId === null ? null : { sessionId: ref.sessionId, entryId };
  }

  async moveActiveLeaf(
    ref: AgentSessionRef,
    target: AgentSessionEntryRef | null,
  ): Promise<AgentSessionEntryRef | null> {
    if (target !== null && target.sessionId !== ref.sessionId) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session entry ref belongs to a different session.",
      );
    }
    const lease = await this.acquire(ref);
    try {
      await lease.session.moveTo(target?.entryId ?? null);
      const entryId = await lease.session.getLeafId();
      return entryId === null ? null : { sessionId: ref.sessionId, entryId };
    } finally {
      await lease.release();
    }
  }

  async getActiveBranchEntryRefs(ref: AgentSessionRef): Promise<readonly AgentSessionEntryRef[]> {
    const session = await this.openForRead(ref);
    return (await session.getBranch()).map((entry) => ({
      sessionId: ref.sessionId,
      entryId: entry.id,
    }));
  }

  async readAssistantEntries(input: {
    readonly sessionRef: AgentSessionRef;
    readonly entryRefs: readonly AgentSessionEntryRef[];
  }): Promise<readonly AgentSessionAssistantEntry[]> {
    for (const entryRef of input.entryRefs) this.assertEntryBelongsToSession(input.sessionRef, entryRef);
    const session = await this.openForRead(input.sessionRef);
    return Promise.all(input.entryRefs.map(async (entryRef): Promise<AgentSessionAssistantEntry> => {
      const entry = await session.getEntry(entryRef.entryId);
      if (entry?.type !== "message" || entry.message.role !== "assistant") {
        throw new AgentSessionRepositoryError(
          "agent_session_ref_invalid",
          `Agent session entry ${entryRef.entryId} is not an assistant message.`,
        );
      }
      const text = entry.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return {
        entryRef: { sessionId: input.sessionRef.sessionId, entryId: entryRef.entryId },
        text,
      };
    }));
  }

  async readToolCalls(input: {
    readonly sessionRef: AgentSessionRef;
    readonly assistantEntryRef: AgentSessionEntryRef;
  }) {
    this.assertEntryBelongsToSession(input.sessionRef, input.assistantEntryRef);
    const session = await this.openForRead(input.sessionRef);
    const entry = await session.getEntry(input.assistantEntryRef.entryId);
    if (entry?.type !== "message" || entry.message.role !== "assistant") {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        `Agent session entry ${input.assistantEntryRef.entryId} is not an assistant message.`,
      );
    }
    return entry.message.content
      .filter((block) => block.type === "toolCall")
      .map((call) => ({
        callId: call.id,
        toolName: call.name,
        input: normalizeToolFactValue(call.arguments),
      }));
  }

  async reconcileToolResultEntries(input: {
    readonly sessionRef: AgentSessionRef;
    readonly assistantEntryRef: AgentSessionEntryRef;
    readonly recoveryLeafRef?: AgentSessionEntryRef | null;
    readonly orderedResults: readonly ToolCallResult[];
  }): Promise<AgentSessionEntryRef> {
    this.assertEntryBelongsToSession(input.sessionRef, input.assistantEntryRef);
    if (input.orderedResults.some((result) => result.parentToolCallFactId !== undefined) ||
        new Set(input.orderedResults.map(toolCallFactId)).size !== input.orderedResults.length) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session reconciliation requires unique root tool results.",
      );
    }
    const lease = await this.acquire(input.sessionRef);
    try {
      let branch = await lease.session.getBranch();
      let assistantIndex = branch.findIndex((entry) => entry.id === input.assistantEntryRef.entryId);
      if (assistantIndex < 0) {
        await this.restorePendingAssistantBranch(lease.session, input);
        branch = await lease.session.getBranch();
        assistantIndex = branch.findIndex((entry) => entry.id === input.assistantEntryRef.entryId);
        if (assistantIndex < 0) {
          throw new AgentSessionRepositoryError(
            "agent_session_ref_invalid",
            "Agent session assistant entry is not on the active branch.",
          );
        }
      }
      const assistantEntry = branch[assistantIndex];
      if (assistantEntry?.type !== "message" || assistantEntry.message.role !== "assistant") {
        throw new AgentSessionRepositoryError(
          "agent_session_ref_invalid",
          "Agent session reconciliation target is not an assistant message.",
        );
      }
      const expectedCalls = assistantEntry.message.content
        .filter((block) => block.type === "toolCall")
        .map((call) => ({ callId: call.id, toolName: call.name }));
      if (expectedCalls.length !== input.orderedResults.length || expectedCalls.some((call, index) => {
        const result = input.orderedResults[index];
        return result === undefined || result.callId !== call.callId || result.toolName !== call.toolName;
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
        const entry = suffix[index];
        const expected = input.orderedResults[index];
        const expectedMessage = expected === undefined ? undefined : canonicalToolResultMessage(expected);
        const content = entry?.type === "message" && entry.message.role === "toolResult"
          ? entry.message.content
          : [];
        const textBlocks = content.filter((block) => block.type === "text");
        const text = textBlocks.length === 1 ? textBlocks[0]?.text : undefined;
        const actualImages = content.filter((block): block is ImageContent => block.type === "image");
        const expectedImages = expectedMessage === undefined
          ? []
          : toolResultImageContentFromAttachments(expectedMessage.attachments);
        const expectedImageRefs = expected?.modelAttachmentRefs ?? [];
        if (expectedImages.length === 0 && expectedImageRefs.length === 0 && actualImages.length > 0) {
          throw new AgentSessionRepositoryError(
            "agent_session_attachment_mismatch",
            `Agent session tool result ${expected.callId} contains a durable image that the run fact cannot prove.`,
          );
        }
        const imagesMatch = expectedImages.length > 0
          ? JSON.stringify(actualImages) === JSON.stringify(expectedImages)
          : expectedImageRefs.length === 0
            ? actualImages.length === 0
            : imageRefsMatch(actualImages, expectedImageRefs);
        if (!imagesMatch && expectedImageRefs.length > 0) {
          throw new AgentSessionRepositoryError(
            "agent_session_attachment_mismatch",
            `Agent session tool result ${expected.callId} image manifest does not match the durable Session entry.`,
          );
        }
        if (entry?.type !== "message" || entry.message.role !== "toolResult" || expected === undefined ||
            entry.message.toolCallId !== expected.callId || entry.message.toolName !== expected.toolName ||
            entry.message.isError !== (expected.status !== "completed") || text !== expectedMessage?.content ||
            !imagesMatch) {
          await lease.session.moveTo(input.assistantEntryRef.entryId);
          matchingSuffixLength = 0;
          break;
        }
      }
      for (const result of input.orderedResults.slice(matchingSuffixLength)) {
        const expectedRefs = result.modelAttachmentRefs ?? [];
        if (expectedRefs.length === 0) continue;
        const availableImages = toolResultImageContentFromAttachments(canonicalToolResultMessage(result).attachments);
        if (availableImages.length !== expectedRefs.length) {
          throw new AgentSessionRepositoryError(
            "agent_session_attachment_mismatch",
            `Agent session tool result ${result.callId} has image references but no recoverable image payload.`,
          );
        }
      }
      for (const result of input.orderedResults.slice(matchingSuffixLength)) {
        const modelMessage = canonicalToolResultMessage(result);
        await lease.session.appendMessage({
          role: "toolResult",
          toolCallId: result.callId,
          toolName: result.toolName,
          content: [
            { type: "text", text: modelMessage.content },
            ...toolResultImageContentFromAttachments(modelMessage.attachments),
          ],
          isError: result.status !== "completed",
          timestamp: Date.now(),
        });
      }
      const leafId = await lease.session.getLeafId();
      if (leafId === null) {
        throw new AgentSessionRepositoryError(
          "agent_session_ref_invalid",
          "Agent session reconciliation did not produce a durable leaf.",
        );
      }
      return { sessionId: input.sessionRef.sessionId, entryId: leafId };
    } finally {
      await lease.release();
    }
  }

  /**
   * A terminal Ordinary outcome may have revoked the active leaf to its last
   * accepted prefix while Pi still retains the pending assistant branch. Only
   * restore that branch when the caller proves the active leaf is the same
   * rollback target and Pi confirms the target is its ancestor.
   */
  private async restorePendingAssistantBranch(
    session: Session<JsonlSessionMetadata>,
    input: {
      readonly sessionRef: AgentSessionRef;
      readonly assistantEntryRef: AgentSessionEntryRef;
      readonly recoveryLeafRef?: AgentSessionEntryRef | null;
    },
  ): Promise<void> {
    const recovery = input.recoveryLeafRef;
    if (recovery === undefined || (recovery !== null && recovery.sessionId !== input.sessionRef.sessionId)) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session assistant entry is not on the active branch.",
      );
    }
    const activeLeafId = await session.getLeafId();
    if ((recovery?.entryId ?? null) !== activeLeafId) {
      throw new AgentSessionRepositoryError(
        "agent_session_ref_invalid",
        "Agent session recovery leaf does not match the active branch.",
      );
    }
    const assistantPath = await session.getBranch(input.assistantEntryRef.entryId);
    if (assistantPath.at(-1)?.id !== input.assistantEntryRef.entryId) {
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
    await session.moveTo(input.assistantEntryRef.entryId);
  }

  async delete(ref: AgentSessionRef): Promise<void> {
    this.validateRef(ref);
    try {
      await this.writeFence(ref.sessionId).runWhenIdle(async () => {
        let session: Session<JsonlSessionMetadata>;
        try {
          session = await this.jsonlRepository.open(this.metadataFromRef(ref));
        } catch (error) {
          if (error instanceof SessionError && error.code === "not_found") return;
          throw error;
        }
        const metadata = await session.getMetadata();
        this.assertMetadataMatches(ref, metadata);
        await this.jsonlRepository.delete(metadata);
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
  }

  private writeFence(sessionId: string): SessionWriteFence {
    let fence = this.writeFences.get(sessionId);
    if (fence === undefined) {
      fence = new SessionWriteFence();
      this.writeFences.set(sessionId, fence);
    }
    return fence;
  }

  private async openForRead(ref: AgentSessionRef): Promise<Session<JsonlSessionMetadata>> {
    this.validateRef(ref);
    try {
      const session = await this.jsonlRepository.open(this.metadataFromRef(ref));
      this.assertMetadataMatches(ref, await session.getMetadata());
      return session;
    } catch (error) {
      if (error instanceof SessionError && error.code === "not_found") {
        throw new AgentSessionRepositoryError(
          "agent_session_not_found",
          `Agent session ${ref.sessionId} was not found.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private assertEntryBelongsToSession(ref: AgentSessionRef, entryRef: AgentSessionEntryRef): void {
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
      createdAt: metadata.createdAt,
    };
  }

  private metadataFromRef(ref: AgentSessionRef): JsonlSessionMetadata {
    return {
      id: ref.sessionId,
      cwd: ref.sessionCwd,
      createdAt: ref.createdAt,
      path: this.pathFromStorageKey(ref.storageKey),
    };
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