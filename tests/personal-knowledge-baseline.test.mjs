import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/sqlite-runtime-database.js";
import {
  createPersonalKnowledgeFeature,
  createSqlitePersonalKnowledgeRepository,
} from "../dist/app/personal-knowledge/index.js";

test("Knowledge notes may be unassigned and Space cleanup detaches without deleting content", async () => {
  await withTemporaryDirectory(async (directory) => {
    const database = new SqliteRuntimeDatabase(path.join(directory, "knowledge.sqlite3"));
    const feature = createPersonalKnowledgeFeature({
      repository: createSqlitePersonalKnowledgeRepository(database),
      async spaceExists() { return true; },
    });
    try {
      const unassigned = await feature.commands.createNote({ id: "note-unassigned", title: "Independent" });
      assert.equal(unassigned.spaceId, undefined);

      const assigned = await feature.commands.createNote({ id: "note-space", spaceId: "space-1", title: "Keep me" });
      await feature.commands.execute({
        type: "knowledge.collect",
        page: { refId: assigned.id, kind: "note", collectedAt: 1 },
      });
      await feature.commands.cleanupSpace({ spaceId: "space-1", referenceIds: [] });

      const snapshot = await feature.queries.snapshot();
      assert.equal(snapshot.notes.find((note) => note.id === assigned.id)?.spaceId, undefined);
      assert.equal(snapshot.pages.some((page) => page.refId === assigned.id), true);
      assert.equal(await feature.queries.note(assigned.id) !== undefined, true);
    } finally {
      await feature.release();
      database.close();
    }
  });
});

async function withTemporaryDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-knowledge-baseline-"));
  try { await operation(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
