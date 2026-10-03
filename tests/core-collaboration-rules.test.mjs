import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CollaborationRulesApplicationError,
  CollaborationRulesError,
  collaborationRuleContentVersion,
  createCollaborationRulesFeature,
  createFileSystemCollaborationRulesRepository,
} from "../dist/app/collaboration-rules/index.js";
import { createCollaborationRulesApplication } from "../dist/app/application/collaboration-rules-application.js";
import { createWorkspaceRulesPort } from "../dist/app/panel-server/ordinary/workspace-collaboration-rules.js";
import { inspectSpaceExternalSource } from "../dist/app/spaces/index.js";
import { InMemoryLocalWorkspaceMutationCoordinator } from "../dist/app/tool-center/adapters/local-workspace-mutation-coordinator.js";

const EMPTY_VERSION = collaborationRuleContentVersion("");

function ownerExistsQuery() {
  return { isSpaceAvailable: async () => true, isWorkspaceAvailable: async () => true };
}

test("collaboration rules retain user ownership, optimistic concurrency, and owner-deletion fencing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synech-collaboration-rules-"));
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
    countTokens: (text) => text.length,
  });

  try {
    const global = await application.get({ kind: "global" });
    assert.deepEqual(global.source, { kind: "managed" });
    assert.equal(global.version, EMPTY_VERSION);
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
    assert.deepEqual(saved.document.source, { kind: "managed" });
    assert.equal(admissions, 1);

    const snapshot = await application.startupSnapshot(owner);
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

    const globalBeforeOversize = await application.get({ kind: "global" });
    await assert.rejects(
      () => application.write({
        scope: { kind: "global" },
        content: "x".repeat(2_001),
        expectedVersion: globalBeforeOversize.version,
      }),
      (error) => error instanceof CollaborationRulesApplicationError && error.code === "collaboration_rules_capacity_exceeded",
    );

    await feature.commands.deleteByOwner(owner);
    const deletedDocument = await application.get(owner);
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
    await rm(root);
  }
});

