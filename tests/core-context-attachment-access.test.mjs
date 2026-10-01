import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createContextAttachmentTools } from "../dist/app/tool-center/adapters/context-attachment-tools.js";
import { attachOrdinaryFileInputsToModelMessages } from "../dist/app/ordinary-agent/model-input-attachments.js";
import { createSpaceRunPathAuthorization } from "../dist/app/spaces/space-run-path-authorization.js";
import { inspectSpaceExternalSource } from "../dist/app/spaces/space-external-source.js";
import { spaceReferenceAttachmentId, spaceScopePermission } from "../dist/app/spaces/space-file-access.js";
import { InMemoryLocalWorkspaceMutationCoordinator } from "../dist/app/tool-center/adapters/local-workspace-mutation-coordinator.js";

const context = { callerAgentId: "ordinary", traceId: "attachment-run", goalId: "attachment-goal" };
const vision = { facts: {
  status: "confirmed", piProviderId: "test", modelId: "vision", transport: "openai_responses",
  contextWindowTokens: 32_000, maxOutputTokens: 1_024, supportsVisionInput: true,
  supportsReasoningOutput: false, thinkingLevels: [], supportsStrictToolSchemas: true,
  supportsParallelToolCalls: true,
} };

async function withDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-core-attachment-access-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function runContext(ref, permission) {
  return {
    contextId: "attachment-context", goal: "Read attachments", goalId: context.goalId, traceId: context.traceId,
    contextRefs: [ref], permissionBoundaryRefs: [permission, spaceScopePermission("space-1")],
  };
}

test("all attachment readers reject a junction escaping the selected project", async () => {
  await withDirectory(async (directory) => {
    const root = path.join(directory, "project");
    const external = path.join(directory, "private");
    await fs.mkdir(root);
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "secret.txt"), "private content");
    await fs.writeFile(path.join(external, "secret.png"), "private image");
    await fs.symlink(external, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const run = runContext({ kind: "project", ref: `local-project:${root}`, attachmentId: "project" }, `read:local-project:${root}`);
    const tools = createContextAttachmentTools({ runContext: run, workspaceRoot: root });
    for (const tool of tools.filter((item) => item.definition.name !== "AttachmentList")) {
      await assert.rejects(tool.execute({
        attachmentId: "project", path: "linked/secret.txt", query: "private",
      }, context), /outside the workspace boundary/u, tool.definition.name);
    }
    await assert.rejects(attachOrdinaryFileInputsToModelMessages({
      messages: [{ role: "user", content: "Inspect this" }],
      runContext: runContext({
        kind: "file", ref: "file:linked/secret.png", attachmentId: "image",
      }, "read:file:linked/secret.png"),
      workspaceRoot: root,
      modelCapabilities: vision,
    }), (error) => error.code === "model_input_attachment_unavailable");
  });
});

test("an attachment read waiting for the shared lease rejects a reconnected mount", async () => {
  await withDirectory(async (directory) => {
    const source = await inspectSpaceExternalSource(directory);
    const attachmentId = spaceReferenceAttachmentId("reference-1");
    const run = runContext({
      kind: "project", ref: `local-project:${directory}`, attachmentId,
      sourceIdentity: source.identity, mountVersion: "mount-1",
    }, `read:local-project:${directory}`);
    await fs.writeFile(path.join(directory, "note.txt"), "content");
    let mountVersion = "mount-1";
    let initialResolved;
    const firstResolution = new Promise((resolve) => { initialResolved = resolve; });
    const authorization = createSpaceRunPathAuthorization({
      runContext: run, workspaceRoot: directory,
      async resolveCurrentSource() {
        initialResolved();
        return { path: directory, sourceIdentity: source.identity, mountVersion };
      },
    });
    const coordinator = new InMemoryLocalWorkspaceMutationCoordinator();
    let release;
    const blocker = coordinator.runExclusive(directory, () => new Promise((resolve) => { release = resolve; }));
    const tools = createContextAttachmentTools({
      runContext: run, workspaceRoot: directory, pathAuthorization: authorization, mutationCoordinator: coordinator,
    });
    const pending = tools.find((tool) => tool.definition.name === "AttachmentRead")
      .execute({ attachmentId, path: "note.txt" }, context);
    await firstResolution;
    await new Promise((resolve) => setImmediate(resolve));
    mountVersion = "mount-2";
    release();
    await assert.rejects(pending, /changed source identity/u);
    await blocker;
  });
});

test("owner file replacement is rejected while explicit uploads remain readable in a Space run", async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, "source.png");
    await fs.writeFile(file, "original image");
    const source = await inspectSpaceExternalSource(file);
    const attachmentId = spaceReferenceAttachmentId("image-reference");
    const run = runContext({
      kind: "file", ref: `local-file:${file}`, attachmentId, sourceIdentity: source.identity,
    }, `read:local-file:${file}`);
    const authorization = createSpaceRunPathAuthorization({
      runContext: run, workspaceRoot: directory,
      resolveCurrentSource: async () => ({ path: file, sourceIdentity: source.identity }),
    });
    const tools = createContextAttachmentTools({
      runContext: run, workspaceRoot: directory, pathAuthorization: authorization,
    });
    await fs.rename(file, path.join(directory, "old-source.png"));
    await fs.writeFile(file, "replacement image");
    await assert.rejects(tools.find((tool) => tool.definition.name === "AttachmentReadImage")
      .execute({ attachmentId }, context), /original source/u);

    const upload = runContext({
      kind: "file", ref: "uploaded-attachment:uploaded-image", attachmentId: "uploaded-image",
      metadata: { mimeType: "image/png" },
    }, "read:uploaded-attachment:uploaded-image");
    const options = {
      runContext: upload, workspaceRoot: directory, pathAuthorization: authorization,
      resolveManagedAttachmentPath: async () => file,
    };
    const imageTool = createContextAttachmentTools(options).find((tool) => tool.definition.name === "AttachmentReadImage");
    assert.equal((await imageTool.execute({ attachmentId: "uploaded-image" }, context)).readable, true);
    const messages = await attachOrdinaryFileInputsToModelMessages({
      ...options, messages: [{ role: "user", content: "Inspect this" }], modelCapabilities: vision,
    });
    assert.equal(messages[0].attachments[0].source.data, Buffer.from("replacement image").toString("base64"));

    const userFile = runContext({
      kind: "file", ref: `local-file:${file}`, attachmentId: "user-file", metadata: { mimeType: "image/png" },
    }, `read:local-file:${file}`);
    const userOptions = {
      ...options, runContext: userFile,
      readAuthorization: { assertReadAllowed() {}, appliesPathAuthorization: () => false },
    };
    assert.equal((await createContextAttachmentTools(userOptions)
      .find((tool) => tool.definition.name === "AttachmentReadImage")
      .execute({ attachmentId: "user-file" }, context)).readable, true);
    const userMessages = await attachOrdinaryFileInputsToModelMessages({
      ...userOptions, messages: [{ role: "user", content: "Inspect my file" }], modelCapabilities: vision,
    });
    assert.equal(userMessages[0].attachments.length, 1);
  });
});
