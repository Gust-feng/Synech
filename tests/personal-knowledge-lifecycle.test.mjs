import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  createPersonalKnowledgeFeature,
  createSqlitePersonalKnowledgeRepository,
} from "../dist/app/personal-knowledge/index.js";

test("Space cleanup detaches Knowledge without deleting notes or relationships", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-knowledge-lifecycle-"));
  const database = new SqliteRuntimeDatabase(path.join(directory, "knowledge.sqlite3"));
  const repository = createSqlitePersonalKnowledgeRepository(database);
  const feature = createPersonalKnowledgeFeature({
    repository,
    spaceExists: async (spaceId) => spaceId === "space-1",
  });
  t.after(async () => {
    await feature.release();
    database.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const note = await feature.commands.createNote({
    id: "note-1",
    spaceId: "space-1",
    title: "Durable knowledge",
    bodyMarkdown: "Keep this after deleting the Space.",
    actor: { kind: "user" },
  });
  await feature.commands.execute({
    type: "knowledge.collect",
    page: { refId: note.id, kind: "note", collectedAt: 1 },
  });
  await repository.execute({
    type: "knowledge.collect",
    page: {
      refId: "asset-1",
      kind: "space_reference",
      collectedAt: 2,
      asset: {
        status: "managed",
        title: "Captured source",
        sourceLabel: "Space source",
        contentKind: "file",
        sourceReferenceId: "reference-1",
        sourceRelativePath: "notes.md",
      },
    },
  });
  await feature.commands.execute({ type: "knowledge.link_add", link: { from: note.id, to: "asset-1" } });
  const { theme } = await feature.commands.createTheme({ name: "Architecture", actor: { kind: "user" } });
  await feature.commands.assignTheme({ themeId: theme.id, refIds: [note.id], actor: { kind: "user" } });
  await feature.commands.execute({ type: "knowledge.opened", refId: note.id, openedAt: 3 });

  await feature.commands.cleanupSpace({ spaceId: "space-1", referenceIds: ["reference-1"] });

  const snapshot = await feature.queries.snapshot();
  const detachedNote = snapshot.notes.find((candidate) => candidate.id === note.id);
  assert.equal(detachedNote?.spaceId, undefined);
  assert.equal(detachedNote?.bodyMarkdown, note.bodyMarkdown);
  assert.equal((await feature.queries.noteRevisions(note.id)).length, 1);
  assert.deepEqual(snapshot.links.map((link) => ({ from: link.from, to: link.to })), [{ from: note.id, to: "asset-1" }]);
  assert.equal(snapshot.assignments.some((assignment) => assignment.refId === note.id && assignment.themeId === theme.id), true);
  assert.equal(snapshot.recentlyOpened[note.id], 3);
  assert.equal(snapshot.pages.find((page) => page.refId === "asset-1")?.asset?.sourceReferenceId, undefined);
  assert.equal(snapshot.pages.find((page) => page.refId === "asset-1")?.asset?.sourceRelativePath, undefined);
});

test("Personal Knowledge accepts an unassigned note", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-unassigned-note-"));
  const database = new SqliteRuntimeDatabase(path.join(directory, "knowledge.sqlite3"));
  const feature = createPersonalKnowledgeFeature({
    repository: createSqlitePersonalKnowledgeRepository(database),
    spaceExists: async () => false,
  });
  t.after(async () => {
    await feature.release();
    database.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const note = await feature.commands.createNote({ title: "Global note", actor: { kind: "user" } });
  assert.equal(note.spaceId, undefined);
  assert.equal((await feature.queries.note(note.id))?.spaceId, undefined);
});
