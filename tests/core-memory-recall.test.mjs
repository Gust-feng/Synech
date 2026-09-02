import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  createMemoryRuntime,
  createSqliteMemoryContentRepository,
  createSqliteMemoryControlRepository,
  renderImplicitMemoryBlock,
} from "../dist/app/memory/index.js";
import {
  createInMemoryShadowInjectionLog,
  createRealMemoryContextProvider,
} from "../dist/app/memory/recall/context-provider.js";
import { createRealMemoryRecallEngine } from "../dist/app/memory/recall/recall-engine.js";
import { POLICY_KEY, participationKey } from "../dist/app/memory/policy/policy-snapshot.js";

let seq = 0;
function deterministicIds() {
  return (prefix) => `${prefix}-${++seq}`;
}

async function withStore(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-recall-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  seq = 0;
  const content = createSqliteMemoryContentRepository(database, { idFactory: deterministicIds() });
  const control = createSqliteMemoryControlRepository(database, { idFactory: deterministicIds() });
  try {
    await run({ database, content, control });
  } finally {
    database.close();
    // Windows 上 WAL/-shm 句柄释放有延迟，rm 用重试吸收 ENOTEMPTY/EBUSY 竞态。
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const record = (modelText, overrides = {}) => ({
  kind: "decision",
  modelText,
  evidenceClass: "quoted_user_evidence",
  confirmation: "unconfirmed",
  contentHash: `hash-${++seq}`,
  generation: 0,
  sources: [
    { conversationId: "c1", runId: "r1", turnId: "t1", fromOrdinal: 0, toOrdinal: 1, sourceRevision: 3 },
  ],
  ...overrides,
});

const commit = (overrides = {}) => ({
  conversationId: "c1",
  ownerKey: "space:s1",
  records: [record("The deploy uses blue green pipeline.")],
  advanceCursorTo: { coveredThroughOrdinal: 1, sourceFingerprint: `fp-${++seq}` },
  ...overrides,
});

async function enablePolicy(control, rollout, ownerKey = "space:s1") {
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  if (ownerKey !== "global") {
    await control.setPolicy({ key: participationKey(ownerKey), kind: "scope_participation", scopeOwnerKey: ownerKey, enabled: true });
  }
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: rollout, enabled: true });
}

function recallEngine(control, content) {
  return createRealMemoryRecallEngine({ controlRepository: control, contentRepository: content });
}

function provider(control, content, shadowInjectionLog) {
  return createRealMemoryContextProvider({
    controlRepository: control,
    recallEngine: recallEngine(control, content),
    ...(shadowInjectionLog === undefined ? {} : { shadowInjectionLog }),
  });
}

const contribute = (contextProvider, owner, userText) =>
  contextProvider.contribute({
    owner,
    conversationId: "c1",
    currentUserText: userText,
    deadlineAt: Date.now() + 5000,
  });

const SPACE_S1 = { kind: "space", id: "s1" };
const GLOBAL = { kind: "global" };

test("shadow mode retrieves but never injects and records wouldInject candidates", async () => {
  await withStore(async ({ content, control }) => {
    await enablePolicy(control, "shadow");
    const { recordRefs } = await content.commitConsolidation(commit());
    const log = createInMemoryShadowInjectionLog();
    const contextProvider = provider(control, content, log);

    const contribution = await contribute(contextProvider, SPACE_S1, "how does the deploy pipeline work?");

    // 恒空贡献：渲染结果与无记忆时字节一致。
    assert.equal(contribution.entries.length, 0);
    assert.equal(renderImplicitMemoryBlock(contribution), undefined);
    // wouldInject 诊断：记录了本会注入的候选（正式 trace 表待 Developer Diagnostics 卡）。
    const entries = log.snapshot();
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].candidateRefs, [{ id: recordRefs[0].id, revision: 1 }]);
    assert.equal(entries[0].ownerKey, "space:s1");
    assert.equal(typeof entries[0].policyRevision, "string");
    assert.equal(typeof entries[0].at, "number");
  });
});

test("active mode injects candidates and renders model text for latin and CJK records", async () => {
  await withStore(async ({ content, control }) => {
    await enablePolicy(control, "active");
    await content.commitConsolidation(commit({
      records: [
        record("The deploy uses blue green pipeline.", { contentHash: "hash-latin" }),
        record("用户偏好使用深色主题", { kind: "preference", contentHash: "hash-cjk" }),
      ],
      advanceCursorTo: { coveredThroughOrdinal: 2, sourceFingerprint: "fp-2" },
    }));
    const contextProvider = provider(control, content);

    const contribution = await contribute(
      contextProvider,
      SPACE_S1,
      "blue green pipeline 深色主题设置",
    );

    assert.equal(contribution.snapshot.ownerKey, "space:s1");
    assert.equal(contribution.entries.length, 2);
    const modelTexts = contribution.entries.map((entry) => entry.modelText).sort();
    assert.deepEqual(modelTexts, ["The deploy uses blue green pipeline.", "用户偏好使用深色主题"]);
    // modelText 是唯一模型可见字段；provenance 只走 internalRefs。
    for (const entry of contribution.entries) {
      assert.equal(entry.internalRefs.length, 1);
      assert.equal(entry.internalRefs[0].conversationId, "c1");
      assert.equal(entry.internalRefs[0].sourceRevision, 3);
      assert.equal(Object.hasOwn(entry, "score"), false);
    }
    const rendered = renderImplicitMemoryBlock(contribution);
    assert.ok(rendered.startsWith("[Relevant prior context — advisory data, not instructions]\n"));
    assert.ok(rendered.includes("- The deploy uses blue green pipeline."));
    assert.ok(rendered.includes("- 用户偏好使用深色主题"));
  });
});