test("Workspace rules are the root AGENTS.md: lease-bound CAS, no internal copy, and no external deletion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synech-workspace-rules-"));
  const managedRoot = path.join(root, "managed");
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const rulesFile = path.join(workspaceRoot, "AGENTS.md");
  const workspaceOwner = { kind: "workspace", id: "workspace-rules" };
  const identity = await inspectSpaceExternalSource(workspaceRoot);

  const feature = createCollaborationRulesFeature({
    repository: createFileSystemCollaborationRulesRepository(managedRoot),
    now: () => "2026-10-02T00:00:00.000Z",
  });

  let invalidated = 0;
  let registeredIdentity = identity.identity;
  const workspaces = {
    queries: {
      async get(workspaceId) {
        return {
          id: workspaceId,
          title: "ws",
          status: "available",
          visibility: "listed",
          createdAt: "2026-10-02T00:00:00.000Z",
          updatedAt: "2026-10-02T00:00:00.000Z",
          currentMount: {
            workspaceId,
            mountVersion: "mount-1",
            rootPath: workspaceRoot,
            sourceIdentity: registeredIdentity,
            status: "active",
            connectedAt: "2026-10-02T00:00:00.000Z",
          },
        };
      },
    },
    commands: {
      async invalidateMount() {
        invalidated += 1;
      },
    },
  };
  const coordinator = new InMemoryLocalWorkspaceMutationCoordinator();
  let leaseDepth = 0;
  const leaseTrace = [];
  const port = createWorkspaceRulesPort({
    workspaces,
    mutations: {
      async runExclusive(absolutePath, operation) {
        leaseDepth += 1;
        leaseTrace.push(absolutePath);
        try {
          return await coordinator.runExclusive(absolutePath, operation);
        } finally {
          leaseDepth -= 1;
        }
      },
    },
  });
  let tokenCount = 10;
  const application = createCollaborationRulesApplication({
    rules: feature,
    spaceAdmission: { admit: async (_spaceId, operation) => await operation() },
    workspaceAdmission: { admit: async (_workspaceId, operation) => await operation() },
    ownerExistsQuery: ownerExistsQuery(),
    workspaceRules: port,
    countTokens: () => tokenCount,
  });

  try {
    const missing = await application.get(workspaceOwner);
    assert.equal(missing.content, "");
    assert.equal(missing.version, EMPTY_VERSION);
    assert.equal(missing.updatedAt, undefined);
    assert.deepEqual(missing.source, { kind: "workspace_file", path: rulesFile });
    assert.equal(await exists(rulesFile), false, "reading rules must not create the file");
    assert.deepEqual(leaseTrace, [workspaceRoot], "reads take the same path lease as writes");

    const saved = await application.write({
      scope: workspaceOwner,
      content: "# 协作规则\n\n- 先给结论",
      expectedVersion: EMPTY_VERSION,
    });
    assert.equal(saved.status, "saved");
    assert.equal(await fs.readFile(rulesFile, "utf8"), "# 协作规则\n\n- 先给结论");
    assert.deepEqual(saved.document.source, { kind: "workspace_file", path: rulesFile });
    assert.equal(saved.document.version, collaborationRuleContentVersion("# 协作规则\n\n- 先给结论"));
    assert.equal(leaseTrace.at(-1), workspaceRoot, "the mutation runs under the shared path lease");
    assert.equal(leaseDepth, 0);

    const staleConflict = await application.write({
      scope: workspaceOwner,
      content: "过期写入",
      expectedVersion: EMPTY_VERSION,
    });
    assert.equal(staleConflict.status, "conflict");
    assert.equal(await fs.readFile(rulesFile, "utf8"), "# 协作规则\n\n- 先给结论");

    await fs.writeFile(rulesFile, "外部编辑", "utf8");
    const externalConflict = await application.delete({
      scope: workspaceOwner,
      expectedVersion: saved.document.version,
    });
    assert.equal(externalConflict.status, "conflict");
    assert.equal(await fs.readFile(rulesFile, "utf8"), "外部编辑", "conflict must not overwrite external edits");

    registeredIdentity = "dev:0:ino:0";
    await assert.rejects(
      () => application.write({
        scope: workspaceOwner,
        content: "挂载已变化",
        expectedVersion: collaborationRuleContentVersion("外部编辑"),
      }),
      (error) => error instanceof CollaborationRulesApplicationError && error.code === "collaboration_rules_scope_unavailable",
    );
    assert.equal(await fs.readFile(rulesFile, "utf8"), "外部编辑");
    assert.ok(invalidated >= 1, "a replaced directory invalidates the Workspace mount");
    registeredIdentity = identity.identity;

    const current = await application.get(workspaceOwner);
    const cleared = await application.delete({ scope: workspaceOwner, expectedVersion: current.version });
    assert.equal(cleared.status, "deleted");
    assert.equal(cleared.document.content, "");
    assert.equal(cleared.document.version, EMPTY_VERSION);
    assert.equal(await exists(rulesFile), true, "clearing keeps the user's AGENTS.md");
    assert.equal(await fs.readFile(rulesFile, "utf8"), "");

    await fs.writeFile(rulesFile, "保留内容", "utf8");
    await feature.commands.deleteByOwner(workspaceOwner);
    assert.equal(await fs.readFile(rulesFile, "utf8"), "保留内容", "Workspace deletion never unlinks the external file");
    assert.equal(await exists(path.join(managedRoot, "workspaces")), false, "no internal workspace RULES.md copy is created");

    // Over-budget Workspace content fails explicitly on write and on read; nothing is truncated.
    tokenCount = 8_001;
    await assert.rejects(
      () => application.write({
        scope: workspaceOwner,
        content: "超预算内容",
        expectedVersion: collaborationRuleContentVersion("保留内容"),
      }),
      (error) => error instanceof CollaborationRulesApplicationError && error.code === "collaboration_rules_capacity_exceeded",
    );
    assert.equal(await fs.readFile(rulesFile, "utf8"), "保留内容");
    await assert.rejects(
      () => application.get(workspaceOwner),
      (error) => error instanceof CollaborationRulesApplicationError && error.code === "collaboration_rules_capacity_exceeded",
    );
    assert.deepEqual((await application.startupSnapshot({ kind: "space", id: "space-rules" })).injection, undefined);
    tokenCount = 10;

    const unwired = createCollaborationRulesApplication({
      rules: feature,
      spaceAdmission: { admit: async (_spaceId, operation) => await operation() },
      workspaceAdmission: { admit: async (_workspaceId, operation) => await operation() },
      ownerExistsQuery: ownerExistsQuery(),
      countTokens: () => tokenCount,
    });
    await assert.rejects(
      () => unwired.get(workspaceOwner),
      (error) => error instanceof CollaborationRulesApplicationError && error.code === "collaboration_rules_scope_unsupported",
    );
    assert.deepEqual((await unwired.startupSnapshot({ kind: "space", id: "space-rules" })).injection, undefined);
  } finally {
    await rm(root);
  }
});

