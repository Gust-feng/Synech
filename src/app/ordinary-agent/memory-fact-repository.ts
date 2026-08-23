import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { isNodeError, toPersistedJsonShape } from "../../kernel/values/index.js";
import type { OrdinaryMemoryFact, OrdinaryMemoryFactRepository } from "./contracts.js";

const ownerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("space"), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("workspace"), id: z.string().min(1) }).strict(),
]);
const factSchema = z.object({
  factId: z.string().min(1),
  runId: z.string().min(1),
  conversationId: z.string().min(1),
  kind: z.enum(["read", "applied"]),
  memoryId: z.string().min(1),
  memoryKind: z.enum(["note", "path_dependency"]),
  owner: ownerSchema,
  revision: z.number().int().positive(),
  title: z.string().min(1),
  recordedAt: z.string().min(1),
  note: z.string().optional(),
}).strict();

export function createInMemoryOrdinaryMemoryFactRepository(): OrdinaryMemoryFactRepository {
  const facts = new Map<string, OrdinaryMemoryFact>();
  return {
    async append(fact) {
      const existing = facts.get(fact.factId);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(fact)) throw new Error(`Ordinary memory fact ${fact.factId} conflicts with an existing fact.`);
        return "already_recorded";
      }
      facts.set(fact.factId, structuredClone(fact));
      return "recorded";
    },
    async list(query) {
      return [...facts.values()]
        .filter((fact) => query?.runId === undefined || fact.runId === query.runId)
        .filter((fact) => query?.memoryId === undefined || fact.memoryId === query.memoryId)
        .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
        .map((fact) => structuredClone(fact));
    },
    async deleteByRunIds(runIds) {
      const set = new Set(runIds);
      for (const [factId, fact] of facts) if (set.has(fact.runId)) facts.delete(factId);
    },
  };
}

/** Durable per-run JSON facts; this is Ordinary-owned, not a PathDependency usage store. */
export function createFileSystemOrdinaryMemoryFactRepository(rootDir: string): OrdinaryMemoryFactRepository {
  const factsDir = path.join(rootDir, "memory-facts");
  const queues = new Map<string, Promise<void>>();
  const enqueue = <T>(runId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    queues.set(runId, tail);
    void tail.finally(() => {
      if (queues.get(runId) === tail) queues.delete(runId);
    });
    return result;
  };
  return {
    append(fact) {
      return enqueue(fact.runId, async () => {
        const current = await readFacts(factsDir, fact.runId);
        const existing = current.find((item) => item.factId === fact.factId);
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(fact)) throw new Error(`Ordinary memory fact ${fact.factId} conflicts with an existing fact.`);
          return "already_recorded";
        }
        await writeFacts(factsDir, fact.runId, [...current, fact]);
        return "recorded";
      });
    },
    async list(query) {
      if (query?.runId !== undefined) {
        return (await readFacts(factsDir, query.runId)).filter((fact) => query.memoryId === undefined || fact.memoryId === query.memoryId);
      }
      const entries = await fs.readdir(factsDir, { withFileTypes: true }).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) return [];
        throw error;
      });
      const result: OrdinaryMemoryFact[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const runId = decodeURIComponent(entry.name.slice(0, -".json".length));
        const facts = await readFacts(factsDir, runId);
        result.push(...facts.filter((fact) => query?.memoryId === undefined || fact.memoryId === query.memoryId));
      }
      return result.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
    },
    async deleteByRunIds(runIds) {
      await Promise.all(runIds.map((runId) => enqueue(runId, async () => {
        await fs.rm(factPath(factsDir, runId), { force: true });
      })));
    },
  };
}

async function readFacts(factsDir: string, runId: string): Promise<readonly OrdinaryMemoryFact[]> {
  const file = factPath(factsDir, runId);
  const content = await fs.readFile(file, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (content === undefined) return [];
  let raw: unknown;
  try { raw = JSON.parse(content) as unknown; }
  catch (error) { throw new Error(`Ordinary memory facts for ${runId} are not valid JSON.`, { cause: error }); }
  if (!Array.isArray(raw)) throw new Error(`Ordinary memory facts for ${runId} must be an array.`);
  return raw.map((value) => {
    const parsed = factSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Ordinary memory fact for ${runId} is incompatible: ${z.prettifyError(parsed.error)}`);
    return toPersistedJsonShape(parsed.data);
  });
}

async function writeFacts(factsDir: string, runId: string, facts: readonly OrdinaryMemoryFact[]): Promise<void> {
  const tempDir = path.join(factsDir, ".tmp");
  const target = factPath(factsDir, runId);
  const temp = path.join(tempDir, `${encodeURIComponent(runId)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(factsDir, { recursive: true });
  await fs.writeFile(temp, `${JSON.stringify(facts, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await renameWithRetry(temp, target); }
  catch (error) { await fs.rm(temp, { force: true }).catch(() => undefined); throw error; }
}

function factPath(rootDir: string, runId: string): string {
  return path.join(rootDir, `${encodeURIComponent(runId)}.json`);
}
