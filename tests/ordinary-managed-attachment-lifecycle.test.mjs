import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createManagedAttachmentLifecycle,
} from "../dist/app/ordinary-agent/attachment-lifecycle.js";
import {
  ORDINARY_MANAGED_ATTACHMENT_SCHEMA_VERSION,
  OrdinaryManagedAttachmentRepositoryError,
  createFileSystemOrdinaryManagedAttachmentRepository,
} from "../dist/app/ordinary-agent/managed-attachment-repository.js";

test("file attachment repository stores records while lifecycle owns cleanup policy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synech-attachment-test-"));
  try {
    const repository = createFileSystemOrdinaryManagedAttachmentRepository(root);
    await repository.createDraft({
      attachmentId: "attachment-1",
      instanceId: "instance-1",
      originalName: "notes.txt",
      content: new TextEncoder().encode("hello"),
      createdAt: "2026-08-24T00:00:00.000Z",
    });

    assert.equal((await repository.list()).length, 1);
    assert.equal((await fs.readFile(await repository.resolveContentPath("attachment-1"), "utf8")), "hello");
    await repository.delete("attachment-1");
    assert.deepEqual(await repository.list(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("managed attachment drafts use stable upload identity and can be discarded", async () => {
  const repository = memoryRepository();
  const lifecycle = attachmentLifecycle(repository);
  const input = {
    originalName: "notes.txt",
    content: new TextEncoder().encode("hello"),
    uploadRequestId: "upload-1",
    uploadFileIndex: 0,
  };

  const first = await lifecycle.createDraft(input);
  const repeated = await lifecycle.createDraft(input);

  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.equal(repeated.record.attachmentId, first.record.attachmentId);
  await lifecycle.discardDraft(first.record.attachmentId);
  assert.equal(await lifecycle.get(first.record.attachmentId), undefined);
});

test("committing a new claim protects an attachment from an older failed rollback", async () => {
  const repository = memoryRepository();
  const lifecycle = attachmentLifecycle(repository);
  await repository.seedDraft("attachment-1");

  const failedBirth = await lifecycle.claimForRun(claimInput("run-1"));
  repository.failNextRelease();
  await failedBirth.rollback();
  assert.equal(repository.releaseCalls(), 1);

  const committedBirth = await lifecycle.claimForRun(claimInput("run-2"));
  await committedBirth.commit();

  assert.equal(repository.releaseCalls(), 1);
  assert.deepEqual((await repository.get("attachment-1")).owner, {
    kind: "conversation",
    conversationId: "conversation-1",
  });
});

test("rolling back an uncommitted run birth releases its new attachment claim", async () => {
  const repository = memoryRepository();
  const lifecycle = attachmentLifecycle(repository);
  await repository.seedDraft("attachment-1");

  const claim = await lifecycle.claimForRun(claimInput("run-1"));
  await claim.rollback();

  assert.equal(repository.releaseCalls(), 1);
  assert.deepEqual((await repository.get("attachment-1")).owner, {
    kind: "draft",
    instanceId: "instance-1",
  });
});

test("lifecycle release settles one pending rollback and removes instance drafts", async () => {
  const repository = memoryRepository();
  const lifecycle = attachmentLifecycle(repository);
  await repository.seedDraft("attachment-1");

  const claim = await lifecycle.claimForRun(claimInput("run-1"));
  repository.failNextRelease();
  await claim.rollback();
  await lifecycle.release();

  assert.equal(repository.releaseCalls(), 2);
  assert.deepEqual(await repository.list(), []);
});

function attachmentLifecycle(repository) {
  let sequence = 0;
  return createManagedAttachmentLifecycle({
    repository,
    instanceId: "instance-1",
    now: () => `2026-08-24T00:00:0${sequence++}.000Z`,
    idFactory: (prefix) => `${prefix}-${sequence++}`,
  });
}

function claimInput(runId) {
  return {
    runId,
    conversationId: "conversation-1",
    runInput: {
      userMessage: "read the attachment",
      context: {
        contextRefs: [{
          attachmentId: "attachment-1",
          ref: "uploaded-attachment:attachment-1",
          kind: "file",
          title: "notes.txt",
          summary: "uploaded attachment",
        }],
      },
    },
  };
}

function memoryRepository() {
  const records = new Map();
  let releases = 0;
  let releasesToFail = 0;

  return {
    async seedDraft(attachmentId) {
      records.set(attachmentId, record({ attachmentId }));
    },
    failNextRelease() {
      releasesToFail += 1;
    },
    releaseCalls() {
      return releases;
    },
    async createDraft(input) {
      const existing = records.get(input.attachmentId);
      if (existing !== undefined) return { record: structuredClone(existing), created: false };
      const created = record({
        attachmentId: input.attachmentId,
        originalName: input.originalName,
        content: input.content,
        createdAt: input.createdAt,
      });
      records.set(input.attachmentId, created);
      return { record: structuredClone(created), created: true };
    },
    async get(attachmentId) {
      const stored = records.get(attachmentId);
      if (stored === undefined) {
        throw new OrdinaryManagedAttachmentRepositoryError(
          "ordinary_managed_attachment_not_found",
          `Managed attachment ${attachmentId} was not found.`,
        );
      }
      return structuredClone(stored);
    },
    async list() {
      return [...records.values()].map((stored) => structuredClone(stored));
    },
    async resolveContentPath() {
      return "unused";
    },
    async claimForConversation(input) {
      const claimed = [];
      const newlyClaimedAttachmentIds = [];
      for (const attachmentId of input.attachmentIds) {
        const current = await this.get(attachmentId);
        if (current.owner.kind === "draft") {
          const next = {
            ...current,
            owner: { kind: "conversation", conversationId: input.conversationId },
            updatedAt: input.claimedAt,
          };
          records.set(attachmentId, next);
          claimed.push(next);
          newlyClaimedAttachmentIds.push(attachmentId);
        } else {
          claimed.push(current);
        }
      }
      return { records: claimed, newlyClaimedAttachmentIds };
    },
    async releaseConversationClaim(input) {
      releases += 1;
      if (releasesToFail > 0) {
        releasesToFail -= 1;
        throw new OrdinaryManagedAttachmentRepositoryError(
          "ordinary_managed_attachment_storage_failure",
          "release failed",
        );
      }
      for (const attachmentId of input.attachmentIds) {
        const current = await this.get(attachmentId);
        records.set(attachmentId, {
          ...current,
          owner: { kind: "draft", instanceId: input.instanceId },
          updatedAt: input.releasedAt,
        });
      }
    },
    async delete(attachmentId) {
      records.delete(attachmentId);
    },
  };
}

function record({
  attachmentId,
  originalName = "notes.txt",
  content = new Uint8Array(),
  createdAt = "2026-08-24T00:00:00.000Z",
}) {
  return {
    schemaVersion: ORDINARY_MANAGED_ATTACHMENT_SCHEMA_VERSION,
    attachmentId,
    owner: { kind: "draft", instanceId: "instance-1" },
    originalName,
    byteLength: content.byteLength,
    sha256: "0".repeat(64),
    createdAt,
    updatedAt: createdAt,
  };
}
