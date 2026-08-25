import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { startLocalPanelServer } from "../dist/app/panel-server/index.js";
import { createSpaceFeature, createSqliteSpaceRepository } from "../dist/app/spaces/index.js";
import { resolveProductPaths } from "../dist/platform/storage/index.js";

test("a fresh Product Home receives ordinary initial Space and Knowledge content exactly once", async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const productHome = path.join(temporaryDirectory, "product");
    let server = await startLocalPanelServer({ productHome, port: 0 });
    try {
      const first = await initialContentSnapshot(server.url);
      assert.deepEqual(first.spaces.map((space) => space.id).sort(), ["space-default", "space-learning"]);
      assert.deepEqual(first.defaultTree.entries.map((entry) => entry.item.id).sort(), [
        "builtin-my-space-getting-started",
        "builtin-my-space-inspiration",
      ]);
      assert.deepEqual(first.learningTree.entries.map((entry) => entry.item.id).sort(), [
        "builtin-learning-cs231n",
        "builtin-learning-distill",
        "builtin-learning-reading-notes",
        "builtin-learning-study-materials",
      ]);

      const gettingStarted = first.defaultTree.entries.find((entry) => entry.item.id === "builtin-my-space-getting-started");
      assert.equal(gettingStarted?.item.reference.kind, "managed_folder");
      assert.equal(
        await fs.readFile(path.join(gettingStarted.item.reference.path, "Synech 快速开始.md"), "utf8")
          .then((content) => content.startsWith("# 欢迎使用 Synech")),
        true,
      );

      assert.equal(first.knowledge.notes.some((note) => note.id === "builtin-note-notebook-start"), true);
      assert.equal(first.knowledge.pages.length, 6);
      assert.equal(first.knowledge.themes.length, 4);
      assert.equal(first.knowledge.assignments.length, 7);
      assert.equal(first.knowledge.links.length, 3);
    } finally {
      await server.close();
    }

    server = await startLocalPanelServer({ productHome, port: 0 });
    try {
      const restarted = await initialContentSnapshot(server.url);
      assert.equal(restarted.spaces.length, 2);
      assert.equal(restarted.defaultTree.entries.length, 2);
      assert.equal(restarted.learningTree.entries.length, 4);
      assert.equal(restarted.knowledge.notes.filter((note) => note.id === "builtin-note-notebook-start").length, 1);
      assert.equal(restarted.knowledge.pages.length, 6);

      const deleted = await fetch(new URL("api/spaces/references/builtin-my-space-inspiration", server.url), {
        method: "DELETE",
      });
      assert.equal(deleted.status, 200);
    } finally {
      await server.close();
    }

    server = await startLocalPanelServer({ productHome, port: 0 });
    try {
      const afterDeletion = await initialContentSnapshot(server.url);
      assert.equal(
        afterDeletion.defaultTree.entries.some((entry) => entry.item.id === "builtin-my-space-inspiration"),
        false,
      );
    } finally {
      await server.close();
    }
  });
});

test("an existing user Space is not treated as an empty migrated installation", async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const productHome = path.join(temporaryDirectory, "product");
    const paths = resolveProductPaths({ productHome });
    const database = new SqliteRuntimeDatabase(paths.data.database);
    const spaces = createSpaceFeature({ repository: createSqliteSpaceRepository(database) });
    try {
      await spaces.ready();
      await spaces.commands.createSpace({ id: "space-personal", title: "个人空间" });
    } finally {
      await spaces.release();
      database.close();
    }

    const server = await startLocalPanelServer({ productHome, port: 0 });
    try {
      const response = await getJson(server.url, "api/spaces");
      assert.deepEqual(response.spaces.map((space) => space.id), ["space-personal"]);
      const knowledge = await getJson(server.url, "api/personal-knowledge");
      assert.equal(knowledge.snapshot.notes.length, 0);
      assert.equal(knowledge.snapshot.pages.length, 0);
    } finally {
      await server.close();
    }
  });
});

async function initialContentSnapshot(serverUrl) {
  const [spaces, defaultSpace, learningSpace, knowledge] = await Promise.all([
    getJson(serverUrl, "api/spaces"),
    getJson(serverUrl, "api/spaces/space-default"),
    getJson(serverUrl, "api/spaces/space-learning"),
    getJson(serverUrl, "api/personal-knowledge"),
  ]);
  return {
    spaces: spaces.spaces,
    defaultTree: defaultSpace.tree,
    learningTree: learningSpace.tree,
    knowledge: knowledge.snapshot,
  };
}

async function getJson(serverUrl, relativePath) {
  const response = await fetch(new URL(relativePath, serverUrl));
  if (response.status !== 200) {
    assert.fail(`${relativePath} returned ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

async function withTemporaryDirectory(operation) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-initial-content-test-"));
  try {
    await operation(temporaryDirectory);
  } finally {
    await fs.rm(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
}
