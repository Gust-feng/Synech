import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  parseContextReference,
  parsePermissionBoundaryRef,
  serializeContextReference,
  serializePermissionBoundaryRef,
} from "../dist/domain/ordinary/index.js";
import { toolRunAccessPolicyFromPreset } from "../dist/domain/tools/index.js";
import { modelFailureKindFromError, modelFailureKindFromFacts } from "../dist/kernel/intelligence/failures.js";
import { confirmationIdForToolCall } from "../dist/kernel/tools/index.js";
import { createManagedAssetsFeature } from "../dist/app/managed-assets/index.js";
import { isTerminalStatus } from "../dist/app/ordinary-agent/index.js";
import { resolveAssistantAnswer } from "../dist/app/panel-api/ui-read-model.js";
import { createSpaceRunPathAuthorization } from "../dist/app/spaces/index.js";

test("Context and permission refs round-trip through the canonical codec", () => {
  const refs = [
    { scheme: "local_file", path: "C:/notes/a.md" },
    { scheme: "local_project", path: "C:/projects/synech" },
    { scheme: "uploaded_attachment", attachmentId: "attachment-1" },
    { scheme: "workspace", value: "current" },
    { scheme: "file", path: "src/index.ts" },
    { scheme: "project", path: "src" },
    { scheme: "web", value: "https://example.com" },
    { scheme: "http_url", url: "https://example.com/page" },
  ];
  for (const ref of refs) {
    assert.deepEqual(parseContextReference(serializeContextReference(ref)), ref);
  }

  const permissions = [
    { kind: "access", mode: "read", target: "local-file:C:/notes/a.md" },
    { kind: "access", mode: "execute", target: "Shell" },
    { kind: "access", mode: "deny", target: "Delete" },
    { kind: "access", mode: "ask", target: "HttpRequest" },
    { kind: "space_scope", spaceId: "space-1" },
    { kind: "space_reference_write", referenceId: "reference-1" },
  ];
  for (const permission of permissions) {
    assert.deepEqual(parsePermissionBoundaryRef(serializePermissionBoundaryRef(permission)), permission);
  }
  assert.equal(parseContextReference("local-file:", "file"), undefined);
  assert.equal(parsePermissionBoundaryRef("read:"), undefined);
});

test("Provider failure classification uses structured facts rather than message wording", () => {
  assert.equal(modelFailureKindFromFacts({ status: 401 }), "provider_auth");
  assert.equal(modelFailureKindFromFacts({ status: 429 }), "provider_rate_limit");
  assert.equal(modelFailureKindFromFacts({ code: "ETIMEDOUT" }), "provider_timeout");
  assert.equal(modelFailureKindFromFacts({ code: "ECONNRESET" }), "provider_network");
  assert.equal(modelFailureKindFromError(Object.assign(new Error("arbitrary copy"), { status: 403 })), "provider_auth");
  assert.equal(modelFailureKindFromError(new Error("401 unauthorized rate limit timeout")), "provider_response");
});

test("Run terminal and assistant answer facts have one deterministic policy", () => {
  for (const kind of ["completed", "failed", "cancelled", "blocked"]) {
    assert.equal(isTerminalStatus({ kind, ...(kind === "failed" ? { error: { code: "x", message: "x" } } : {}), ...(kind === "cancelled" ? { reason: "x" } : {}), ...(kind === "blocked" ? { reason: { code: "x", message: "x" }, continueBy: "new_turn" } : {}) }), true);
  }
  assert.equal(isTerminalStatus({ kind: "running" }), false);

  assert.deepEqual(resolveAssistantAnswer({
    runStatus: "running",
    live: { text: "live", streaming: true, tone: "process" },
    conversationText: "old",
  }), { text: "live", source: "live", streaming: true, tone: "process" });
  assert.equal(resolveAssistantAnswer({
    runStatus: "completed",
    conversationText: "session",
    workViewText: "work view",
    projection: { text: "projection" },
  }).source, "session");
  assert.equal(resolveAssistantAnswer({ runStatus: "failed", conversationText: "not an answer" }).source, "none");
  assert.equal(resolveAssistantAnswer({ runStatus: "blocked", interruption: "runtime_stopped", conversationText: "checkpoint" }).source, "checkpoint");
});

