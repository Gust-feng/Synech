import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpaceReferenceContentApplication,
  SpaceReferenceContentApplicationError,
} from "../dist/app/application/space-reference-content-application.js";

function localItem(overrides = {}) {
  return {
    id: "reference-1",
    spaceId: "space-1",
    title: "Notes",
    reference: { kind: "local_file", path: "C:/notes.md" },
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function createFixture({ item = localItem(), resolutionPath = "C:/notes.md" } = {}) {
  let current = item;
  const calls = [];
  let resolveCount = 0;
  const runtime = {
    spaceFeature: {
      commands: {
        async refreshReferenceSourceIdentity(itemId) {
          calls.push(["refreshReferenceSourceIdentity", itemId]);
        },
      },
      queries: {
        async getReference(itemId) {
          calls.push(["getReference", itemId]);
          return current.id === itemId ? current : undefined;
        },
      },
    },
    spaceAdmission: {
      assertAvailable(spaceId) {
        calls.push(["assertAvailable", spaceId]);
      },
      async admit(spaceId, operation) {
        calls.push(["admit", spaceId]);
        return await operation();
      },
    },
    fileMutationCoordinator: {
      async run(key, operation) {
        calls.push(["run", key]);
        return await operation();
      },
    },
    async resolveFilesystemReference(value) {
      resolveCount += 1;
      calls.push(["resolve", value.id, resolveCount]);
      return {
        item: value,
        path: resolutionPath,
        sourceKind: value.reference.kind,
        sourceIdentity: "identity-1",
        ...(value.reference.kind === "workspace" ? { mountVersion: "mount-1" } : {}),
      };
    },
    operations: {
      async updateText(value, input) {
        calls.push(["updateText", value.id, input.text]);
        return { itemId: value.id, status: "ready", content: { kind: "text", text: input.text, truncated: false, editable: true } };
      },
      async updateCaption(value, input) {
        calls.push(["updateCaption", value.id, input.caption]);
        return { itemId: value.id, status: "ready", content: { kind: "media", mediaKind: "image", mimeType: "image/png", url: "image.png" } };
      },
      async createEntry(value, input) {
        calls.push(["createEntry", value.id, input.name]);
        return { relativePath: `${input.parentRelativePath}/${input.name}` };
      },
      async renameEntry(value, input) {
        calls.push(["renameEntry", value.id, input.name]);
        return { relativePath: input.name };
      },
      async deleteEntry(value, relativePath) {
        calls.push(["deleteEntry", value.id, relativePath]);
      },
      async updateAnnotation(value, expectedRevision, patch, actor) {
        calls.push(["updateAnnotation", value.id, expectedRevision, patch.markdown, actor.kind]);
        return { ...value, annotation: { revision: expectedRevision + 1, markdown: patch.markdown } };
      },
    },
  };
  return { runtime, calls, setCurrent(value) { current = value; } };
}

test("content application shares admission, reread and path lease for filesystem content", async () => {
  const fixture = createFixture();
  const application = createSpaceReferenceContentApplication(fixture.runtime);

  const preview = await application.updateText({
    itemId: "reference-1",
    update: { expectedFingerprint: "sha256:old", text: "updated" },
  });

  assert.equal(preview.content.text, "updated");
  assert.deepEqual(fixture.calls.filter(([kind]) => ["assertAvailable", "admit", "run", "refreshReferenceSourceIdentity"].includes(kind)), [
    ["assertAvailable", "space-1"],
    ["admit", "space-1"],
    ["run", "C:/notes.md"],
    ["refreshReferenceSourceIdentity", "reference-1"],
  ]);
});

test("content application rejects a revoked reference before invoking the operation", async () => {
  const fixture = createFixture();
  fixture.setCurrent({ ...localItem(), id: "other-reference" });
  const application = createSpaceReferenceContentApplication(fixture.runtime);

  await assert.rejects(
    () => application.deleteEntry({ itemId: "reference-1", relativePath: "notes.md" }),
    (error) => error instanceof SpaceReferenceContentApplicationError && error.code === "space_reference_not_found",
  );
});

test("content application rejects a source change while waiting for the path lease", async () => {
  const fixture = createFixture();
  let changed = false;
  fixture.runtime.resolveFilesystemReference = async (value) => ({
    item: value,
    path: changed ? "C:/replacement.md" : "C:/notes.md",
    sourceKind: "local_file",
    sourceIdentity: changed ? "identity-2" : "identity-1",
  });
  fixture.runtime.fileMutationCoordinator.run = async (key, operation) => {
    fixture.calls.push(["run", key]);
    changed = true;
    return await operation();
  };
  const application = createSpaceReferenceContentApplication(fixture.runtime);

  await assert.rejects(
    () => application.renameEntry({ itemId: "reference-1", relativePath: "old.md", name: "new.md" }),
    (error) => error instanceof SpaceReferenceContentApplicationError && error.code === "space_reference_source_changed",
  );
  assert.equal(fixture.calls.some(([kind]) => kind === "renameEntry"), false);
});

test("content application delegates caption and entry commands through the same contract", async () => {
  const fixture = createFixture({ item: { ...localItem(), reference: { kind: "managed_folder", path: "C:/managed" } } });
  const application = createSpaceReferenceContentApplication(fixture.runtime);

  await application.updateCaption({ itemId: "reference-1", update: { expectedFingerprint: "space-image-caption:0", caption: "Caption" }, actor: { kind: "agent", runId: "run-1" } });
  await application.createEntry({ itemId: "reference-1", parentRelativePath: "docs", name: "new.md", kind: "file" });
  await application.renameEntry({ itemId: "reference-1", relativePath: "docs/old.md", name: "new.md" });
  await application.deleteEntry({ itemId: "reference-1", relativePath: "docs/new.md" });

  assert.deepEqual(fixture.calls.filter(([kind]) => ["updateCaption", "createEntry", "renameEntry", "deleteEntry"].includes(kind)).map(([kind]) => kind), [
    "updateCaption",
    "createEntry",
    "renameEntry",
    "deleteEntry",
  ]);
  assert.equal(fixture.calls.some(([kind]) => kind === "run"), true);
});

test("non-filesystem references use the owner admission without a filesystem lease", async () => {
  const fixture = createFixture({ item: { ...localItem(), reference: { kind: "managed_asset", assetId: "asset-1" } } });
  const application = createSpaceReferenceContentApplication(fixture.runtime);

  await application.updateCaption({ itemId: "reference-1", update: { expectedFingerprint: "caption-0", caption: "Caption" }, actor: { kind: "agent", runId: "run-1" } });

  assert.equal(fixture.calls.some(([kind]) => kind === "resolve"), false);
  assert.equal(fixture.calls.some(([kind]) => kind === "run"), false);
});

test("annotation updates share owner admission without a filesystem lease", async () => {
  const fixture = createFixture();
  const application = createSpaceReferenceContentApplication(fixture.runtime);

  const updated = await application.updateAnnotation({
    itemId: "reference-1",
    expectedRevision: 2,
    patch: { markdown: "Summary" },
    actor: { kind: "agent", runId: "run-1" },
  });

  assert.equal(updated.annotation.markdown, "Summary");
  assert.deepEqual(fixture.calls.filter(([kind]) => ["admit", "updateAnnotation", "run"].includes(kind)), [
    ["admit", "space-1"],
    ["updateAnnotation", "reference-1", 2, "Summary", "agent"],
  ]);
});
