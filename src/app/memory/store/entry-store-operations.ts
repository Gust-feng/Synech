import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SqliteRuntimeDatabase } from "../../../adapters/runtime-storage/index.js";
import type { IdFactory } from "../../../kernel/id.js";
import { memoryOwnerKey } from "../../../domain/memory/index.js";
import { MemoryError } from "../contracts.js";
import type { MemoryEntryContent, MemoryEntryPublicationMutation, MemoryEntryRevisionRef, MemoryEntryRevisionView, MemorySource, MemorySourceView, MemoryTopic } from "../entry-contracts.js";
import { lexicalProjection } from "../recall/lexical-projection.js";
import { countMemoryTokens } from "../token-counting.js";
import { MAINTENANCE_MEMORY_MAX_TOKENS } from "../policy/maintenance-limits.js";
import { parseMemoryEntryRow, parseMemoryEntryRevision, parseMemoryEntryRevisionRow, parseMemorySource, parseMemorySourceRow, parseMemoryTopic, parseMemoryTopicRow, parseMemoryOverviewDependencies, type MemoryEntryRevisionRow } from "./persistence-schema.js";
import type { CommitMemoryEntriesBatchInput, RecordUserEntryEditInput } from "./content-repository.js";

const refSchema = z.object({ entry_id: z.string().min(1), revision_id: z.string().min(1) }).strict();
const requestSchema = z.object({ payload_hash: z.string(), result_json: z.string() }).strict();
const resultSchema = z.object({ entryId: z.string(), revisionId: z.string(), revision: z.number().int().positive(), overviewRevisionId: z.string().nullable() }).strict();
const stateSchema = z.object({ supply_state: z.enum(["eligible", "revoked"]) }).strict();
const sameOwner = (owner: MemorySource["owner"], key: string) => memoryOwnerKey(owner) === key;

