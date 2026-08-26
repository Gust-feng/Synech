import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handlePanelSpaceRoute, spaceFeatureHttpError } from "../dist/app/panel-server/spaces/space-routes.js";
import { createSpaceCreateEntryTool, createSpaceMoveTool } from "../dist/app/spaces/space-tools.js";
import { SpaceFeatureError } from "../dist/app/spaces/index.js";
import { SpaceReferenceContentApplicationError } from "../dist/app/application/space-reference-content-application.js";
import { spaceReferenceContentApplicationHttpError } from "../dist/app/panel-server/request-handler.js";
import { panelSpaceReferenceContentOperationError } from "../dist/app/panel-server/panel-host.js";
import { PanelHttpError } from "../dist/app/panel-server/http-utils.js";

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

test("Managed Asset HTTP writes delegate to the canonical Content Application", async () => {
  const calls = [];
  const request = Readable.from([JSON.stringify({ expectedFingerprint: "old", text: "updated" })]);
  request.method = "PUT";
  const response = responseRecorder();

  assert.equal(await handlePanelSpaceRoute({
    spaceFeature: { queries: {}, commands: {} },
    spaceReferenceContentApplication: {
      async updateText(input) {
        calls.push(input);
        return { itemId: input.itemId, status: "ready", content: { kind: "text", text: "updated" } };
      },
    },
  }, request, response, new URL("http://panel.test/api/spaces/references/reference-1/content")), true);

  assert.deepEqual(calls, [{ itemId: "reference-1", update: { expectedFingerprint: "old", text: "updated" } }]);
  assert.equal(response.statusCode, 200);
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

test("Agent adapters project declared Application and membership failures as structured statuses", async () => {
  const contentTool = createSpaceCreateEntryTool(toolOptions({
    content: {
      async createEntry() {
        throw new SpaceReferenceContentApplicationError("space_reference_source_changed", "Source changed.");
      },
    },
  }));
  const lifecycleTool = createSpaceMoveTool(toolOptions({
    lifecycle: {
      async move() {
        throw new SpaceFeatureError("space_reference_membership_changed", "Membership changed.");
      },
    },
    queries: { async getReference() { return { ...reference, reference: { kind: "web_page", url: "https://example.test" } }; } },
  }));

  assert.deepEqual(
    await contentTool.execute({ itemId: "reference-1", parentRelativePath: "", name: "new.md", kind: "file" }, {}),
    { status: "space_reference_source_changed", message: "Source changed." },
  );
  assert.deepEqual(
    await lifecycleTool.execute({ targetKind: "reference", targetId: "reference-1", destinationSpaceId: "space-2" }, {}),
    { status: "space_reference_membership_changed", message: "Membership changed." },
  );
});

test("Panel composition and HTTP preserve declared Space Reference error facts", () => {
  const panelError = new PanelHttpError(409, "space_reference_revision_conflict", "Revision changed.");
  const applicationError = panelSpaceReferenceContentOperationError(panelError);

  assert.equal(applicationError instanceof SpaceReferenceContentApplicationError, true);
  assert.equal(applicationError.code, "space_reference_revision_conflict");
  assert.equal(spaceReferenceContentApplicationHttpError(applicationError).statusCode, 409);
  assert.equal(spaceFeatureHttpError(new SpaceFeatureError(
    "space_reference_membership_changed",
    "Membership changed.",
  )).statusCode, 409);
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
