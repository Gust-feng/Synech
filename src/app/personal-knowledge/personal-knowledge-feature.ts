import { randomUUID } from "node:crypto";

import {
  PersonalKnowledgeError,
  type PersonalKnowledgeCommand,
  type PersonalKnowledgeEvent,
  type PersonalKnowledgeFeature,
  type KnowledgePage,
  type KnowledgePageReadResult,
  type KnowledgeListQuery,
  type ManagedKnowledgeAssetReadPort,
  type PersonalKnowledgeRepository,
} from "./contracts.js";

export function createPersonalKnowledgeFeature<TManagedAssetTextWriteResult extends { readonly fingerprint?: string } = { readonly fingerprint?: string }>(options: {
  readonly repository: PersonalKnowledgeRepository;
  readonly spaceExists: (spaceId: string) => Promise<boolean>;
  readonly captureSpaceReference?: (input: { readonly assetId: string; readonly referenceId: string; readonly relativePath: string }) => Promise<NonNullable<import("./contracts.js").KnowledgePage["asset"]> | undefined>;
  readonly removeManagedAsset?: (itemId: string) => Promise<void>;
  readonly stageManagedAssetRemoval?: (itemId: string) => Promise<{
    readonly commit: () => Promise<void>;
    readonly rollback: () => Promise<void>;
  } | undefined>;
  readonly runManagedAssetMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly writeManagedAssetText?: (input: {
    readonly page: KnowledgePage;
    readonly relativePath: string;
    readonly expectedFingerprint: string;
    readonly text: string;
  }) => Promise<TManagedAssetTextWriteResult>;
  readonly readManagedKnowledgeAsset?: ManagedKnowledgeAssetReadPort;
}): PersonalKnowledgeFeature<TManagedAssetTextWriteResult> {
  const repository = options.repository;
  let released = false;
  let queue = Promise.resolve();
  const listeners = new Set<(event: PersonalKnowledgeEvent) => void>();

  const ensureActive = (): void => {
    if (released) throw new PersonalKnowledgeError("personal_knowledge_released", "Personal knowledge feature is released.");
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    ensureActive();
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return await result;
  };
  const runManagedAssetMutation = async <T>(operation: () => Promise<T>): Promise<T> =>
    options.runManagedAssetMutation === undefined ? await operation() : await options.runManagedAssetMutation(operation);
  const publish = (event: PersonalKnowledgeEvent): void => {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* Observers cannot change the committed knowledge command result. */ }
    }
  };

  return {
    commands: {
      async createNote(noteInput) {
        return await run(async () => {
          const spaceId = noteInput.spaceId === undefined ? undefined : required(noteInput.spaceId, "spaceId");
          if (spaceId !== undefined && !await options.spaceExists(spaceId)) {
            throw new PersonalKnowledgeError("personal_knowledge_invalid_input", `Space ${spaceId} does not exist.`);
          }
          const now = Date.now();
          const note = {
            id: noteInput.id === undefined ? randomUUID() : required(noteInput.id, "id"),
            ...(spaceId === undefined ? {} : { spaceId }),
            title: noteInput.title ?? "",
            bodyMarkdown: noteInput.bodyMarkdown ?? "",
            createdAt: now,
            updatedAt: now,
            revision: 1,
          };
          await repository.execute({ type: "note.create", note, actor: noteInput.actor ?? SYSTEM_ACTOR, changeSummary: noteInput.changeSummary });
          publish({
            type: "personal_knowledge.note_created",
            noteId: note.id,
            ...(note.spaceId === undefined ? {} : { spaceId: note.spaceId }),
          });
          return note;
        });
      },
      async updateNote(input) {
        await run(async () => {
          const id = required(input.id, "id");
          await repository.execute({
            type: "note.update",
            id,
            expectedRevision: input.expectedRevision,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.bodyMarkdown === undefined ? {} : { bodyMarkdown: input.bodyMarkdown }),
            updatedAt: Date.now(),
            actor: input.actor ?? SYSTEM_ACTOR,
            changeSummary: input.changeSummary,
          });
          publish({ type: "personal_knowledge.note_updated", noteId: id });
        });
      },
      async restoreNote(input) {
        await run(async () => {
          const id = required(input.id, "id");
          const expectedRevision = positiveRevision(input.expectedRevision, "expectedRevision");
          const targetRevision = positiveRevision(input.targetRevision, "targetRevision");
          if (targetRevision === expectedRevision) {
            throw new PersonalKnowledgeError(
              "personal_knowledge_invalid_input",
              "targetRevision must differ from the current revision.",
            );
          }
          const target = await repository.getNoteRevision(id, targetRevision);
          if (target === undefined) {
            throw new PersonalKnowledgeError(
              "personal_note_not_found",
              `Revision ${targetRevision} of note ${id} does not exist.`,
            );
          }
          await repository.execute({
            type: "note.update",
            id,
            expectedRevision,
            title: target.title,
            bodyMarkdown: target.bodyMarkdown,
            updatedAt: Date.now(),
            actor: input.actor ?? SYSTEM_ACTOR,
            changeSummary: input.changeSummary ?? `恢复到版本 ${targetRevision} 的内容`,
          });
          publish({ type: "personal_knowledge.note_updated", noteId: id });
        });
      },
      async deleteNote(input) {
        await run(async () => {
          const id = required(input.id, "id");
          await repository.execute({
            type: "note.delete",
            id,
            expectedRevision: input.expectedRevision,
            deletedAt: Date.now(),
            actor: input.actor ?? SYSTEM_ACTOR,
            changeSummary: input.changeSummary,
          });
          publish({ type: "personal_knowledge.note_deleted", noteId: id });
        });
      },
      async reorderNotes(orderedIds) {
        await run(async () => {
          await repository.execute({ type: "note.reorder", orderedIds });
          publish({ type: "personal_knowledge.changed" });
        });
      },
      async collectSpaceReference(input) {
        return await run(() => runManagedAssetMutation(async () => {
          const referenceId = required(input.referenceId, "referenceId");
          const relativePath = normalizeSpaceReferenceRelativePath(input.relativePath);
          if (options.captureSpaceReference === undefined) {
            throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "Managed knowledge asset storage is unavailable.");
          }
          const existing = (await repository.readSnapshot()).pages.find((page) => page.kind === "space_reference"
            && page.asset?.sourceReferenceId === referenceId
            && page.asset.sourceRelativePath === relativePath);
          if (existing !== undefined) return existing;
          const refId = randomUUID();
          const asset = await options.captureSpaceReference({ assetId: refId, referenceId, relativePath });
          if (asset === undefined) {
            throw new PersonalKnowledgeError("personal_knowledge_invalid_input", `Space reference ${referenceId} does not exist.`);
          }
          const page = { refId, kind: "space_reference" as const, collectedAt: Date.now(), asset };
          try {
            await repository.execute({ type: "knowledge.collect", page });
          } catch (error) {
            await options.removeManagedAsset?.(refId);
            throw error;
          }
          publish({ type: "personal_knowledge.changed", refIds: [page.refId] });
          return page;
        }));
      },
      async updateManagedAssetText(input) {
        return await run(async () => {
          const refId = required(input.refId, "refId");
          const page = (await repository.readSnapshot()).pages.find((candidate) => candidate.refId === refId);
          if (page === undefined) {
            throw new PersonalKnowledgeError("knowledge_asset_not_found", "知识条目已不存在。");
          }
          if (page.asset?.status !== "managed") {
            throw new PersonalKnowledgeError("knowledge_asset_not_found", "这条旧知识尚未生成托管副本。");
          }
          if (options.writeManagedAssetText === undefined) {
            throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "Managed knowledge asset storage is unavailable.");
          }
          const writeResult = await options.writeManagedAssetText({
            page,
            relativePath: input.relativePath,
            expectedFingerprint: input.expectedFingerprint,
            text: input.text,
          });
          const actor = input.actor ?? SYSTEM_ACTOR;
          // 写入端口在成功时总是报告新指纹；缺失指纹时跳过审计记录而不是伪造事实。
          if (typeof writeResult.fingerprint === "string") {
            await repository.appendChangeRecord({
              id: randomUUID(),
              type: "knowledge.asset_updated",
              refId,
              relativePath: input.relativePath,
              beforeFingerprint: input.expectedFingerprint,
              afterFingerprint: writeResult.fingerprint,
              actor,
              occurredAt: Date.now(),
            });
          }
          publish({ type: "personal_knowledge.changed", refIds: [refId] });
          return { page, writeResult };
        });
      },
      async cleanupSpace(input) {
        await run(async () => {
          const referenceIds = [...new Set(input.referenceIds.map((value) => required(value, "referenceId")))];
          const spaceId = required(input.spaceId, "spaceId");
          const sourceReferenceIdSet = new Set(referenceIds);
          const snapshot = await repository.readSnapshot();
          const affectedPageIds = snapshot.pages
            .filter((page) => {
              if (page.asset?.status === "managed") {
                return page.asset?.sourceReferenceId !== undefined && sourceReferenceIdSet.has(page.asset.sourceReferenceId);
              }
              return snapshot.notes.some((note) => note.spaceId === spaceId && note.id === page.refId);
            })
            .map((page) => page.refId);
          await repository.execute({ type: "space.cleanup", spaceId, referenceIds });
          publish({
            type: "personal_knowledge.changed",
            ...(affectedPageIds.length === 0 ? {} : { refIds: affectedPageIds }),
          });
        });
      },
      async uncollect(refIdInput, actor) {
        return await run(() => runManagedAssetMutation(async () => {
          const refId = required(refIdInput, "refId");
          const page = (await repository.readSnapshot()).pages.find((candidate) => candidate.refId === refId);
          if (page === undefined) {
            throw new PersonalKnowledgeError("knowledge_asset_not_found", "知识条目已不存在。");
          }
          const staged = await options.stageManagedAssetRemoval?.(refId);
          try {
            await repository.execute({ type: "knowledge.uncollect", refId });
          } catch (error) {
            await staged?.rollback();
            throw error;
          }
          await staged?.commit();
          await repository.appendChangeRecord({
            id: randomUUID(),
            type: "knowledge.uncollected",
            refId,
            kind: page.kind,
            actor: actor ?? SYSTEM_ACTOR,
            occurredAt: Date.now(),
          });
          publish({ type: "personal_knowledge.changed", refIds: [refId] });
          return { managedCopyRemoved: staged !== undefined };
        }));
      },
      async createTheme(input) {
        return await run(async () => {
          const name = required(input.name, "name");
          const normalized = normalizeThemeName(name);
          const snapshot = await repository.readSnapshot();
          const existing = snapshot.themes.find((theme) => normalizeThemeName(theme.name) === normalized);
          if (existing !== undefined) return { theme: existing, created: false };
          const theme = {
            id: randomUUID(),
            name,
            color: themeColorFor(snapshot.themes.length),
            origin: input.actor.kind === "user" ? "user" as const : "agent" as const,
          };
          await repository.execute({ type: "theme.create", theme });
          await repository.appendChangeRecord({
            id: randomUUID(),
            type: "knowledge.theme_created",
            themeId: theme.id,
            name: theme.name,
            actor: input.actor,
            occurredAt: Date.now(),
          });
          publish({ type: "personal_knowledge.changed" });
          return { theme, created: true };
        });
      },
      async assignTheme(input) {
        return await run(async () => {
          const themeId = required(input.themeId, "themeId");
          const refIds = uniqueRefIds(input.refIds);
          const result = await repository.assignTheme({ themeId, refIds, by: input.actor.kind === "user" ? "user" : "agent" });
          if (result.assigned.length > 0) {
            await repository.appendChangeRecord({
              id: randomUUID(),
              type: "knowledge.theme_assigned",
              themeId,
              refIds: result.assigned,
              actor: input.actor,
              occurredAt: Date.now(),
            });
            publish({ type: "personal_knowledge.changed", refIds: result.assigned });
          }
          return { themeId, assigned: result.assigned, unchanged: result.unchanged };
        });
      },
      async unassignTheme(input) {
        return await run(async () => {
          const themeId = required(input.themeId, "themeId");
          const refIds = uniqueRefIds(input.refIds);
          const snapshot = await repository.readSnapshot();
          const locked = new Set(
            input.actor.kind === "agent"
              ? snapshot.assignments.filter((assignment) => assignment.themeId === themeId && assignment.locked).map((assignment) => assignment.refId)
              : [],
          );
          const unassignable = refIds.filter((refId) => !locked.has(refId));
          const lockedRefIds = refIds.filter((refId) => locked.has(refId));
          await repository.unassignTheme({ themeId, refIds: unassignable });
          if (unassignable.length > 0) {
            await repository.appendChangeRecord({
              id: randomUUID(),
              type: "knowledge.theme_unassigned",
              themeId,
              refIds: unassignable,
              actor: input.actor,
              occurredAt: Date.now(),
            });
            publish({ type: "personal_knowledge.changed", refIds: unassignable });
          }
          return { themeId, unassigned: unassignable, locked: lockedRefIds };
        });
      },
      async execute(command) {
        await run(async () => {
          const validated = validateCommand(command);
          if (validated.type === "knowledge.collect" && validated.page.kind === "space_reference") {
            throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "Space references must be collected through managed asset capture.");
          }
          await repository.execute(validated);
          publish({
            type: "personal_knowledge.changed",
            ...("refId" in validated && typeof validated.refId === "string" ? { refIds: [validated.refId] } : {}),
          });
        });
      },
    },
    queries: {
      async snapshot() {
        ensureActive();
        await queue;
        return await repository.readSnapshot();
      },
      async note(id) {
        ensureActive();
        await queue;
        return await repository.getNote(required(id, "id"));
      },
      async noteRevisions(id, limit = 50) {
        ensureActive();
        await queue;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "limit must be an integer from 1 to 200.");
        }
        return await repository.listNoteRevisions(required(id, "id"), limit);
      },
      async search(input) {
        ensureActive();
        await queue;
        const query = required(input.query, "query");
        const spaceId = input.spaceId === undefined ? undefined : required(input.spaceId, "spaceId");
        const limit = input.limit ?? 20;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "limit must be an integer from 1 to 100.");
        }
        return await repository.searchNotes({ query, spaceId, limit });
      },
      async list(input = {}) {
        ensureActive();
        await queue;
        const validated = validateListQuery(input);
        const snapshot = await repository.readSnapshot();
        const { pages, nextCursor } = await repository.listPages(validated);
        return {
          pages,
          themes: snapshot.themes,
          assignments: snapshot.assignments,
          ...(nextCursor === undefined ? {} : { nextInput: { ...validated, cursor: nextCursor } }),
        };
      },
      async readPage(input) {
        ensureActive();
        await queue;
        const refId = required(input.refId, "refId");
        const maxLength = validateMaxLength(input.maxLength);
        const page = (await repository.readSnapshot()).pages.find((candidate) => candidate.refId === refId);
        if (page === undefined) {
          // 未收藏的个人笔记同样可读：KnowledgeList 枚举全部笔记，refId 即笔记 id。
          const note = await repository.getNote(refId);
          if (note !== undefined) return readNotePage(note, maxLength, input.continuation);
          return { status: "missing", refId, message: "知识条目已不存在。" };
        }
        if (page.kind === "note") {
          const note = await repository.getNote(refId);
          if (note === undefined) return { status: "missing", refId, message: "知识条目已不存在。" };
          return readNotePage(note, maxLength, input.continuation);
        }
        if (options.readManagedKnowledgeAsset === undefined) {
          throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "Managed knowledge asset storage is unavailable.");
        }
        const relativePath = normalizeSpaceReferenceRelativePath(input.relativePath);
        // 先在此验证续读位置，避免把未规范化的 continuation 泄漏给 Host 端口。
        const continuation = input.continuation === undefined ? undefined : String(parseContinuation(input.continuation));
        const content = await options.readManagedKnowledgeAsset({
          page,
          relativePath,
          maxLength,
          continuation,
        });
        return { status: "space_reference", refId, relativePath, content };
      },
      async recentChanges(input = {}) {
        ensureActive();
        await queue;
        const limit = input.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "limit must be an integer from 1 to 200.");
        }
        const { records, nextCursor } = await repository.recentChanges({
          ...(input.refId === undefined ? {} : { refId: required(input.refId, "refId") }),
          ...(input.themeId === undefined ? {} : { themeId: required(input.themeId, "themeId") }),
          limit,
          ...(input.cursor === undefined ? {} : { cursor: required(input.cursor, "cursor") }),
        });
        return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
      },
    },
    events: {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    async release() {
      if (released) return;
      released = true;
      await queue;
      listeners.clear();
    },
  };
}

