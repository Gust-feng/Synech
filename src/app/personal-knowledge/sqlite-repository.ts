import type { SQLInputValue } from "node:sqlite";

import type { SqliteRuntimeDatabase } from "../../adapters/runtime-storage/index.js";
import {
  PersonalKnowledgeError,
  type PersonalKnowledgeChangeRecord,
  type PersonalKnowledgeCommand,
  type PersonalKnowledgeRepository,
  type PersonalKnowledgeSearchResult,
  type PersonalKnowledgeSnapshot,
  type PersonalNote,
  type PersonalNoteRevision,
  type KnowledgeListQuery,
  type KnowledgePage,
  type KnowledgePageSummary,
} from "./contracts.js";

const MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE personal_notes (
      id TEXT PRIMARY KEY,
      space_id TEXT,
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      position INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX personal_notes_space_position_idx ON personal_notes(space_id, position, id);
    CREATE VIRTUAL TABLE personal_notes_fts USING fts5(
      title, body_markdown, content='personal_notes', content_rowid='rowid', tokenize='unicode61'
    );
    CREATE TRIGGER personal_notes_fts_insert AFTER INSERT ON personal_notes BEGIN
      INSERT INTO personal_notes_fts(rowid, title, body_markdown) VALUES (new.rowid, new.title, new.body_markdown);
    END;
    CREATE TRIGGER personal_notes_fts_delete AFTER DELETE ON personal_notes BEGIN
      INSERT INTO personal_notes_fts(personal_notes_fts, rowid, title, body_markdown)
      VALUES ('delete', old.rowid, old.title, old.body_markdown);
    END;
    CREATE TRIGGER personal_notes_fts_update AFTER UPDATE OF title, body_markdown ON personal_notes BEGIN
      INSERT INTO personal_notes_fts(personal_notes_fts, rowid, title, body_markdown)
      VALUES ('delete', old.rowid, old.title, old.body_markdown);
      INSERT INTO personal_notes_fts(rowid, title, body_markdown)
      VALUES (new.rowid, new.title, new.body_markdown);
    END;
    CREATE TABLE personal_note_revisions (
      note_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      base_revision INTEGER,
      operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete', 'snapshot')),
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user', 'agent', 'system')),
      actor_id TEXT,
      trace_id TEXT,
      goal_id TEXT,
      tool_call_id TEXT,
      change_summary TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(note_id, revision)
    ) STRICT;
    CREATE INDEX personal_note_revisions_created_idx ON personal_note_revisions(note_id, created_at DESC);
    CREATE TABLE knowledge_pages (
      ref_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('note', 'space_reference')),
      collected_at INTEGER NOT NULL,
      asset_json TEXT
    ) STRICT;
    CREATE TABLE knowledge_links (
      from_ref_id TEXT NOT NULL,
      to_ref_id TEXT NOT NULL,
      PRIMARY KEY(from_ref_id, to_ref_id),
      CHECK(from_ref_id <> to_ref_id)
    ) STRICT;
    CREATE TABLE knowledge_themes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('agent', 'user'))
    ) STRICT;
    CREATE TABLE knowledge_theme_assignments (
      ref_id TEXT NOT NULL,
      theme_id TEXT NOT NULL REFERENCES knowledge_themes(id) ON DELETE CASCADE,
      assigned_by TEXT NOT NULL CHECK(assigned_by IN ('agent', 'user')),
      locked INTEGER NOT NULL CHECK(locked IN (0, 1)),
      PRIMARY KEY(ref_id, theme_id)
    ) STRICT;
    CREATE TABLE knowledge_recently_opened (ref_id TEXT PRIMARY KEY, opened_at INTEGER NOT NULL) STRICT;
    CREATE TABLE knowledge_change_records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN (
        'knowledge.asset_updated', 'knowledge.uncollected', 'knowledge.theme_created',
        'knowledge.theme_assigned', 'knowledge.theme_unassigned'
      )),
      ref_id TEXT,
      theme_id TEXT,
      payload_json TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK(actor_kind IN ('user', 'agent', 'system')),
      actor_id TEXT,
      trace_id TEXT,
      goal_id TEXT,
      tool_call_id TEXT,
      occurred_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX knowledge_change_records_occurred_idx ON knowledge_change_records(occurred_at DESC, id DESC);
    CREATE INDEX knowledge_change_records_ref_idx ON knowledge_change_records(ref_id, occurred_at DESC);
    CREATE INDEX knowledge_change_records_theme_idx ON knowledge_change_records(theme_id, occurred_at DESC);
  `,
}] as const;

export function createSqlitePersonalKnowledgeRepository(database: SqliteRuntimeDatabase): PersonalKnowledgeRepository {
  database.migrate("personal-knowledge", MIGRATIONS);
  return {
    async readSnapshot(): Promise<PersonalKnowledgeSnapshot> {
      try {
        const notes = database.connection.prepare(`
          SELECT id, space_id AS spaceId, title, body_markdown AS bodyMarkdown, revision,
                 created_at AS createdAt, updated_at AS updatedAt
          FROM personal_notes ORDER BY position, id
        `).all().map((row) => {
          const value = row as Record<string, SQLInputValue>;
          return {
            id: String(value.id),
            ...(value.spaceId === null ? {} : { spaceId: String(value.spaceId) }),
            title: String(value.title),
            bodyMarkdown: String(value.bodyMarkdown),
            revision: Number(value.revision),
            createdAt: Number(value.createdAt),
            updatedAt: Number(value.updatedAt),
          };
        });
        const pages = database.connection.prepare(
          "SELECT ref_id AS refId, kind, collected_at AS collectedAt, asset_json AS assetJson FROM knowledge_pages ORDER BY collected_at DESC, ref_id",
        ).all().map((row) => {
          const value = row as Record<string, SQLInputValue>;
          return {
            refId: String(value.refId),
            kind: String(value.kind) as PersonalKnowledgeSnapshot["pages"][number]["kind"],
            collectedAt: Number(value.collectedAt),
            ...(value.assetJson === null ? {} : { asset: JSON.parse(String(value.assetJson)) }),
          };
        });
        const links = database.connection.prepare(
          "SELECT from_ref_id AS 'from', to_ref_id AS 'to' FROM knowledge_links ORDER BY from_ref_id, to_ref_id",
        ).all() as unknown as PersonalKnowledgeSnapshot["links"];
        const themes = database.connection.prepare(
          "SELECT id, name, color, origin FROM knowledge_themes ORDER BY id",
        ).all() as unknown as PersonalKnowledgeSnapshot["themes"];
        const assignments = database.connection.prepare(`
          SELECT ref_id AS refId, theme_id AS themeId, assigned_by AS 'by', locked
          FROM knowledge_theme_assignments ORDER BY theme_id, ref_id
        `).all().map((row) => ({ ...row, locked: Boolean((row as Record<string, SQLInputValue>).locked) })) as unknown as PersonalKnowledgeSnapshot["assignments"];
        const recentlyOpened = Object.fromEntries(database.connection.prepare(
          "SELECT ref_id AS refId, opened_at AS openedAt FROM knowledge_recently_opened",
        ).all().map((row) => {
          const value = row as Record<string, SQLInputValue>;
          return [String(value.refId), Number(value.openedAt)];
        }));
        return { notes, pages, links, themes, assignments, recentlyOpened };
      } catch (error) {
        throw repositoryError("Could not read personal knowledge from SQLite.", error);
      }
    },
    async getNote(id: string): Promise<PersonalNote | undefined> {
      try {
        const row = database.connection.prepare(`
          SELECT id, space_id AS spaceId, title, body_markdown AS bodyMarkdown, revision,
                 created_at AS createdAt, updated_at AS updatedAt
          FROM personal_notes WHERE id = ?
        `).get(id);
        return row === undefined ? undefined : personalNoteFromRow(row as Record<string, SQLInputValue>);
      } catch (error) {
        throw repositoryError("Could not read the personal note from SQLite.", error);
      }
    },
    async listNoteRevisions(id: string, limit: number): Promise<readonly PersonalNoteRevision[]> {
      try {
        return database.connection.prepare(`
          SELECT note_id AS noteId, revision, base_revision AS baseRevision, operation,
                 title, body_markdown AS bodyMarkdown, actor_kind AS actorKind,
                 actor_id AS actorId, trace_id AS traceId, goal_id AS goalId,
                 tool_call_id AS toolCallId, change_summary AS changeSummary,
                 created_at AS createdAt
          FROM personal_note_revisions WHERE note_id = ?
          ORDER BY revision DESC LIMIT ?
        `).all(id, limit).map((row) => personalNoteRevisionFromRow(row as Record<string, SQLInputValue>));
      } catch (error) {
        throw repositoryError("Could not read personal note revisions from SQLite.", error);
      }
    },
    async getNoteRevision(id: string, revision: number): Promise<PersonalNoteRevision | undefined> {
      try {
        const row = database.connection.prepare(`
          SELECT note_id AS noteId, revision, base_revision AS baseRevision, operation,
                 title, body_markdown AS bodyMarkdown, actor_kind AS actorKind,
                 actor_id AS actorId, trace_id AS traceId, goal_id AS goalId,
                 tool_call_id AS toolCallId, change_summary AS changeSummary,
                 created_at AS createdAt
          FROM personal_note_revisions WHERE note_id = ? AND revision = ?
        `).get(id, revision);
        return row === undefined ? undefined : personalNoteRevisionFromRow(row as Record<string, SQLInputValue>);
      } catch (error) {
        throw repositoryError("Could not read the personal note revision from SQLite.", error);
      }
    },
    async searchNotes(input): Promise<readonly PersonalKnowledgeSearchResult[]> {
      try {
        const ftsRows = database.connection.prepare(`
          SELECT n.id, n.space_id AS spaceId, n.title, n.revision,
                 n.created_at AS createdAt, n.updated_at AS updatedAt,
                 snippet(personal_notes_fts, 1, '', '', '...', 24) AS snippet
          FROM personal_notes_fts
          JOIN personal_notes n ON n.rowid = personal_notes_fts.rowid
          WHERE personal_notes_fts MATCH ?
            AND (? IS NULL OR n.space_id = ?)
          ORDER BY bm25(personal_notes_fts, 4.0, 1.0), n.updated_at DESC, n.id
          LIMIT ?
        `).all(ftsQuery(input.query), input.spaceId ?? null, input.spaceId ?? null, input.limit);
        const likeRows = database.connection.prepare(`
          SELECT id, space_id AS spaceId, title, revision,
                 created_at AS createdAt, updated_at AS updatedAt,
                 substr(body_markdown, 1, 240) AS snippet
          FROM personal_notes
          WHERE (title LIKE ? ESCAPE '\\' OR body_markdown LIKE ? ESCAPE '\\')
            AND (? IS NULL OR space_id = ?)
          ORDER BY updated_at DESC, id
          LIMIT ?
        `).all(likePattern(input.query), likePattern(input.query), input.spaceId ?? null, input.spaceId ?? null, input.limit);
        const results = new Map<string, PersonalKnowledgeSearchResult>();
        for (const row of [...ftsRows, ...likeRows]) {
          const result = searchResultFromRow(row as Record<string, SQLInputValue>);
          if (!results.has(result.note.id)) results.set(result.note.id, result);
          if (results.size >= input.limit) break;
        }
        return [...results.values()];
      } catch (error) {
        throw repositoryError("Could not search personal knowledge in SQLite.", error);
      }
    },
    async listPages(input: KnowledgeListQuery): Promise<{ readonly pages: readonly KnowledgePageSummary[]; readonly nextCursor?: string }> {
      try {
        const limit = input.limit ?? 100;
        const themeId = input.themeId === undefined ? undefined : requiredValue(input.themeId);
        const spaceId = input.spaceId === undefined ? undefined : requiredValue(input.spaceId);
        const kind = input.kind;
        const query = input.query?.trim();
        const cursor = input.cursor === undefined ? undefined : parsePageCursor(input.cursor);
        const pages = database.connection.prepare(
          "SELECT ref_id AS refId, kind, collected_at AS collectedAt, asset_json AS assetJson FROM knowledge_pages",
        ).all().map((row) => {
          const value = row as Record<string, SQLInputValue>;
          return {
            refId: String(value.refId),
            kind: String(value.kind) as PersonalKnowledgeSnapshot["pages"][number]["kind"],
            collectedAt: Number(value.collectedAt),
            ...(value.assetJson === null ? {} : { asset: JSON.parse(String(value.assetJson)) as Record<string, unknown> }),
          };
        });
        const noteRows = database.connection.prepare(
          "SELECT id, title, space_id AS spaceId, created_at AS createdAt FROM personal_notes",
        ).all() as Record<string, SQLInputValue>[];
        const noteTitles = new Map(noteRows.map((row) => [String(row.id), String(row.title)]));
        const pageSpaceIds = new Map(noteRows.flatMap((row) => row.spaceId === null
          ? []
          : [[String(row.id), String(row.spaceId)] as const]));
        // 未收藏的 UI 笔记也属于 Agent 可枚举的个人笔记；已收藏的以知识页为准，避免重复。
        const collectedNoteRefIds = new Set(pages.filter((page) => page.kind === "note").map((page) => page.refId));
        const noteCandidates = noteRows
          .filter((row) => !collectedNoteRefIds.has(String(row.id)))
          .map((row) => ({
            refId: String(row.id),
            kind: "note" as const,
            collectedAt: Number(row.createdAt),
          }));
        const themeAssignments = new Map<string, Set<string>>();
        for (const row of database.connection.prepare(
          "SELECT ref_id AS refId, theme_id AS themeId FROM knowledge_theme_assignments",
        ).all()) {
          const value = row as Record<string, SQLInputValue>;
          const refId = String(value.refId);
          const set = themeAssignments.get(String(value.themeId)) ?? new Set<string>();
          set.add(refId);
          themeAssignments.set(String(value.themeId), set);
        }
        const titleOf = (page: { readonly kind: string; readonly refId: string; readonly asset?: Record<string, unknown> }): string | undefined =>
          page.kind === "note" ? noteTitles.get(page.refId)
            : page.kind === "space_reference" && typeof page.asset?.title === "string" ? page.asset.title
              : undefined;
        const matchesQuery = (title: string | undefined): boolean =>
          query === undefined || query.length === 0 || title?.toLocaleLowerCase().includes(query.toLocaleLowerCase()) === true;
        const candidates = [...pages, ...noteCandidates]
          .filter((page) => kind === undefined || page.kind === kind)
          .filter((page) => spaceId === undefined || (page.kind === "note" && pageSpaceIds.get(page.refId) === spaceId))
          .filter((page) => themeId === undefined || themeAssignments.get(themeId)?.has(page.refId) === true)
          .filter((page) => matchesQuery(titleOf(page)))
          .sort((left, right) => right.collectedAt - left.collectedAt
            || (left.refId < right.refId ? 1 : left.refId > right.refId ? -1 : 0));
        const startIndex = cursor === undefined ? 0 : candidates.findIndex((page) =>
          page.collectedAt === cursor.collectedAt && page.refId === cursor.refId) + 1;
        const sliced = candidates.slice(startIndex, startIndex + limit);
        const summaries: KnowledgePageSummary[] = sliced.map((page) => ({
          refId: page.refId,
          kind: page.kind,
          ...(titleOf(page) === undefined ? {} : { title: titleOf(page) }),
          ...(page.kind === "note" && pageSpaceIds.get(page.refId) !== undefined
            ? { spaceId: pageSpaceIds.get(page.refId)! }
            : {}),
          collectedAt: page.collectedAt,
        }));
        const last = sliced[sliced.length - 1];
        const hasMore = startIndex + sliced.length < candidates.length;
        return {
          pages: summaries,
          ...(hasMore && last !== undefined ? { nextCursor: JSON.stringify({ collectedAt: last.collectedAt, refId: last.refId }) } : {}),
        };
      } catch (error) {
        if (error instanceof PersonalKnowledgeError) throw error;
        throw repositoryError("Could not list personal knowledge pages from SQLite.", error);
      }
    },
    async recentChanges(input: {
      readonly refId?: string;
      readonly themeId?: string;
      readonly limit: number;
      readonly cursor?: string;
    }): Promise<{ readonly records: readonly PersonalKnowledgeChangeRecord[]; readonly nextCursor?: string }> {
      try {
        // 主题归类的 refIds 保存在 payload 中，无法用单一 ref_id 列过滤，
        // 因此与 listPages 一样在 JS 侧过滤后分页（个人知识库规模有限）。
        const cursor = input.cursor === undefined ? undefined : parseChangeCursor(input.cursor);
        const rows = database.connection.prepare(`
          SELECT id, type, ref_id AS refId, theme_id AS themeId, payload_json AS payloadJson,
                 actor_kind AS actorKind, actor_id AS actorId, trace_id AS traceId,
                 goal_id AS goalId, tool_call_id AS toolCallId, occurred_at AS occurredAt
          FROM knowledge_change_records
          ORDER BY occurred_at DESC, id DESC
        `).all().map((row) => changeRecordFromRow(row as Record<string, SQLInputValue>));
        const matches = rows.filter((record) =>
          (input.refId === undefined || recordRefId(record) === input.refId || ("refIds" in record && record.refIds.includes(input.refId)))
          && (input.themeId === undefined || recordThemeId(record) === input.themeId));
        const startIndex = cursor === undefined ? 0 : matches.findIndex((record) =>
          record.occurredAt === cursor.occurredAt && record.id === cursor.id) + 1;
        const sliced = matches.slice(startIndex, startIndex + input.limit);
        const last = sliced[sliced.length - 1];
        const hasMore = startIndex + sliced.length < matches.length;
        return {
          records: sliced,
          ...(hasMore && last !== undefined ? { nextCursor: JSON.stringify({ occurredAt: last.occurredAt, id: last.id }) } : {}),
        };
      } catch (error) {
        if (error instanceof PersonalKnowledgeError) throw error;
        throw repositoryError("Could not read personal knowledge change records from SQLite.", error);
      }
    },
    async appendChangeRecord(record: PersonalKnowledgeChangeRecord): Promise<void> {
      try {
        const payload = changeRecordPayload(record);
        database.connection.prepare(`
          INSERT INTO knowledge_change_records(
            id, type, ref_id, theme_id, payload_json,
            actor_kind, actor_id, trace_id, goal_id, tool_call_id, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.id, record.type, payload.refId ?? null, payload.themeId ?? null, JSON.stringify(payload.rest),
          record.actor.kind, record.actor.actorId ?? null, record.actor.traceId ?? null,
          record.actor.goalId ?? null, record.actor.toolCallId ?? null, record.occurredAt,
        );
      } catch (error) {
        throw repositoryError("Could not append a personal knowledge change record to SQLite.", error);
      }
    },
    async assignTheme(input: {
      readonly themeId: string;
      readonly refIds: readonly string[];
      readonly by: "agent" | "user";
    }): Promise<{ readonly assigned: readonly string[]; readonly unchanged: readonly string[] }> {
      try {
        return database.transaction(() => {
          requireTheme(database, input.themeId);
          const pageLookup = database.connection.prepare("SELECT 1 FROM knowledge_pages WHERE ref_id = ?");
          const insert = database.connection.prepare(`
            INSERT OR IGNORE INTO knowledge_theme_assignments(ref_id, theme_id, assigned_by, locked)
            VALUES (?, ?, ?, 0)
          `);
          const assigned: string[] = [];
          const unchanged: string[] = [];
          for (const refId of input.refIds) {
            if (pageLookup.get(refId) === undefined) {
              throw new PersonalKnowledgeError("personal_knowledge_invalid_input", `Knowledge page ${refId} was not found.`);
            }
            const result = insert.run(refId, input.themeId, input.by);
            (Number(result.changes) > 0 ? assigned : unchanged).push(refId);
          }
          return { assigned, unchanged };
        });
      } catch (error) {
        if (error instanceof PersonalKnowledgeError) throw error;
        throw repositoryError("Could not assign knowledge pages to a theme in SQLite.", error);
      }
    },
    async unassignTheme(input: { readonly themeId: string; readonly refIds: readonly string[] }): Promise<readonly string[]> {
      try {
        return database.transaction(() => {
          requireTheme(database, input.themeId);
          const pageLookup = database.connection.prepare("SELECT 1 FROM knowledge_pages WHERE ref_id = ?");
          const deleteAssignment = database.connection.prepare(
            "DELETE FROM knowledge_theme_assignments WHERE ref_id = ? AND theme_id = ?",
          );
          for (const refId of input.refIds) {
            if (pageLookup.get(refId) === undefined) {
              throw new PersonalKnowledgeError("personal_knowledge_invalid_input", `Knowledge page ${refId} was not found.`);
            }
            deleteAssignment.run(refId, input.themeId);
          }
          return input.refIds;
        });
      } catch (error) {
        if (error instanceof PersonalKnowledgeError) throw error;
        throw repositoryError("Could not unassign knowledge pages from a theme in SQLite.", error);
      }
    },
    async execute(command: PersonalKnowledgeCommand): Promise<void> {
      try {
        executeCommand(database, command);
      } catch (error) {
        if (error instanceof PersonalKnowledgeError) throw error;
        throw repositoryError(`Could not execute ${command.type}.`, error);
      }
    },
  };
}

