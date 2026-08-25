import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import {
  ContextAttachmentUploadApplicationError,
  createContextAttachmentUploadApplication,
} from "../dist/app/application/context-attachment-application.js";
import { contextAttachmentUploadApplicationHttpError } from "../dist/app/panel-server/request-handler.js";

test("context upload Route delegates draft creation and compensation to one application command", async () => {
  const source = await fs.readFile("src/app/panel-server/workbench/context-routes.ts", "utf8");
  assert.match(source, /contextAttachmentUploadApplication\.upload/u);
  assert.doesNotMatch(source, /createManagedAttachmentDraft/u);
  assert.doesNotMatch(source, /Promise\.allSettled/u);
});

test("context upload application handles multiple files in order", async () => {
  const calls = [];
  const application = createContextAttachmentUploadApplication({
    ordinaryAgentFeature: {
      commands: {
        async createManagedAttachmentDraft(input) {
          calls.push({ type: "create", name: input.originalName, index: input.uploadFileIndex });
          return { record: record(input.originalName), created: true };
        },
        async discardManagedAttachmentDraft(id) { calls.push({ type: "discard", id }); },
      },
    },
    async resolveManagedAttachmentPath(id) { return `C:/attachments/${id}`; },
  });

  const result = await application.upload({
    uploadRequestId: "upload-1",
    files: [file("one.txt"), file("two.txt")],
    async createPreview({ record: value, path }) {
      calls.push({ type: "preview", id: value.attachmentId, path });
      return value.originalName;
    },
  });

  assert.deepEqual(result, ["one.txt", "two.txt"]);
  assert.deepEqual(calls.map(({ type }) => type), ["create", "preview", "create", "preview"]);
  assert.deepEqual(calls.filter(({ type }) => type === "create").map(({ index }) => index), [0, 1]);
});

test("context upload application compensates only newly-created drafts after a partial failure", async () => {
  const discarded = [];
  let createCount = 0;
  const application = createContextAttachmentUploadApplication({
    ordinaryAgentFeature: {
      commands: {
        async createManagedAttachmentDraft(input) {
          createCount += 1;
          return { record: record(input.originalName), created: createCount === 1 };
        },
        async discardManagedAttachmentDraft(id) { discarded.push(id); },
      },
    },
    async resolveManagedAttachmentPath(id) { return `C:/attachments/${id}`; },
  });

  await assert.rejects(
    application.upload({
      uploadRequestId: "upload-2",
      files: [file("first.txt"), file("second.txt")],
      async createPreview({ record: value }) {
        if (value.originalName === "second.txt") throw new Error("preview failed");
        return value;
      },
    }),
    /preview failed/u,
  );
  assert.deepEqual(discarded, ["attachment-first.txt"]);
});

test("context upload reports compensation failure instead of hiding it", async () => {
  const application = createContextAttachmentUploadApplication({
    ordinaryAgentFeature: {
      commands: {
        async createManagedAttachmentDraft(input) { return { record: record(input.originalName), created: true }; },
        async discardManagedAttachmentDraft() { throw new Error("discard failed"); },
      },
    },
    async resolveManagedAttachmentPath(id) { return `C:/attachments/${id}`; },
  });

  await assert.rejects(
    application.upload({
      uploadRequestId: "upload-3",
      files: [file("one.txt")],
      async createPreview() { throw new Error("preview failed"); },
    }),
    (error) => error instanceof ContextAttachmentUploadApplicationError &&
      error.code === "attachment_upload_compensation_failed",
  );
});

test("context upload application errors map to stable HTTP codes", () => {
  const error = contextAttachmentUploadApplicationHttpError(
    new ContextAttachmentUploadApplicationError("uploaded_attachment_missing", "missing"),
  );
  assert.equal(error.statusCode, 500);
  assert.equal(error.code, "uploaded_attachment_missing");
});

function file(filename) {
  return { filename, contentType: "text/plain", body: new Uint8Array([1, 2, 3]) };
}

function record(originalName) {
  return {
    schemaVersion: "ordinary-managed-attachment/v1",
    attachmentId: `attachment-${originalName}`,
    owner: { kind: "draft", instanceId: "instance-1" },
    originalName,
    mimeType: "text/plain",
    byteLength: 3,
    sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
