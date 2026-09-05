import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CollaborationRulesError,
  createCollaborationRulesFeature,
  createFileSystemCollaborationRulesRepository,
} from "../dist/app/collaboration-rules/index.js";
import { createCollaborationRulesApplication } from "../dist/app/application/collaboration-rules-application.js";

test("collaboration rules retain user ownership, optimistic concurrency, and owner-deletion fencing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synech-collaboration-rules-"));
  const owner = { kind: "space", id: "space-rules" };
  const feature = createCollaborationRulesFeature({
    repository: createFileSystemCollaborationRulesRepository(root),
    now: () => "2026-09-02T00:00:00.000Z",
  });
  let spaceAvailable = true;
  let admissions = 0;
  const application = createCollaborationRulesApplication({
    rules: feature,
    spaceAdmission: {
      admit: async (_spaceId, operation) => {
        admissions += 1;
        return await operation();
      },
    },
    workspaceAdmission: { admit: async (_workspaceId, operation) => await operation() },
    ownerExistsQuery: {
      isSpaceAvailable: async () => spaceAvailable,
      isWorkspaceAvailable: async () => true,
    },
  });

  try {
    const global = await application.get({ kind: "global" });
    await application.write({
      scope: { kind: "global" },
      content: "默认用简洁、可执行的方式回答。",
      expectedVersion: global.version,
    });

    const local = await application.get(owner);
    const saved = await application.write({
      scope: owner,
      content: "当前 Space 的代码变更必须先验证类型检查。",
      expectedVersion: local.version,
    });
    assert.equal(saved.status, "saved");
    assert.equal(admissions, 1);

    const snapshot = await feature.queries.startupSnapshot(owner);
    assert.ok(snapshot.injection?.includes("[Standing collaboration rules]"));
    assert.ok(snapshot.injection?.includes("默认用简洁、可执行的方式回答。"));
    assert.ok(snapshot.injection?.includes("当前 Space 的代码变更必须先验证类型检查。"));

    const stale = await application.get(owner);
    const updated = await application.write({
      scope: owner,
      content: "当前 Space 的修改必须先验证类型检查和构建。",
      expectedVersion: stale.version,
    });
    assert.equal(updated.status, "saved");
    const conflict = await application.write({
      scope: owner,
      content: "过期写入不得覆盖当前规则。",
      expectedVersion: stale.version,
    });
    assert.equal(conflict.status, "conflict");

    await feature.commands.deleteByOwner(owner);
    const deletedDocument = await feature.queries.get(owner);
    await assert.rejects(
      () => feature.commands.write({
        scope: owner,
        content: "删除期间不得重建规则。",
        expectedVersion: deletedDocument.version,
      }),
      (error) => error instanceof CollaborationRulesError && error.code === "collaboration_rule_owner_deleted",
    );

    spaceAvailable = false;
    await assert.rejects(
      () => application.get(owner),
      (error) => error instanceof CollaborationRulesError && error.code === "collaboration_rule_owner_deleted",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