/** Synchronous operations inside the existing repository's transaction, never another owner or adapter. */
export function createMemoryEntryStoreOperations(database: SqliteRuntimeDatabase, idFactory: IdFactory) {
  const db = database.connection;
  const entry = (ownerKey: string, entryId: string) => {
    const row = db.prepare("SELECT * FROM memory_entry WHERE owner_key = ? AND entry_id = ?").get(ownerKey, entryId);
    return row === undefined ? undefined : parseMemoryEntryRow(row);
  };
  const revision = (ownerKey: string, ref: MemoryEntryRevisionRef) => {
    const row = db.prepare("SELECT * FROM memory_entry_revision WHERE owner_key = ? AND entry_id = ? AND revision_id = ?").get(ownerKey, ref.entryId, ref.revisionId);
    return row === undefined ? undefined : parseMemoryEntryRevisionRow(row);
  };
  const source = (ownerKey: string, sourceId: string) => {
    const row = db.prepare("SELECT * FROM memory_source WHERE owner_key = ? AND source_id = ?").get(ownerKey, sourceId);
    return row === undefined ? undefined : parseMemorySourceRow(row);
  };
  const sourceViews = (ownerKey: string, row: MemoryEntryRevisionRow): MemorySourceView[] => row.sourceIds.map(id => {
    const value = source(ownerKey, id);
    if (value === undefined) throw new MemoryError("memory_store_failure", "Revision source is missing.");
    return { ...value, readback: value.locator.kind === "user_edit" ? "not_applicable" : value.branch === "superseded" ? "superseded" : value.lifecycle === "deleted" ? "deleted" : "available" };
  });
  const supported = (ownerKey: string, row: MemoryEntryRevisionRow) => row.supplyState === "eligible" && row.kind !== "withdrawal" && sourceViews(ownerKey, row).every(value => value.branch === "selected");
  const view = (ownerKey: string, ref: MemoryEntryRevisionRef): MemoryEntryRevisionView | undefined => {
    const item = entry(ownerKey, ref.entryId);
    const row = revision(ownerKey, ref);
    if (item === undefined || row === undefined) return undefined;
    const head = revision(ownerKey, { entryId: item.entryId, revisionId: item.headRevisionId });
    const currentRevisionId = head !== undefined && supported(ownerKey, head) ? head.revisionId : null;
    const { owner: _owner, supplyState, ...immutable } = row;
    return { entry: item, revision: immutable, supplyState, currentRevisionId,
      role: row.kind === "withdrawal" ? "withdrawn" : row.revisionId === currentRevisionId ? "current" : "historical", sources: sourceViews(ownerKey, row) };
  };
  const dependencies = (revisionId: string) => parseMemoryOverviewDependencies({ revisionId,
    entries: db.prepare("SELECT entry_id, revision_id FROM memory_overview_dependency WHERE overview_revision_id = ? ORDER BY entry_id").all(revisionId).map(value => {
      const row = refSchema.parse(value); return { entryId: row.entry_id, revisionId: row.revision_id };
    }) });
  const insertSource = (value: MemorySource) => {
    const parsed = parseMemorySource(value);
    const key = memoryOwnerKey(parsed.owner);
    const existing = source(key, parsed.sourceId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(parsed)) throw new MemoryError("memory_source_unavailable", "Source identity or state changed.");
      return;
    }
    db.prepare("INSERT INTO memory_source VALUES (?, ?, ?, ?, ?, ?)").run(parsed.sourceId, key, JSON.stringify(parsed.locator), parsed.lifecycle, parsed.branch, parsed.createdAt);
  };
  const revisionTerms = (key: string, value: MemoryEntryContent) => {
    const labels = value.topicIds.flatMap(id => {
      const raw = db.prepare("SELECT * FROM memory_topic WHERE owner_key = ? AND topic_id = ?").get(key, id);
      if (raw === undefined) throw new MemoryError("memory_invalid_edit", "Unknown topic.");
      const topic = parseMemoryTopicRow(raw); return [topic.name, ...topic.aliases];
    });
    return lexicalProjection([value.markdown, value.applicability ?? "", ...labels].join(" ")).join(" ");
  };
  const insertTopics = (key: string, topics: readonly MemoryTopic[]) => {
    for (const value of topics) {
      const parsed = parseMemoryTopic(value);
      if (!sameOwner(parsed.owner, key)) throw new MemoryError("memory_invalid_owner", "Topic owner mismatch.");
      const existing = db.prepare("SELECT * FROM memory_topic WHERE topic_id = ?").get(parsed.topicId);
      if (existing !== undefined && !sameOwner(parseMemoryTopicRow(existing).owner, key)) throw new MemoryError("memory_invalid_owner", "Topic owner mismatch.");
      db.prepare("INSERT INTO memory_topic VALUES (?, ?, ?, ?) ON CONFLICT(topic_id) DO UPDATE SET name = excluded.name, aliases_json = excluded.aliases_json").run(parsed.topicId, key, parsed.name, JSON.stringify(parsed.aliases));
    }
    for (const topic of topics) {
      const affected = db.prepare(`SELECT r.* FROM memory_entry_revision r JOIN memory_entry_revision_topic t ON t.revision_id = r.revision_id
        WHERE t.topic_id = ? AND r.owner_key = ?`).all(topic.topicId, key).map(parseMemoryEntryRevisionRow);
      for (const value of affected) db.prepare("UPDATE memory_entry_fts SET terms = ? WHERE revision_id = ? AND owner_key = ?").run(revisionTerms(key, value), value.revisionId, key);
    }
  };
  const validateMutation = (key: string, mutation: MemoryEntryPublicationMutation, origin: "model" | "user_edit", now: number) => {
    const current = entry(key, mutation.entryId);
    if (mutation.operation === "create" ? current !== undefined : current === undefined || current.headRevisionId !== mutation.expectedRevisionId) {
      throw new MemoryError(current === undefined && mutation.operation === "revise" ? "memory_entry_not_found" : "memory_revision_stale", "Entry head changed.");
    }
    const previous = current === undefined ? undefined : revision(key, { entryId: current.entryId, revisionId: current.headRevisionId });
    const value = parseMemoryEntryRevision({ revisionId: mutation.revisionId, entryId: mutation.entryId,
      revision: (previous?.revision ?? 0) + 1, previousRevisionId: previous?.revisionId ?? null, kind: mutation.kind, origin,
      markdown: mutation.markdown, applicability: mutation.applicability, occurredAt: mutation.occurredAt, reportedAt: mutation.reportedAt,
      reason: mutation.reason, topicIds: mutation.topicIds, related: mutation.related, sourceIds: mutation.sourceIds, retractsRevisionIds: mutation.retractsRevisionIds, publishedAt: now });
    for (const id of value.sourceIds) if (source(key, id) === undefined) throw new MemoryError("memory_source_unavailable", "Unknown revision source.");
    for (const id of value.topicIds) {
      const topic = db.prepare("SELECT * FROM memory_topic WHERE topic_id = ? AND owner_key = ?").get(id, key);
      if (topic === undefined) throw new MemoryError("memory_invalid_edit", "Unknown topic.");
      parseMemoryTopicRow(topic);
    }
    for (const id of value.retractsRevisionIds) {
      const old = revision(key, { entryId: mutation.entryId, revisionId: id });
      if (old === undefined || old.revision >= value.revision) throw new MemoryError("memory_invalid_edit", "Retraction must identify an older revision of this entry.");
    }
    return value;
  };
  const publishMutations = (key: string, generation: number, mutations: readonly MemoryEntryPublicationMutation[], origin: "model" | "user_edit", now: number) => {
    if (new Set(mutations.map(value => value.entryId)).size !== mutations.length) throw new MemoryError("memory_invalid_edit", "One revision per entry is allowed in a batch.");
    const values = mutations.map(value => validateMutation(key, value, origin, now));
    for (const value of values) {
      if (new Set(value.related.map(link => link.entryId)).size !== value.related.length) {
        throw new MemoryError("memory_invalid_edit", "Related entries must be unique.");
      }
    }
    for (const value of values) {
      if (value.previousRevisionId === null) db.prepare("INSERT INTO memory_entry VALUES (?, ?, ?, ?, ?)").run(value.entryId, key, generation, value.revisionId, now);
      const content: MemoryEntryContent = { markdown: value.markdown, applicability: value.applicability, occurredAt: value.occurredAt, reportedAt: value.reportedAt, reason: value.reason, topicIds: value.topicIds, related: value.related };
      db.prepare("INSERT INTO memory_entry_revision VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eligible')").run(value.revisionId, value.entryId, key, value.revision, value.previousRevisionId, value.kind, origin, JSON.stringify(content), JSON.stringify(value.sourceIds), JSON.stringify(value.retractsRevisionIds), now);
      if (value.previousRevisionId !== null) db.prepare("UPDATE memory_entry SET head_revision_id = ? WHERE entry_id = ? AND owner_key = ?").run(value.revisionId, value.entryId, key);
      for (const id of new Set(value.sourceIds)) db.prepare("INSERT INTO memory_entry_revision_source VALUES (?, ?, ?)").run(value.revisionId, id, key);
      for (const id of new Set(value.topicIds)) db.prepare("INSERT INTO memory_entry_revision_topic VALUES (?, ?, ?)").run(value.revisionId, id, key);
      db.prepare("INSERT INTO memory_entry_fts(terms, revision_id, entry_id, owner_key) VALUES (?, ?, ?, ?)").run(revisionTerms(key, value), value.revisionId, value.entryId, key);
      for (const id of value.retractsRevisionIds) {
        db.prepare("UPDATE memory_entry_revision SET supply_state = 'revoked' WHERE revision_id = ? AND owner_key = ?").run(id, key);
        db.prepare("UPDATE memory_owner_doc SET validity = 'invalidated' WHERE revision_id IN (SELECT overview_revision_id FROM memory_overview_dependency WHERE revision_id = ?)").run(id);
      }
    }
    for (const value of values) for (const link of value.related) {
      if (entry(key, link.entryId) === undefined) throw new MemoryError("memory_invalid_edit", "Related entry is absent or belongs to another owner.");
      db.prepare("INSERT INTO memory_entry_revision_related VALUES (?, ?, ?, ?)").run(value.revisionId, value.entryId, link.entryId, key);
    }
    return values.map(value => ({ entryId: value.entryId, revisionId: value.revisionId }));
  };
  const validateReads = (input: CommitMemoryEntriesBatchInput, conversationState: (id: string) => { generation: number; fenced: boolean }, excluded: (id: string) => number): string | undefined => {
    const provided = new Map(input.sources.map(value => [value.sourceId, parseMemorySource(value)]));
    const observed = new Map(input.readSet.map(value => [value.sourceId, value]));
    const validate = (value: MemorySource, expectedGeneration: number | null, main = false) => {
      if (!sameOwner(value.owner, input.ownerKey) || value.lifecycle !== "present" || value.branch !== "selected") return false;
      if (value.locator.kind === "user_edit") return false; // Background never manufactures user provenance.
      const state = conversationState(value.locator.conversationId);
      if (state.fenced || state.generation !== expectedGeneration || excluded(value.locator.conversationId) >= value.locator.fromOrdinal) return false;
      if (main && (value.locator.conversationId !== input.conversationId || value.locator.conversationGeneration !== input.expectedConversationGeneration ||
          value.locator.toOrdinal > Math.max(input.batchRange.toOrdinal, input.advanceProgressTo.fragment?.ordinal ?? 0))) return false;
      const identity = db.prepare("SELECT source_revision FROM memory_transcript_identity WHERE owner_key = ? AND conversation_id = ? AND ordinal = ?").get(input.ownerKey, value.locator.conversationId, value.locator.toOrdinal);
      return identity !== undefined && z.object({ source_revision: z.number().int().nonnegative() }).strict().parse(identity).source_revision === value.locator.sourceRevision;
    };
    for (const read of input.readSet) {
      const persisted = source(input.ownerKey, read.sourceId);
      const supplied = provided.get(read.sourceId);
      const value = persisted ?? supplied;
      if (value === undefined || !validate(value, read.conversationGeneration, persisted === undefined)) return "source_changed";
      if (persisted !== undefined && supplied !== undefined && JSON.stringify(supplied) !== JSON.stringify(persisted)) return "source_changed";
    }
    for (const read of input.entryReadSet) {
      const value = view(input.ownerKey, read);
      if (value === undefined || value.entry.generation !== input.expectedGeneration || value.entry.headRevisionId !== read.expectedHeadRevisionId || value.supplyState !== "eligible") return "entry_head_superseded";
      // Pure recognition reads may be historical/deleted. Actual raw reads are separately fenced.
      for (const used of value.sources) {
        const observation = observed.get(used.sourceId);
        if (observation !== undefined && !validate(used, observation.conversationGeneration)) return "source_changed";
      }
    }
    const recognitionSources = new Set(input.entryReadSet.flatMap(ref => revision(input.ownerKey, ref)?.sourceIds ?? []));
    for (const value of input.sources) {
      const existing = source(input.ownerKey, value.sourceId);
      if (existing !== undefined) {
        if ((!observed.has(value.sourceId) && !recognitionSources.has(value.sourceId)) || JSON.stringify(existing) !== JSON.stringify(value)) return "source_changed";
      } else if (!validate(value, input.expectedConversationGeneration, true)) return "source_changed";
    }
    for (const mutation of input.mutations) {
      if (!mutation.sourceIds.every(id => provided.has(id) || observed.has(id) || recognitionSources.has(id))) return "source_not_read";
      if (!mutation.sourceIds.some(id => {
        const value = provided.get(id); return value !== undefined && value.locator.kind === "conversation_range" &&
          value.locator.fromOrdinal >= input.batchRange.fromOrdinal && source(input.ownerKey, id) === undefined;
      })) return "no_new_evidence";
    }
    return undefined;
  };
  const bindOverview = (key: string, overviewId: string, refs: readonly MemoryEntryRevisionRef[]) => {
    for (const ref of refs) {
      const value = revision(key, ref);
      if (value === undefined || !supported(key, value)) throw new MemoryError("memory_invalid_edit", "Overview dependency cannot supply a recognition.");
      db.prepare("INSERT INTO memory_overview_dependency VALUES (?, ?, ?, ?)").run(overviewId, ref.entryId, ref.revisionId, key);
    }
  };
  const cursors = new Map<string, { key: string; snapshot: string; offset: number }>();
  const page = <T>(key: string, rows: readonly T[], limit: number, cursor?: string) => {
    const snapshot = JSON.stringify(rows);
    const previous = cursor === undefined ? undefined : cursors.get(cursor);
    if (cursor !== undefined && (previous === undefined || previous.key !== key || previous.snapshot !== snapshot)) throw new MemoryError("memory_revision_stale", "Query cursor is stale or outside this scope.");
    const offset = previous?.offset ?? 0;
    const size = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const items = rows.slice(offset, offset + size);
    let nextCursor: string | null = null;
    if (offset + size < rows.length) {
      nextCursor = randomUUID();
      if (cursors.size >= 256) cursors.delete(cursors.keys().next().value!);
      cursors.set(nextCursor, { key, snapshot, offset: offset + size });
    }
    return { items, nextCursor };
  };
  const refs = (rows: readonly unknown[]) => rows.map(value => { const row = refSchema.parse(value); return { entryId: row.entry_id, revisionId: row.revision_id }; });
  const userMutation = (input: RecordUserEntryEditInput, sourceId: string): MemoryEntryPublicationMutation => {
    const edit = input.edit;
    return { ...edit, reportedAt: new Date(input.now).toISOString(), reason: edit.reason === null ? null : { text: edit.reason, sourceIds: [sourceId] }, sourceIds: [sourceId], revisionId: idFactory("mementryrev") };
  };
  const overviewForUser = (key: string) => {
    const candidates = refs(db.prepare("SELECT entry_id, head_revision_id AS revision_id FROM memory_entry WHERE owner_key = ? ORDER BY created_at DESC, entry_id").all(key));
    const selected: MemoryEntryRevisionRef[] = [];
    let markdown = "";
    for (const ref of candidates) {
      const value = view(key, ref);
      if (value?.role !== "current") continue;
      const block = `${markdown.length ? "\n\n" : ""}${value.revision.markdown}`;
      if (countMemoryTokens(markdown + block) > MAINTENANCE_MEMORY_MAX_TOKENS) continue;
      markdown += block; selected.push(ref);
    }
    return { markdown, entries: selected };
  };
  return { entry, revision, source, view, supported, sourceViews, dependencies, insertSource, insertTopics, publishMutations, validateReads, bindOverview, page, refs, userMutation, overviewForUser,
    readRequest(key: string, requestId: string) { const row = db.prepare("SELECT payload_hash, result_json FROM memory_edit_request WHERE owner_key = ? AND request_id = ?").get(key, requestId); return row === undefined ? undefined : requestSchema.parse(row); },
    parseEditResult(value: string) { return resultSchema.parse(JSON.parse(value)); },
    parseState: (value: unknown) => stateSchema.parse(value),
  };
}
