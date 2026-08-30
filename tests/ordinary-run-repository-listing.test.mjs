import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFileSystemOrdinaryRunRepository } from "../dist/app/ordinary-agent/file-system-repository.js";

test("list consumes manifest summaries without reading snapshots", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "synech-run-listing-"));
  t.after(async () => await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const manifest = {
    schemaVersion: "ordinary-run-manifest/v1",
    entries: [
      {
        runId: "run-a", conversationId: "conversation-1", userTurnId: "user-1", assistantTurnId: "assistant-1",
        status: "completed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        runId: "run-b", conversationId: "conversation-2", userTurnId: "user-2", assistantTurnId: "assistant-2",
        status: "completed", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
  };
  await fs.mkdir(path.join(rootDir, "runs"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const repository = createFileSystemOrdinaryRunRepository(rootDir);
  const summaries = await repository.list(50);
  assert.deepEqual(summaries.map((summary) => summary.runId), ["run-b", "run-a"]);
  // The snapshot files were never created: listing must not depend on them.
  assert.equal(summaries.every((summary) => summary.conversationId.length > 0), true);

  const limited = await repository.list(1);
  assert.deepEqual(limited.map((summary) => summary.runId), ["run-b"]);
});

test("list with the recovery limit rebuilds the manifest from disk", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "synech-run-repair-"));
  t.after(async () => await fs.rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));

  const manifest = {
    schemaVersion: "ordinary-run-manifest/v1",
    entries: [{
      runId: "run-orphan", conversationId: "conversation-1", userTurnId: "user-1", assistantTurnId: "assistant-1",
      status: "completed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  };
  await fs.mkdir(path.join(rootDir, "runs"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const repository = createFileSystemOrdinaryRunRepository(rootDir);
  assert.deepEqual(await repository.list(Number.MAX_SAFE_INTEGER), []);
  // The repair rewrote the manifest; a normal list stays empty without another scan.
  assert.deepEqual(await repository.list(50), []);
});