const SYSTEM_ACTOR = { kind: "system" } as const;

const THEME_COLOR_PALETTE = [
  "#6865a7",
  "#b0885a",
  "#3f7d68",
  "#a3564f",
  "#4a6fa5",
  "#8a5a9e",
  "#b08a3a",
  "#5a7d8a",
] as const;

function themeColorFor(existingThemeCount: number): string {
  return THEME_COLOR_PALETTE[existingThemeCount % THEME_COLOR_PALETTE.length] ?? THEME_COLOR_PALETTE[0];
}

function normalizeThemeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function uniqueRefIds(values: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value.trim().length === 0) {
      throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "refIds must not contain empty values.");
    }
    unique.add(value.trim());
  }
  return [...unique];
}

function readNotePage(
  note: import("./contracts.js").PersonalNote,
  maxLength: number,
  continuation: string | undefined,
): KnowledgePageReadResult {
  const offset = parseContinuation(continuation);
  const bodyMarkdown = note.bodyMarkdown.slice(offset, offset + maxLength);
  const truncated = offset + bodyMarkdown.length < note.bodyMarkdown.length;
  return {
    status: "note",
    refId: note.id,
    kind: "note",
    title: note.title,
    ...(note.spaceId === undefined ? {} : { spaceId: note.spaceId }),
    bodyMarkdown,
    truncated,
    revision: note.revision,
    ...(truncated ? { continuation: String(offset + bodyMarkdown.length) } : {}),
  };
}

