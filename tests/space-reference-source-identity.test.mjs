import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeText } from "../dist/app/local-filesystem/local-filesystem-write.js";
import {
  SPACE_TREE_SCHEMA_VERSION,
  createSpaceFeature,
  inspectSpaceExternalSource,
  spaceExternalReferenceStatus,
} from "../dist/app/spaces/index.js";

test("a Synech write refreshes the captured identity of a linked local file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-space-source-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "note.txt");
  await fs.writeFile(filePath, "before", "utf8");
  const repository = memorySpaceRepository();
  const feature = createSpaceFeature({
    repository,
    externalSourceInspector: inspectSpaceExternalSource,
    idFactory: () => "generated-id",
    now: increasingClock(),
  });
  t.after(async () => await feature.release());
  await feature.ready();
  await feature.commands.createSpace({ id: "space-1", title: "Space" });
  const original = await feature.commands.addReference({
    id: "reference-1",
    spaceId: "space-1",
    title: "note.txt",
    reference: { kind: "local_file", path: filePath },
    actor: { kind: "user" },
  });

  assert.equal((await writeText(filePath, "after")).ok, true);
  assert.equal(await spaceExternalReferenceStatus(original), "replaced");

  const refreshed = await feature.commands.refreshReferenceSourceIdentity(original.id);
  assert.notEqual(refreshed.sourceIdentity, original.sourceIdentity);
  assert.equal(await spaceExternalReferenceStatus(refreshed), "current");
  assert.equal((await feature.queries.getReference(original.id))?.sourceIdentity, refreshed.sourceIdentity);
});

function memorySpaceRepository() {
  let snapshot = { schemaVersion: SPACE_TREE_SCHEMA_VERSION, spaces: [], referenceItems: [] };
  return {
    async read() { return structuredClone(snapshot); },
    async write(next) { snapshot = structuredClone(next); },
  };
}

function increasingClock() {
  let seconds = 0;
  return () => `2026-01-01T00:00:${String(seconds++).padStart(2, "0")}.000Z`;
}
