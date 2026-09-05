import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { lexicalMatchExpression } from "../dist/app/memory/recall/lexical-projection.js";
import {
  POLICY_KEY,
  createMemoryHistoryQueryPort,
  createSqliteMemoryControlRepository,
  createSqliteMemoryDocumentRepository,
  spaceParticipationKey,
} from "../dist/app/memory/index.js";

/**
 * 历史查询端口（正式设计 §10，E10/E13）：
 * - scope 由宿主注入，跨 Space 读取按结构身份拒绝；
 * - memory 关闭时摘要来源 disabled（不得伪装完整 no_hit），原文工具仍可用；
 * - 读取结果有 token 预算边界并支持续读。
 */

async function withHarness(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-history-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  const enabled = options.consentEnabled ?? true;
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled });
  await control.setPolicy({ key: spaceParticipationKey("s1"), kind: "space_participation", scopeOwnerKey: "space:s1", enabled: true });
  await control.setPolicy({ key: spaceParticipationKey("s2"), kind: "space_participation", scopeOwnerKey: "space:s2", enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });

  const turns = [];
  for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
    turns.push(
      { turnId: `u${ordinal}`, ordinal, role: "user", text: `第${ordinal}轮：讨论安装器设计与预算。`, runId: `r${ordinal}`, occurredAt: "2026-09-05T00:00:00.000Z", sourceRevision: ordinal },
      { turnId: `a${ordinal}`, ordinal, role: "assistant", text: `第${ordinal}轮回复。`, runId: `r${ordinal}`, occurredAt: "2026-09-05T00:00:01.000Z", sourceRevision: ordinal },
    );
  }
  const evidenceReader = {
    async readTurnWindow({ conversationId, fromOrdinal, through }) {
      const selected = turns.filter((turn) => turn.ordinal >= fromOrdinal && turn.ordinal <= through.ordinal);
      return {
        turns: selected,
        nextCursor: selected.length === 0 ? undefined : {
          conversationId,
          coveredThroughOrdinal: selected.at(-1).ordinal,
          sourceFingerprint: `rev:${selected.at(-1).sourceRevision}`,
        },
      };
    },
  };
  const history = createMemoryHistoryQueryPort({
    controlRepository: control,
    documentRepository: documents,
    evidenceReader,
    conversationLookup: {
      resolveConversationOwner: async (conversationId) =>
        conversationId === "c1" ? { kind: "space", id: "s1" }
        : conversationId === "c-other" ? { kind: "space", id: "s2" }
        : undefined,
    },
  });
  try {
    await run({ control, documents, history });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function seed(documents, control) {
  // transcript 索引 + 会话总结 + Space 文档，全部走真实提交/写入边界。
  await documents.indexTranscriptRange({
    conversationId: "c1",
    ownerKey: "space:s1",
    entries: [1, 2, 3, 4, 5, 6].map((ordinal) => ({
      ordinal,
      text: `第${ordinal}轮：讨论安装器设计与预算。`,
      sourceRevision: ordinal,
    })),
    now: 10,
  });
  await control.acceptConversationSignal({
    conversationId: "c1", ownerKey: "space:s1", stableThroughOrdinal: 6,
    sourceFingerprint: "fp", eligibleAt: 100, now: 0,
    generation: 0, policyRevision: "g1:r1:s1:gen0",
  });
  const [queued] = await control.listJobsByStatus("queued");
  const claimToken = "claim-seed";
  await control.claimJob({ jobId: queued.jobId, claimToken, now: 100 });
  const committed = await documents.commitMaintenanceBatch({
    jobId: queued.jobId,
    claimToken,
    conversationId: "c1",
    ownerKey: "space:s1",
    expectedPolicyRevision: "g1:r1:s1:gen0",
    expectedGeneration: 0,
    expectedSummaryRevisionId: null,
    expectedMemoryHeadRevisionId: null,
    summary: { markdown: "c1 的累计总结：围绕安装器设计与预算展开。", coveredThroughOrdinal: 6 },
    longTermUpdate: { markdown: "Space 长期记忆：项目围绕安装器设计与预算展开。" },
    batchRange: { fromOrdinal: 1, toOrdinal: 6, sourceRevision: 6 },
    advanceProgressTo: { ordinal: 6, sourceFingerprint: "rev:6" },
  });
  assert.equal(committed.status, "committed");
  return committed;
}

test("search hits both summary and transcript sources with coverage reporting", async () => {
  await withHarness(async ({ control, documents, history }) => {
    await seed(documents, control);
    const result = await history.search({
      owner: { kind: "space", id: "s1" },
      query: "安装器",
      sources: "all",
      limit: 8,
    });
    assert.equal(result.outcome, "ok");
    assert.equal(result.coverage.summary, "available");
    const types = new Set(result.items.map((item) => item.type));
    assert.ok(types.has("conversation_summary"));
    assert.ok(types.has("raw_excerpt"));
    // 摘要命中明确标注为模型生成摘要。
    const summaryItem = result.items.find((item) => item.type === "conversation_summary");
    assert.ok(summaryItem.text.includes("模型生成摘要"));
  });
});

test("cross-space search returns no items and cross-space read is rejected structurally", async () => {
  await withHarness(async ({ control, documents, history }) => {
    await seed(documents, control);
    const search = await history.search({
      owner: { kind: "space", id: "s2" },
      query: "安装器",
      sources: "all",
      limit: 8,
    });
    assert.equal(search.items.length, 0);
    const read = await history.read({
      owner: { kind: "space", id: "s2" },
      conversationId: "c1",
      source: "summary",
      limitTokens: 4_000,
    });
    assert.equal(read.outcome, "unavailable");
    assert.equal(read.reason, "conversation_outside_scope");
  });
});

test("memory off for a scope: summary source is disabled (degraded, not fake no_hit) while transcript stays available", async () => {
  await withHarness(async ({ control, documents, history }) => {
    await seed(documents, control);
    // s1（Space 参与 + rollout active）：摘要与原文均可用。
    const ok = await history.search({
      owner: { kind: "space", id: "s1" },
      query: "安装器",
      sources: "all",
      limit: 8,
    });
    assert.equal(ok.outcome, "ok");

    // workspace scope 自动记忆恒为 off：摘要来源 disabled、outcome=degraded，
    // 不得伪装成完整 no_hit；原文来源仍报告可用。
    const off = await history.search({
      owner: { kind: "workspace", id: "w1" },
      query: "安装器",
      sources: "all",
      limit: 8,
    });
    assert.equal(off.coverage.summary, "disabled");
    assert.equal(off.outcome, "degraded");
  });
});

test("transcript read is bounded by the token budget and continues from the returned position", async () => {
  await withHarness(async ({ control, documents, history }) => {
    await seed(documents, control);
    const firstPage = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      source: "transcript",
      limitTokens: 60,
    });
    assert.equal(firstPage.outcome, "ok");
    assert.equal(firstPage.truncated, true);
    assert.ok(firstPage.nextFromOrdinal > 1);

    const secondPage = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      source: "transcript",
      fromOrdinal: firstPage.nextFromOrdinal,
      limitTokens: 6_000,
    });
    assert.equal(secondPage.outcome, "ok");
    assert.ok(secondPage.text.includes("第6轮"));
  });
});

test("unknown conversations are unavailable, not fabricated", async () => {
  await withHarness(async ({ history }) => {
    const read = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c-missing",
      source: "transcript",
      limitTokens: 4_000,
    });
    assert.equal(read.outcome, "unavailable");
    assert.equal(read.reason, "conversation_not_found");
  });
});