function parseContinuation(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "continuation must be a non-negative integer string.");
  }
  return parsed;
}

function validateMaxLength(value: number | undefined): number {
  const maxLength = value ?? 30_000;
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 1_000_000) {
    throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "maxLength must be an integer from 1 to 1000000.");
  }
  return maxLength;
}

function validateListQuery(input: KnowledgeListQuery): KnowledgeListQuery {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "limit must be an integer from 1 to 200.");
  }
  if (input.kind !== undefined && input.kind !== "note" && input.kind !== "space_reference") {
    throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "kind must be note or space_reference.");
  }
  if (input.cursor !== undefined) parseContinuationCursor(input.cursor);
  return { ...input, limit };
}

function parseContinuationCursor(value: string): { readonly collectedAt: number; readonly refId: string } {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null
      && typeof (parsed as Record<string, unknown>).collectedAt === "number"
      && typeof (parsed as Record<string, unknown>).refId === "string") {
      return { collectedAt: (parsed as Record<string, number>).collectedAt, refId: (parsed as Record<string, string>).refId };
    }
  } catch { /* fall through to invalid input. */ }
  throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "cursor is invalid.");
}

function normalizeSpaceReferenceRelativePath(value: string | undefined): string {
  return (value ?? "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PersonalKnowledgeError("personal_knowledge_invalid_input", `${field} must not be empty.`);
  }
  return normalized;
}

function positiveRevision(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new PersonalKnowledgeError("personal_knowledge_invalid_input", `${field} must be a positive integer.`);
  }
  return value;
}

function validateCommand<T extends Exclude<PersonalKnowledgeCommand,
  { readonly type: "note.create" | "note.update" | "note.delete" | "note.reorder" | "knowledge.uncollect" }
>>(command: T): T {
  if (command.type === "knowledge.link_add" && command.link.from === command.link.to) {
    throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "A knowledge page cannot link to itself.");
  }
  if (command.type === "theme.merge" && command.fromId === command.toId) {
    throw new PersonalKnowledgeError("personal_knowledge_invalid_input", "A theme cannot be merged into itself.");
  }
  return command;
}