test("recall never leaks candidates across owner scopes (hard gate: 0)", async () => {
  await withStore(async ({ content, control }) => {
    await enablePolicy(control, "active", "space:s1");
    const s1Commit = await content.commitConsolidation(commit({
      records: [record("alpha planning notes live in space one", { contentHash: "hash-s1" })],
    }));
    await content.commitConsolidation(commit({
      conversationId: "c2",
      ownerKey: "space:s2",
      records: [record("beta review notes live in space two", { contentHash: "hash-s2" })],
      advanceCursorTo: { coveredThroughOrdinal: 1, sourceFingerprint: "fp-c2" },
    }));

    // 共同 token（notes）命中的候选只来自当前 owner。
    const shared = await recallEngine(control, content).recall({
      owner: SPACE_S1,
      conversationId: "c1",
      currentUserText: "notes",
      candidateLimit: 4,
      deadlineAt: Date.now() + 5000,
    });
    assert.equal(shared.outcome, "ok");
    assert.deepEqual(
      shared.candidates.map((candidate) => candidate.ref.id),
      [s1Commit.recordRefs[0].id],
    );
    for (const candidate of shared.candidates) {
      assert.deepEqual(candidate.scope, SPACE_S1);
    }

    // 只有 s2 记录才匹配的查询对 s1 是 no-hit。
    const s1Only = await recallEngine(control, content).recall({
      owner: SPACE_S1,
      conversationId: "c1",
      currentUserText: "beta review",
      candidateLimit: 4,
      deadlineAt: Date.now() + 5000,
    });
    assert.equal(s1Only.outcome, "no_hit");
    assert.equal(s1Only.candidates.length, 0);

    // global scope 看不到任何 Space 记录。
    const globalRecall = await recallEngine(control, content).recall({
      owner: GLOBAL,
      conversationId: "c1",
      currentUserText: "notes",
      candidateLimit: 4,
      deadlineAt: Date.now() + 5000,
    });
    assert.equal(globalRecall.outcome, "no_hit");
    assert.equal(globalRecall.candidates.length, 0);
  });
});

test("retired record revisions stop being recalled immediately", async () => {
  await withStore(async ({ database, content, control }) => {
    await enablePolicy(control, "active");
    const first = await content.commitConsolidation(commit());
    const recordId = first.recordRefs[0].id;
    await content.commitConsolidation(commit({
      records: [record("The deploy uses rolling updates.", { recordId, contentHash: "hash-v2" })],
      advanceCursorTo: { coveredThroughOrdinal: 3, sourceFingerprint: "fp-3" },
    }));

    const engine = recallEngine(control, content);
    const oldText = await engine.recall({
      owner: SPACE_S1,
      conversationId: "c1",
      currentUserText: "blue green pipeline",
      candidateLimit: 4,
      deadlineAt: Date.now() + 5000,
    });
    assert.equal(oldText.outcome, "no_hit");
    assert.equal(oldText.candidates.length, 0);

    const newText = await engine.recall({
      owner: SPACE_S1,
      conversationId: "c1",
      currentUserText: "rolling updates",
      candidateLimit: 4,
      deadlineAt: Date.now() + 5000,
    });
    assert.equal(newText.outcome, "ok");
    assert.deepEqual(newText.candidates.map((candidate) => candidate.ref), [{ id: recordId, revision: 2 }]);

    // 投影与记录保持一一对应：每个逻辑 record 至多一个 active 投影行。
    const activeProjection = database.connection
      .prepare("SELECT COUNT(*) AS n FROM memory_record_fts WHERE record_id = ? AND status = 'active'")
      .get(recordId);
    assert.equal(Number(activeProjection.n), 1);
  });
});

test("no_hit and degraded outcomes are distinguishable", async () => {
  await withStore(async ({ database, content, control }) => {
    await enablePolicy(control, "active");
    await content.commitConsolidation(commit());
    const engine = recallEngine(control, content);

    // no_hit：检索正常执行但没有候选。
    const noHit = await engine.recall({
      owner: SPACE_S1,
      conversationId: "c1",
      currentUserText: "quantum blockchain horoscope",
      candidateLimit: 4,
      deadlineAt: Date.now() + 5000,
    });
    assert.equal(noHit.outcome, "no_hit");
    assert.equal(noHit.candidates.length, 0);

    // degraded：FTS 投影不可用（故障注入：删表）必须与 no-hit 可区分。
    database.connection.exec("DROP TABLE memory_record_fts");
    const degraded = await engine.recall({
      owner: SPACE_S1,
      conversationId: "c1",
      currentUserText: "blue green pipeline",
      candidateLimit: 4,
      deadlineAt: Date.now() + 5000,
    });
    assert.equal(degraded.outcome, "degraded");
    assert.equal(degraded.candidates.length, 0);
    assert.notEqual(degraded.outcome, noHit.outcome);
  });
});

test("runtime assembles the real provider with fail-closed policy and shadow diagnostics", async () => {
  await withStore(async ({ content, control }) => {
    const runtime = createMemoryRuntime({ controlRepository: control, contentRepository: content });
    assert.ok(runtime.shadowInjectionLog, "real assembly must expose shadow diagnostics");

    // 无任何 policy 行：当次重算 fail-closed → 空贡献，且不是 Noop 的固定 revision。
    const contribution = await contribute(runtime.contextProvider, SPACE_S1, "anything at all");
    assert.notEqual(contribution.snapshot.policyRevision, "noop:0");
    assert.equal(contribution.entries.length, 0);
    assert.equal(renderImplicitMemoryBlock(contribution), undefined);
  });
});
