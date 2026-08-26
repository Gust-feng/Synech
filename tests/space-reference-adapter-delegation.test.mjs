import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handlePanelSpaceRoute } from "../dist/app/panel-server/spaces/space-routes.js";
import { createSpaceCreateEntryTool, createSpaceMoveTool } from "../dist/app/spaces/space-tools.js";

const reference = {
  id: "reference-1",
  spaceId: "space-1",
  title: "Workspace",
  reference: { kind: "managed_folder", path: "C:/managed" },
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

test("Space entry HTTP adapter delegates to the canonical Content Application", async () => {
  const calls = [];
  const request = Readable.from([JSON.stringify({ parentRelativePath: "docs", name: "new.md", kind: "file" })]);
  request.method = "POST";
  const response = responseRecorder();

  assert.equal(await handlePanelSpaceRoute({
    spaceFeature: { queries: { async getReference() { return reference; } }, commands: {} },
    spaceReferenceContentApplication: {
      async createEntry(input) {
        calls.push(input);
        return { relativePath: "docs/new.md" };
      },
    },
  }, request, response, new URL("http://panel.test/api/spaces/references/reference-1/entry")), true);

  assert.deepEqual(calls, [{ itemId: "reference-1", parentRelativePath: "docs", name: "new.md", kind: "file" }]);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.entry.relativePath, "docs/new.md");
});

test("Space entry Agent adapter delegates to the canonical Content Application", async () => {
  const calls = [];
  const tool = createSpaceCreateEntryTool(toolOptions({
    content: {
      async createEntry(input) {
        calls.push(input);
        return { relativePath: "docs/new.md" };
      },
    },
  }));

  const result = await tool.execute({ itemId: "reference-1", parentRelativePath: "docs", name: "new.md", kind: "file" }, {});

  assert.deepEqual(calls, [{ itemId: "reference-1", parentRelativePath: "docs", name: "new.md", kind: "file" }]);
  assert.equal(result.status, "created");
  assert.equal(result.relativePath, "docs/new.md");
});

test("Space move Agent adapter delegates to the canonical Lifecycle Application", async () => {
  const calls = [];
  const tool = createSpaceMoveTool(toolOptions({
    lifecycle: {
      async move(input) { calls.push(input); },
    },
    queries: { async getReference() { return { ...reference, reference: { kind: "web_page", url: "https://example.test" } }; } },
  }));

  const result = await tool.execute({ targetKind: "reference", targetId: "reference-1", destinationSpaceId: "space-2" }, {});

  assert.deepEqual(calls, [{ sourceSpaceId: "space-1", target: { kind: "reference", id: "reference-1" }, destinationSpaceId: "space-2" }]);
  assert.equal(result.status, "moved");
});

function toolOptions({ content = {}, lifecycle = {}, queries = {} }) {
  return {
    spaces: { commands: {}, queries },
    workspaceRoot: "C:/workspace",
    spaceReferenceContentApplication: content,
    spaceReferenceLifecycleApplication: lifecycle,
  };
}

function responseRecorder() {
  return {
    statusCode: undefined,
    body: undefined,
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(value) { this.body = JSON.parse(String(value)); },
  };
}