test("Managed Assets feature serializes every normal mutation and publishes operation facts", async (t) => {
  const assets = new Map();
  const repository = {
    async get(id) { return assets.get(id); },
    async list() { return [...assets.values()]; },
    async upsertMany(values) { for (const value of values) assets.set(value.id, structuredClone(value)); },
    async removeMany(ids) { for (const id of ids) assets.delete(id); },
    async updateText(input) {
      const asset = assets.get(input.id);
      if (asset === undefined) return { status: "not_found" };
      const updated = { ...asset, markdown: input.text };
      assets.set(input.id, updated);
      return { status: "updated", asset: updated, fingerprint: "text-2" };
    },
    async updateCaption(input) {
      const asset = assets.get(input.id);
      if (asset === undefined) return { status: "not_found" };
      const updated = { ...asset, image: { ...asset.image, caption: input.caption } };
      assets.set(input.id, updated);
      return { status: "updated", asset: updated, fingerprint: "caption-2" };
    },
  };
  const feature = createManagedAssetsFeature(repository);
  const events = [];
  const unsubscribe = feature.events.subscribe((event) => events.push(event));
  t.after(async () => { unsubscribe(); await feature.release(); });

  await feature.commands.replace({ id: "asset-1", kind: "image", title: "Image", image: { src: "image.png", alt: "" } });
  await feature.commands.updateCaption({ id: "asset-1", expectedFingerprint: "caption-1", caption: "Caption" });
  await feature.commands.removeMany(["asset-1"]);
  assert.deepEqual(events.map((event) => event.operation), ["replaced", "caption_updated", "removed"]);
});

test("Space path authorization separates approval mode from filesystem scope", async () => {
  const root = path.resolve("space-root");
  const outside = path.resolve("outside", "file.txt");
  const target = serializeContextReference({ scheme: "local_project", path: root });
  const authorization = createSpaceRunPathAuthorization({
    workspaceRoot: root,
    pathIdentity: async (value) => path.resolve(value).replaceAll("\\", "/").toLowerCase(),
    runContext: {
      contextRefs: [{ attachmentId: "space-reference:reference-1", ref: target, kind: "project" }],
      permissionBoundaryRefs: [
        serializePermissionBoundaryRef({ kind: "space_scope", spaceId: "space-1" }),
        serializePermissionBoundaryRef({ kind: "access", mode: "read", target }),
        serializePermissionBoundaryRef({ kind: "space_reference_write", referenceId: "reference-1" }),
      ],
    },
  });
  assert.notEqual(authorization, undefined);
  const standard = toolRunAccessPolicyFromPreset("prompt");
  const fullAccess = toolRunAccessPolicyFromPreset("full_access");
  const context = (accessPolicy, approvedConfirmationIds) => ({
    callerAgentId: "ordinary",
    traceId: "run-1",
    goalId: "run-1",
    invocationId: "invocation-1",
    accessPolicy,
    ...(approvedConfirmationIds === undefined ? {} : { approvedConfirmationIds }),
  });

  await assert.rejects(() => authorization.resolve({ requestedPath: outside, operation: "write", workspaceRoot: root, context: context(standard) }));
  await assert.rejects(() => authorization.resolve({ requestedPath: outside, operation: "execute", workspaceRoot: root, context: context(standard) }));
  const approved = await authorization.resolve({
    requestedPath: outside,
    operation: "execute",
    workspaceRoot: root,
    context: context(standard, [confirmationIdForToolCall("invocation-1")]),
  });
  assert.equal(approved.absolutePath, outside);
  const unrestricted = await authorization.resolve({ requestedPath: outside, operation: "write", workspaceRoot: root, context: context(fullAccess) });
  assert.equal(unrestricted.absolutePath, outside);
});