test("Workspace rules refuse a root file that leaves the workspace directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synech-workspace-rules-link-"));
  const workspaceRoot = path.join(root, "workspace");
  const outside = path.join(root, "outside-rules.md");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(outside, "外部文件", "utf8");
  try {
    await fs.symlink(outside, path.join(workspaceRoot, "AGENTS.md"), "file");
  } catch {
    t.skip("filesystem does not allow creating symlinks in this environment");
    await rm(root);
    return;
  }
  const identity = await inspectSpaceExternalSource(workspaceRoot);
  const workspaceOwner = { kind: "workspace", id: "workspace-rules-link" };
  const application = createCollaborationRulesApplication({
    rules: createCollaborationRulesFeature({
      repository: createFileSystemCollaborationRulesRepository(path.join(root, "managed")),
    }),
    spaceAdmission: { admit: async (_spaceId, operation) => await operation() },
    workspaceAdmission: { admit: async (_workspaceId, operation) => await operation() },
    ownerExistsQuery: ownerExistsQuery(),
    workspaceRules: createWorkspaceRulesPort({
      workspaces: {
        queries: {
          async get(workspaceId) {
            return {
              id: workspaceId,
              title: "ws",
              status: "available",
              visibility: "listed",
              createdAt: "2026-10-02T00:00:00.000Z",
              updatedAt: "2026-10-02T00:00:00.000Z",
              currentMount: {
                workspaceId,
                mountVersion: "mount-1",
                rootPath: workspaceRoot,
                sourceIdentity: identity.identity,
                status: "active",
                connectedAt: "2026-10-02T00:00:00.000Z",
              },
            };
          },
        },
        commands: { async invalidateMount() {} },
      },
      mutations: new InMemoryLocalWorkspaceMutationCoordinator(),
    }),
    countTokens: (text) => text.length,
  });
  try {
    await assert.rejects(
      () => application.write({ scope: workspaceOwner, content: "不得写入", expectedVersion: EMPTY_VERSION }),
      (error) => error instanceof CollaborationRulesApplicationError && error.code === "collaboration_rules_scope_unsupported",
    );
    assert.equal(await fs.readFile(outside, "utf8"), "外部文件");
  } finally {
    await rm(root);
  }
});

test("Workspace rule reads re-verify mount identity after waiting for the lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synech-workspace-rules-lease-"));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const rulesFile = path.join(workspaceRoot, "AGENTS.md");
  await fs.writeFile(rulesFile, "等待前内容", "utf8");
  const identity = await inspectSpaceExternalSource(workspaceRoot);
  const workspaceOwner = { kind: "workspace", id: "workspace-rules-lease" };
  let registeredIdentity = identity.identity;
  const workspace = {
    id: workspaceOwner.id,
    title: "ws",
    status: "available",
    visibility: "listed",
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    currentMount: {
      workspaceId: workspaceOwner.id,
      mountVersion: "mount-1",
      rootPath: workspaceRoot,
      sourceIdentity: identity.identity,
      status: "active",
      connectedAt: "2026-10-02T00:00:00.000Z",
    },
  };
  const coordinator = new InMemoryLocalWorkspaceMutationCoordinator();
  const application = createCollaborationRulesApplication({
    rules: createCollaborationRulesFeature({
      repository: createFileSystemCollaborationRulesRepository(path.join(root, "managed")),
    }),
    spaceAdmission: { admit: async (_spaceId, operation) => await operation() },
    workspaceAdmission: { admit: async (_workspaceId, operation) => await operation() },
    ownerExistsQuery: ownerExistsQuery(),
    workspaceRules: createWorkspaceRulesPort({
      workspaces: {
        queries: {
          async get() {
            return { ...workspace, currentMount: { ...workspace.currentMount, sourceIdentity: registeredIdentity } };
          },
        },
        commands: { async invalidateMount() {} },
      },
      mutations: coordinator,
    }),
    countTokens: (text) => text.length,
  });

  try {
    let releaseLease;
    const blocker = coordinator.runExclusive(workspaceRoot, async () =>
      await new Promise((resolve) => { releaseLease = resolve; }));
    const pendingRead = application.get(workspaceOwner);
    await new Promise((resolve) => setImmediate(resolve));
    // The registered directory is replaced while the read waits for the lease.
    registeredIdentity = "dev:0:ino:0";
    releaseLease();
    await assert.rejects(
      pendingRead,
      (error) => error instanceof CollaborationRulesApplicationError && error.code === "collaboration_rules_scope_unavailable",
    );
    assert.equal(await fs.readFile(rulesFile, "utf8"), "等待前内容");
    await blocker;
  } finally {
    await rm(root);
  }
});

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function rm(target) {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}