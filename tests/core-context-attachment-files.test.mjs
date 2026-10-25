import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { handlePanelContextRoute } from "../dist/app/panel-server/workbench/context-routes.js";

import {
  createSearchFacts,
  listDirectoryTree,
  searchPath,
} from "../dist/app/tool-center/adapters/context-attachment-files.js";

test("attachment traversal keeps external and cyclic directory links outside its read boundary", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-core-attachment-boundary-"));
  try {
    const root = path.join(directory, "root");
    const outside = path.join(directory, "outside");
    await fs.mkdir(path.join(root, "nested"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(root, "nested", "allowed.txt"), "needle inside", "utf8");
    await fs.writeFile(path.join(outside, "private.txt"), "needle outside", "utf8");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(outside, path.join(root, "external"), linkType);
    await fs.symlink(root, path.join(root, "loop"), linkType);

    const listed = await listDirectoryTree({
      absolutePath: root, rootAbsolutePath: root, maxDepth: 3, limit: 200, offset: 0,
    });
    assert.deepEqual(listed.entries.filter((entry) => entry.kind === "symlink").map((entry) => ({
      path: entry.path, bytes: entry.bytes,
    })), [{ path: "external", bytes: undefined }, { path: "loop", bytes: undefined }]);
    assert.deepEqual(listed.entries.map((entry) => entry.path), [
      "external", "loop", "nested", "nested/allowed.txt",
    ]);

    const matches = [];
    const facts = createSearchFacts();
    await searchPath({
      absolutePath: root, rootAbsolutePath: root, normalizedQuery: "needle", limit: 80, matches, facts,
    });
    assert.deepEqual(matches.map((match) => match.path), ["nested/allowed.txt"]);
    assert.equal(facts.searchedFiles, 1);
    assert.deepEqual(facts.skippedSamples.map((sample) => ({
      path: sample.path, reason: sample.reason,
    })), [{ path: "external", reason: "symlink" }, { path: "loop", reason: "symlink" }]);

    const selectedRoot = path.join(directory, "selected-root");
    await fs.symlink(root, selectedRoot, linkType);
    const selectedMatches = [];
    await searchPath({
      absolutePath: selectedRoot, rootAbsolutePath: selectedRoot, normalizedQuery: "needle",
      limit: 80, matches: selectedMatches, facts: createSearchFacts(),
    });
    assert.deepEqual(selectedMatches.map((match) => match.path), ["nested/allowed.txt"]);

    const escapedMatches = [];
    await assert.rejects(searchPath({
      absolutePath: path.join(root, "external"), rootAbsolutePath: root, normalizedQuery: "needle",
      limit: 80, matches: escapedMatches, facts: createSearchFacts(),
    }), /Path is outside the workspace boundary/u);
    assert.deepEqual(escapedMatches, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("attachment listing propagates cancellation during a recursive directory read", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-core-attachment-list-cancel-"));
  const controller = new AbortController();
  const readdir = fs.readdir;
  try {
    const nested = path.join(directory, "nested");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "note.txt"), "content", "utf8");
    t.mock.method(fs, "readdir", async (...args) => {
      const entries = await readdir(...args);
      if (args[0] === nested) controller.abort();
      return entries;
    });
    await assert.rejects(listDirectoryTree({
      absolutePath: directory, rootAbsolutePath: directory,
      maxDepth: 3, limit: 200, offset: 0, abortSignal: controller.signal,
    }), { name: "AbortError" });
  } finally {
    t.mock.restoreAll();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("attachment search rejects an aborted file read without accepting partial results", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-core-attachment-search-cancel-"));
  const controller = new AbortController();
  const readFile = fs.readFile;
  const matches = [];
  const facts = createSearchFacts();
  try {
    const file = path.join(directory, "note.txt");
    await fs.writeFile(file, "needle content", "utf8");
    t.mock.method(fs, "readFile", async (...args) => {
      if (args[0] === file) controller.abort();
      return readFile(...args);
    });
    await assert.rejects(searchPath({
      absolutePath: directory, rootAbsolutePath: directory, normalizedQuery: "needle",
      limit: 80, matches, facts, abortSignal: controller.signal,
    }), { name: "AbortError" });
    assert.deepEqual(matches, []);
    assert.equal(facts.searchedFiles, 0);
    assert.equal(facts.skippedUnreadableFiles, 0);
  } finally {
    t.mock.restoreAll();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});


test("attachment upload preserves Unicode filenames, filename punctuation and binary payloads", async () => {
  const data = new FormData();
  const payload = Uint8Array.from([0, 255, 13, 10, 128, 34, 59, 254]);
  const names = ["截图.png", "报告;最终版.pdf", "notes.md"];
  for (const name of names) data.append("files", new File([payload], name, { type: "application/octet-stream" }));
  data.append("caption", "not a file");
  const encoded = new Response(data);
  const request = Readable.from([Buffer.from(await encoded.arrayBuffer())]);
  request.method = "POST";
  request.headers = { "content-type": encoded.headers.get("content-type"), "idempotency-key": "upload-roundtrip" };
  let received;
  let status;
  const handled = await handlePanelContextRoute({
    contextAttachmentUploadApplication: {
      async upload(input) { received = input; return []; },
    },
  }, request, {
    writeHead(code) { status = code; },
    end() {},
  }, new URL("http://localhost/api/context/attachments/upload"));
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(received.uploadRequestId, "upload-roundtrip");
  assert.deepEqual(received.files.map((file) => file.filename), names);
  for (const file of received.files) {
    assert.equal(file.contentType, "application/octet-stream");
    assert.deepEqual(file.body, payload);
  }
});