function executeCommand(database: SqliteRuntimeDatabase, command: PersonalKnowledgeCommand): void {
  switch (command.type) {
    case "note.create": {
      database.transaction(() => {
        const position = Number((database.connection.prepare("SELECT COALESCE(MIN(position), 0) - 1 AS value FROM personal_notes").get() as { value: number }).value);
        database.connection.prepare(`
          INSERT INTO personal_notes(id, space_id, title, body_markdown, position, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(command.note.id, command.note.spaceId ?? null, command.note.title, command.note.bodyMarkdown, position, command.note.revision, command.note.createdAt, command.note.updatedAt);
        insertNoteRevision(database, {
          noteId: command.note.id, revision: 1, operation: "create", title: command.note.title,
          bodyMarkdown: command.note.bodyMarkdown, actor: command.actor, changeSummary: command.changeSummary,
          createdAt: command.note.createdAt,
        });
      });
      return;
    }
    case "note.update": {
      const columns: string[] = [];
      const values: SQLInputValue[] = [];
      if (command.title !== undefined) { columns.push("title = ?"); values.push(command.title); }
      if (command.bodyMarkdown !== undefined) { columns.push("body_markdown = ?"); values.push(command.bodyMarkdown); }
      if (columns.length === 0) return;
      columns.push("updated_at = ?", "revision = revision + 1");
      values.push(command.updatedAt, command.id, command.expectedRevision);
      database.transaction(() => {
        const result = database.connection.prepare(
          `UPDATE personal_notes SET ${columns.join(", ")} WHERE id = ? AND revision = ?`,
        ).run(...values);
        if (Number(result.changes) === 0) throw noteWriteError(database, command.id);
        const note = database.connection.prepare("SELECT title, body_markdown AS bodyMarkdown, revision FROM personal_notes WHERE id = ?").get(command.id) as Record<string, SQLInputValue>;
        insertNoteRevision(database, {
          noteId: command.id, revision: Number(note.revision), baseRevision: command.expectedRevision,
          operation: "update", title: String(note.title), bodyMarkdown: String(note.bodyMarkdown),
          actor: command.actor, changeSummary: command.changeSummary, createdAt: command.updatedAt,
        });
      });
      return;
    }
    case "note.delete": {
      database.transaction(() => {
        const note = database.connection.prepare("SELECT title, body_markdown AS bodyMarkdown FROM personal_notes WHERE id = ? AND revision = ?")
          .get(command.id, command.expectedRevision) as Record<string, SQLInputValue> | undefined;
        if (note === undefined) throw noteWriteError(database, command.id);
        insertNoteRevision(database, {
          noteId: command.id, revision: command.expectedRevision + 1, baseRevision: command.expectedRevision,
          operation: "delete", title: String(note.title), bodyMarkdown: String(note.bodyMarkdown),
          actor: command.actor, changeSummary: command.changeSummary, createdAt: command.deletedAt,
        });
        const result = database.connection.prepare("DELETE FROM personal_notes WHERE id = ? AND revision = ?").run(command.id, command.expectedRevision);
        if (Number(result.changes) === 0) throw noteWriteError(database, command.id);
        removeKnowledgeReference(database, command.id);
      });
      return;
    }
    case "note.reorder": {
      database.transaction(() => {
        const update = database.connection.prepare("UPDATE personal_notes SET position = ? WHERE id = ?");
        const existing = database.connection.prepare("SELECT id FROM personal_notes ORDER BY position, id").all()
          .map((row) => String((row as Record<string, SQLInputValue>).id));
        const existingSet = new Set(existing);
        const seen = new Set<string>();
        const ordered = command.orderedIds.filter((id) => existingSet.has(id) && !seen.has(id) && seen.add(id));
        ordered.push(...existing.filter((id) => !seen.has(id)));
        ordered.forEach((id, index) => update.run(index, id));
      });
      return;
    }
    case "knowledge.collect":
      if (command.page.kind === "note" && database.connection.prepare("SELECT 1 FROM personal_notes WHERE id = ?").get(command.page.refId) === undefined) {
        throw new PersonalKnowledgeError("personal_note_not_found", `Note ${command.page.refId} was not found.`);
      }
      if (command.page.kind !== "space_reference") {
        const existing = database.connection.prepare(
          "SELECT asset_json AS assetJson FROM knowledge_pages WHERE ref_id = ?",
        ).get(command.page.refId) as Record<string, SQLInputValue> | undefined;
        if (existing?.assetJson !== null && existing?.assetJson !== undefined) {
          throw new PersonalKnowledgeError(
            "personal_knowledge_invalid_input",
            `Managed knowledge asset ${command.page.refId} cannot be reclassified.`,
          );
        }
      }
      database.connection.prepare(`
        INSERT INTO knowledge_pages(ref_id, kind, collected_at, asset_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(ref_id) DO UPDATE SET
          kind = excluded.kind,
          collected_at = excluded.collected_at,
          asset_json = COALESCE(excluded.asset_json, knowledge_pages.asset_json)
      `).run(command.page.refId, command.page.kind, command.page.collectedAt, command.page.asset === undefined ? null : JSON.stringify(command.page.asset));
      return;
    case "knowledge.uncollect":
      database.transaction(() => removeKnowledgeReference(database, command.refId));
      return;
    case "space.cleanup":
      cleanupSpace(database, command.spaceId, command.referenceIds);
      return;
    case "knowledge.link_add":
      requireKnowledgePages(database, command.link.from, command.link.to);
      database.connection.prepare("INSERT OR IGNORE INTO knowledge_links(from_ref_id, to_ref_id) VALUES (?, ?)")
        .run(command.link.from, command.link.to);
      return;
    case "knowledge.link_remove":
      database.connection.prepare("DELETE FROM knowledge_links WHERE from_ref_id = ? AND to_ref_id = ?")
        .run(command.link.from, command.link.to);
      return;
    case "knowledge.opened":
      requireKnowledgePages(database, command.refId);
      database.connection.prepare(`
        INSERT INTO knowledge_recently_opened(ref_id, opened_at) VALUES (?, ?)
        ON CONFLICT(ref_id) DO UPDATE SET opened_at = excluded.opened_at
      `).run(command.refId, command.openedAt);
      return;
    case "theme.create":
      database.connection.prepare("INSERT INTO knowledge_themes(id, name, color, origin) VALUES (?, ?, ?, ?)")
        .run(command.theme.id, command.theme.name, command.theme.color, command.theme.origin);
      return;
    case "theme.replace":
      database.connection.prepare(`
        INSERT INTO knowledge_themes(id, name, color, origin) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, origin = excluded.origin
      `).run(command.theme.id, command.theme.name, command.theme.color, command.theme.origin);
      return;
    case "theme.rename": {
      const result = database.connection.prepare("UPDATE knowledge_themes SET name = ? WHERE id = ?").run(command.name, command.themeId);
      if (Number(result.changes) === 0) throw new PersonalKnowledgeError("knowledge_theme_not_found", `Theme ${command.themeId} was not found.`);
      return;
    }
    case "theme.delete":
      database.connection.prepare("DELETE FROM knowledge_themes WHERE id = ?").run(command.themeId);
      return;
    case "theme.merge":
      database.transaction(() => {
        const found = database.connection.prepare("SELECT 1 FROM knowledge_themes WHERE id = ?").get(command.toId);
        if (found === undefined) throw new PersonalKnowledgeError("knowledge_theme_not_found", `Theme ${command.toId} was not found.`);
        database.connection.prepare(`
          INSERT INTO knowledge_theme_assignments(ref_id, theme_id, assigned_by, locked)
          SELECT ref_id, ?, assigned_by, locked FROM knowledge_theme_assignments WHERE theme_id = ?
          ON CONFLICT(ref_id, theme_id) DO UPDATE SET
            locked = MAX(knowledge_theme_assignments.locked, excluded.locked),
            assigned_by = CASE WHEN excluded.assigned_by = 'user' THEN 'user' ELSE knowledge_theme_assignments.assigned_by END
        `).run(command.toId, command.fromId);
        database.connection.prepare("DELETE FROM knowledge_themes WHERE id = ?").run(command.fromId);
      });
      return;
    case "theme.assign":
      requireKnowledgePages(database, command.assignment.refId);
      database.connection.prepare(`
        INSERT OR IGNORE INTO knowledge_theme_assignments(ref_id, theme_id, assigned_by, locked)
        VALUES (?, ?, ?, ?)
      `).run(command.assignment.refId, command.assignment.themeId, command.assignment.by, command.assignment.locked ? 1 : 0);
      return;
    case "theme.unassign":
      database.connection.prepare("DELETE FROM knowledge_theme_assignments WHERE ref_id = ? AND theme_id = ?")
        .run(command.refId, command.themeId);
      return;
    case "theme.toggle_lock":
      database.connection.prepare("UPDATE knowledge_theme_assignments SET locked = CASE locked WHEN 1 THEN 0 ELSE 1 END WHERE ref_id = ? AND theme_id = ?")
        .run(command.refId, command.themeId);
      return;
  }
}

function cleanupSpace(database: SqliteRuntimeDatabase, spaceId: string, referenceIds: readonly string[]): void {
  const sourceReferenceIds = new Set(referenceIds);
  database.transaction(() => {
    database.connection.prepare("UPDATE personal_notes SET space_id = NULL WHERE space_id = ?").run(spaceId);

    if (sourceReferenceIds.size === 0) return;
    const pages = database.connection.prepare(
      "SELECT ref_id AS refId, asset_json AS assetJson FROM knowledge_pages WHERE asset_json IS NOT NULL",
    ).all();
    const update = database.connection.prepare("UPDATE knowledge_pages SET asset_json = ? WHERE ref_id = ?");
    for (const row of pages) {
      const value = row as Record<string, SQLInputValue>;
      const rawAsset = value.assetJson === null ? undefined : JSON.parse(String(value.assetJson)) as unknown;
      if (!isRecord(rawAsset)) continue;
      const sourceReferenceId = typeof rawAsset.sourceReferenceId === "string" ? rawAsset.sourceReferenceId : undefined;
      if (sourceReferenceId === undefined || !sourceReferenceIds.has(sourceReferenceId)) continue;
      const { sourceReferenceId: _sourceReferenceId, sourceRelativePath: _sourceRelativePath, ...detachedAsset } = rawAsset;
      update.run(JSON.stringify(detachedAsset), String(value.refId));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function removeKnowledgeReference(database: SqliteRuntimeDatabase, refId: string): void {
  database.connection.prepare("DELETE FROM knowledge_pages WHERE ref_id = ?").run(refId);
  database.connection.prepare("DELETE FROM knowledge_links WHERE from_ref_id = ? OR to_ref_id = ?").run(refId, refId);
  database.connection.prepare("DELETE FROM knowledge_theme_assignments WHERE ref_id = ?").run(refId);
  database.connection.prepare("DELETE FROM knowledge_recently_opened WHERE ref_id = ?").run(refId);
}

function requireKnowledgePages(database: SqliteRuntimeDatabase, ...refIds: readonly string[]): void {
  const lookup = database.connection.prepare("SELECT 1 FROM knowledge_pages WHERE ref_id = ?");
  for (const refId of refIds) {
    if (lookup.get(refId) === undefined) {
      throw new PersonalKnowledgeError("personal_knowledge_invalid_input", `Knowledge page ${refId} was not found.`);
    }
  }
}

function requireTheme(database: SqliteRuntimeDatabase, themeId: string): void {
  if (database.connection.prepare("SELECT 1 FROM knowledge_themes WHERE id = ?").get(themeId) === undefined) {
    throw new PersonalKnowledgeError("knowledge_theme_not_found", `Theme ${themeId} was not found.`);
  }
}

function parsePageCursor(value: string): { readonly collectedAt: number; readonly refId: string } {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed === "object" && parsed !== null
    && typeof (parsed as Record<string, unknown>).collectedAt === "number"
    && typeof (parsed as Record<string, unknown>).refId === "string") {
    return { collectedAt: (parsed as Record<string, number>).collectedAt, refId: (parsed as Record<string, string>).refId };
  }
  throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "cursor is invalid.");
}

function parseChangeCursor(value: string): { readonly occurredAt: number; readonly id: string } {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed === "object" && parsed !== null
    && typeof (parsed as Record<string, unknown>).occurredAt === "number"
    && typeof (parsed as Record<string, unknown>).id === "string") {
    return { occurredAt: (parsed as Record<string, number>).occurredAt, id: (parsed as Record<string, string>).id };
  }
  throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "cursor is invalid.");
}

type ChangeRecordRow = {
  readonly type: PersonalKnowledgeChangeRecord["type"];
  readonly refId?: string;
  readonly themeId?: string;
  readonly payload: Record<string, unknown>;
  readonly actor: PersonalKnowledgeChangeRecord["actor"];
  readonly occurredAt: number;
};

function changeRecordPayload(record: PersonalKnowledgeChangeRecord): { readonly refId?: string; readonly themeId?: string; readonly rest: Record<string, unknown> } {
  switch (record.type) {
    case "knowledge.asset_updated":
      return { refId: record.refId, rest: { relativePath: record.relativePath, beforeFingerprint: record.beforeFingerprint, afterFingerprint: record.afterFingerprint } };
    case "knowledge.uncollected":
      return { refId: record.refId, rest: { kind: record.kind } };
    case "knowledge.theme_created":
      return { themeId: record.themeId, rest: { name: record.name } };
    case "knowledge.theme_assigned":
    case "knowledge.theme_unassigned":
      return { themeId: record.themeId, rest: { refIds: record.refIds } };
  }
}

function changeRecordFromRow(value: Record<string, SQLInputValue>): PersonalKnowledgeChangeRecord {
  const row: ChangeRecordRow = {
    type: String(value.type) as PersonalKnowledgeChangeRecord["type"],
    ...(value.refId === null ? {} : { refId: String(value.refId) }),
    ...(value.themeId === null ? {} : { themeId: String(value.themeId) }),
    payload: JSON.parse(String(value.payloadJson)) as Record<string, unknown>,
    actor: {
      kind: String(value.actorKind) as PersonalKnowledgeChangeRecord["actor"]["kind"],
      ...(value.actorId === null ? {} : { actorId: String(value.actorId) }),
      ...(value.traceId === null ? {} : { traceId: String(value.traceId) }),
      ...(value.goalId === null ? {} : { goalId: String(value.goalId) }),
      ...(value.toolCallId === null ? {} : { toolCallId: String(value.toolCallId) }),
    },
    occurredAt: Number(value.occurredAt),
  };
  const id = String(value.id);
  const actor = row.actor;
  const occurredAt = row.occurredAt;
  switch (row.type) {
    case "knowledge.asset_updated":
      return { id, type: row.type, refId: requiredValue(row.refId), relativePath: String(row.payload.relativePath), beforeFingerprint: String(row.payload.beforeFingerprint), afterFingerprint: String(row.payload.afterFingerprint), actor, occurredAt };
    case "knowledge.uncollected":
      return { id, type: row.type, refId: requiredValue(row.refId), kind: row.payload.kind as KnowledgePage["kind"], actor, occurredAt };
    case "knowledge.theme_created":
      return { id, type: row.type, themeId: requiredValue(row.themeId), name: String(row.payload.name), actor, occurredAt };
    case "knowledge.theme_assigned":
    case "knowledge.theme_unassigned":
      return { id, type: row.type, themeId: requiredValue(row.themeId), refIds: row.payload.refIds as readonly string[], actor, occurredAt };
  }
}

function requiredValue(value: string | undefined): string {
  if (value === undefined) throw new Error("knowledge_change_records row is missing a required value.");
  return value;
}

function recordRefId(record: PersonalKnowledgeChangeRecord): string | undefined {
  return "refId" in record ? record.refId : undefined;
}

function recordThemeId(record: PersonalKnowledgeChangeRecord): string | undefined {
  return "themeId" in record ? record.themeId : undefined;
}

function noteWriteError(database: SqliteRuntimeDatabase, id: string): PersonalKnowledgeError {
  const exists = database.connection.prepare("SELECT 1 FROM personal_notes WHERE id = ?").get(id) !== undefined;
  return exists
    ? new PersonalKnowledgeError("personal_note_revision_conflict", `Note ${id} has changed since it was read.`)
    : new PersonalKnowledgeError("personal_note_not_found", `Note ${id} was not found.`);
}

function personalNoteFromRow(value: Record<string, SQLInputValue>): PersonalNote {
  return {
    id: String(value.id),
    ...(value.spaceId === null ? {} : { spaceId: String(value.spaceId) }),
    title: String(value.title),
    bodyMarkdown: String(value.bodyMarkdown),
    revision: Number(value.revision),
    createdAt: Number(value.createdAt),
    updatedAt: Number(value.updatedAt),
  };
}

function personalNoteRevisionFromRow(value: Record<string, SQLInputValue>): PersonalNoteRevision {
  return {
    noteId: String(value.noteId),
    revision: Number(value.revision),
    ...(value.baseRevision === null ? {} : { baseRevision: Number(value.baseRevision) }),
    operation: String(value.operation) as PersonalNoteRevision["operation"],
    title: String(value.title),
    bodyMarkdown: String(value.bodyMarkdown),
    actor: {
      kind: String(value.actorKind) as PersonalNoteRevision["actor"]["kind"],
      ...(value.actorId === null ? {} : { actorId: String(value.actorId) }),
      ...(value.traceId === null ? {} : { traceId: String(value.traceId) }),
      ...(value.goalId === null ? {} : { goalId: String(value.goalId) }),
      ...(value.toolCallId === null ? {} : { toolCallId: String(value.toolCallId) }),
    },
    ...(value.changeSummary === null ? {} : { changeSummary: String(value.changeSummary) }),
    createdAt: Number(value.createdAt),
  };
}

function insertNoteRevision(database: SqliteRuntimeDatabase, revision: PersonalNoteRevision): void {
  database.connection.prepare(`
    INSERT INTO personal_note_revisions(
      note_id, revision, base_revision, operation, title, body_markdown,
      actor_kind, actor_id, trace_id, goal_id, tool_call_id, change_summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision.noteId, revision.revision, revision.baseRevision ?? null, revision.operation,
    revision.title, revision.bodyMarkdown, revision.actor.kind, revision.actor.actorId ?? null,
    revision.actor.traceId ?? null, revision.actor.goalId ?? null, revision.actor.toolCallId ?? null,
    revision.changeSummary ?? null, revision.createdAt,
  );
}

function searchResultFromRow(value: Record<string, SQLInputValue>): PersonalKnowledgeSearchResult {
  return {
    note: {
      id: String(value.id),
      ...(value.spaceId === null ? {} : { spaceId: String(value.spaceId) }),
      title: String(value.title),
      revision: Number(value.revision),
      createdAt: Number(value.createdAt),
      updatedAt: Number(value.updatedAt),
    },
    snippet: String(value.snippet),
  };
}

function ftsQuery(query: string): string {
  return query.trim().split(/\s+/u)
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(" AND ");
}

function likePattern(query: string): string {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function repositoryError(message: string, cause: unknown): PersonalKnowledgeError {
  return new PersonalKnowledgeError("personal_knowledge_repository_failure", message, { cause });
}
