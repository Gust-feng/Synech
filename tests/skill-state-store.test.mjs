import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FileSystemSkillStateStore,
  SkillStateStoreError,
} from "../dist/app/skills/skill-state-store.js";

test("SkillStateStore serializes concurrent updates and publishes one atomic file", async () => {
  const fixture = await skillStateFixture();
  try {
    const usedAt = "2026-08-25T00:00:00.000Z";
    await Promise.all([
      fixture.store.setEnabled("source:project:review", false, {
        skillId: "review",
        sourceKind: "project",
        sourceRootId: "project",
      }),
      fixture.store.markUsed("source:project:review", usedAt, {
        skillId: "review",
        sourceKind: "project",
        sourceRootId: "project",
      }),
    ]);

    assert.deepEqual((await fixture.store.readStates()).get("source:project:review"), {
      skillId: "review",
      stateKey: "source:project:review",
      sourceKind: "project",
      sourceRootId: "project",
      enabled: false,
      lastUsedAt: usedAt,
    });
    assert.deepEqual(await readdir(fixture.directory), ["skills-state.json"]);
  } finally {
    await fixture.release();
  }
});

test("SkillStateStore retains every skill updated concurrently", async () => {
  const fixture = await skillStateFixture();
  try {
    await Promise.all([
      fixture.store.markUsed("skill-a", "2026-01-01T00:00:00.000Z", { skillId: "a" }),
      fixture.store.markUsed("skill-b", "2026-01-01T00:00:01.000Z", { skillId: "b" }),
    ]);

    assert.deepEqual([...((await fixture.store.readStates()).keys())].sort(), ["skill-a", "skill-b"]);
  } finally {
    await fixture.release();
  }
});

test("SkillStateStore preserves and reports a corrupt state file", async () => {
  const fixture = await skillStateFixture();
  try {
    const corrupt = '{"version":1,"skills":[';
    await writeFile(fixture.filePath, corrupt, "utf8");

    await assert.rejects(
      fixture.store.setEnabled("source:project:review", false),
      (error) => error instanceof SkillStateStoreError && error.code === "skill_state_invalid",
    );
    assert.equal(await readFile(fixture.filePath, "utf8"), corrupt);
  } finally {
    await fixture.release();
  }
});

async function skillStateFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synech-skill-state-"));
  const filePath = path.join(directory, "skills-state.json");
  return {
    directory,
    filePath,
    store: new FileSystemSkillStateStore(filePath),
    release: () => rm(directory, { recursive: true, force: true }),
  };
}
