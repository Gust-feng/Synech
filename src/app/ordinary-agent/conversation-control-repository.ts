import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { isNodeError } from "../../kernel/values/index.js";
import {
  ORDINARY_CONVERSATION_SCHEMA_VERSION,
  OrdinaryFeatureError,
  type OrdinaryConversationControlDocument,
  type OrdinaryConversationControlRepository,
  type OrdinaryConversationControlState,
  type OrdinaryConversationControlSummary,
} from "./contracts.js";

export class OrdinaryConversationSnapshotIncompatibleError extends Error {
  readonly code = "ordinary_conversation_snapshot_incompatible" as const;
  constructor(readonly conversationId: string, reason: string) {
    super(`Ordinary conversation snapshot ${conversationId} is incompatible: ${reason}`);
    this.name = "OrdinaryConversationSnapshotIncompatibleError";
  }
}

const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("space"), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("workspace"), id: z.string().min(1) }).strict(),
]);

const stateSchema: z.ZodType<OrdinaryConversationControlState> = z.object({
  conversationId: z.string().min(1),
  createdAt: z.string().min(1),
  sessionRef: z.object({
    sessionId: z.string().min(1),
    storageKey: z.string().min(1),
    sessionCwd: z.string().min(1),
    createdAt: z.string().min(1),
  }).strict(),
  owner: ownerSchema,
  titleOverride: z.string().min(1).max(80).optional(),
  titleEditedAt: z.string().min(1).optional(),
  autoTitle: z.string().min(1).max(80).optional(),
  autoTitleAt: z.string().min(1).optional(),
  pinnedAt: z.string().min(1).optional(),
  deletedAt: z.string().min(1).optional(),
}).strict().superRefine((state, context) => {
  if ((state.titleOverride === undefined) !== (state.titleEditedAt === undefined)) {
    context.addIssue({ code: "custom", message: "title override and edit time must appear together" });
  }
  if ((state.autoTitle === undefined) !== (state.autoTitleAt === undefined)) {
    context.addIssue({ code: "custom", message: "auto title and generated time must appear together" });
  }
});
const documentSchema: z.ZodType<OrdinaryConversationControlDocument> = z.object({
  schemaVersion: z.literal(ORDINARY_CONVERSATION_SCHEMA_VERSION),
  revision: z.number().int().positive(),
  savedAt: z.string().min(1),
  state: stateSchema,
}).strict();

export function createFileSystemOrdinaryConversationControlRepository(rootDir: string): OrdinaryConversationControlRepository {
  let writeQueue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    save(state, expectedRevision, savedAt) {
      return enqueue(async () => {
        const current = await readDocument(rootDir, state.conversationId);
        const actualRevision = current?.revision ?? 0;
        if (actualRevision !== expectedRevision) {
          const cause = new Error(
            `Ordinary conversation ${state.conversationId} revision conflict: expected ${expectedRevision}, received ${actualRevision}`,
          );
          throw new OrdinaryFeatureError("ordinary_revision_conflict", cause.message, { cause });
        }
        const document: OrdinaryConversationControlDocument = {
          schemaVersion: ORDINARY_CONVERSATION_SCHEMA_VERSION,
          revision: actualRevision + 1,
          savedAt,
          state: structuredClone(state),
        };
        const result = documentSchema.safeParse(document);
        if (!result.success) throw new OrdinaryConversationSnapshotIncompatibleError(state.conversationId, z.prettifyError(result.error));
        await writeJsonAtomically(documentPath(rootDir, state.conversationId), document);
        return document;
      });
    },
    delete(conversationId, expectedRevision) {
      return enqueue(async () => {
        const current = await readDocument(rootDir, conversationId);
        if (current === undefined) return;
        if (current.revision !== expectedRevision) {
          const cause = new Error(
            `Ordinary conversation ${conversationId} revision conflict: expected ${expectedRevision}, received ${current.revision}`,
          );
          throw new OrdinaryFeatureError("ordinary_revision_conflict", cause.message, { cause });
        }
        await fs.rm(path.dirname(documentPath(rootDir, conversationId)), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      });
    },
    get(conversationId) { return readDocument(rootDir, conversationId); },
    async list(limit = 50) {
      const root = path.join(rootDir, "conversations");
      const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      });
      const documents = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        try {
          return await readDocument(rootDir, decodeURIComponent(entry.name));
        } catch (error) {
          // Enumeration isolates unsupported or damaged generations; explicit reads remain strict.
          if (error instanceof OrdinaryConversationSnapshotIncompatibleError) return undefined;
          throw error;
        }
      }));
      return documents.filter((item): item is OrdinaryConversationControlDocument => item !== undefined)
        .map(summary)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, Math.max(0, Math.floor(limit)));
    },
  };
}

async function readDocument(rootDir: string, conversationId: string): Promise<OrdinaryConversationControlDocument | undefined> {
  const filePath = documentPath(rootDir, conversationId);
  const content = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (content === undefined) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(content) as unknown; }
  catch { throw new OrdinaryConversationSnapshotIncompatibleError(conversationId, "stored JSON is invalid"); }
  const result = documentSchema.safeParse(raw);
  if (!result.success || result.data.state.conversationId !== conversationId) {
    throw new OrdinaryConversationSnapshotIncompatibleError(conversationId, result.success ? "conversation identity is invalid" : z.prettifyError(result.error));
  }
  return result.data;
}

function summary(document: OrdinaryConversationControlDocument): OrdinaryConversationControlSummary {
  return {
    conversationId: document.state.conversationId,
    updatedAt: document.savedAt,
    deleted: document.state.deletedAt !== undefined,
  };
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempDirectory = path.join(directory, ".tmp");
  const tempPath = path.join(tempDirectory, `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.mkdir(tempDirectory, { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await renameWithRetry(tempPath, filePath); }
  catch (error) { await fs.rm(tempPath, { force: true }).catch(() => undefined); throw error; }
}

function documentPath(rootDir: string, conversationId: string): string {
  return path.join(rootDir, "conversations", encodeURIComponent(conversationId), "snapshot.json");
}
