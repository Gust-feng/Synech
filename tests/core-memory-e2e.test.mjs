import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  POLICY_KEY,
  createMemoryCaptureRuntime,
  createMemoryBackgroundPort,
  createMemoryHistoryQueryPort,
  createSqliteMemoryControlRepository,
  createSqliteMemoryDocumentRepository,
  maintainConversationJob,
  renderMemoryBackgroundBlock,
  spaceParticipationKey,
} from "../dist/app/memory/index.js";

/**
 * 0.6.0 主链路端到端：稳定信号接单（含 transcript 索引）→ 单请求双输出整理
 * → 新会话绑定 memory head → 背景供给 → search_history / read_history。
 */

async function withChain(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-e2e-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: spaceParticipationKey("s1"), kind: "space_participation", scopeOwnerKey: "space:s1", enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });

  const turns = [];
  for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
    turns.push(
      { turnId: `u${ordinal}`, ordinal, role: "user", text: `第${ordinal}轮：出版项目的首批预算是 18000 元。`, runId: `r${ordinal}`, occurredAt: "2026-09-05T00:00:00.000Z", sourceRevision: ordinal },
      { turnId: `a${ordinal}`, ordinal, role: "assistant", text: `第${ordinal}轮已记录（assistant）。`, runId: `r${ordinal}`, occurredAt: "2026-09-05T00:00:01.000Z", sourceRevision: ordinal },
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
  const model = options.model ?? { async generate() {
    return { status: "completed", text: JSON.stringify({
      conversationSummary: { markdown: "## 累计总结\n用户确认出版项目首批预算 18000 元。", sourceRefs: ["source:u1"] },
      longTermUpdate: { markdown: "# Space Memory\n\n## 稳定事实\n- [用户陈述，2026-09-05] 首批预算上限 18000 元。", sourceRefs: ["source:u1"] },
    }) };
  } };
  const deps = {
    controlRepository: control,
    documentRepository: documents,
    evidenceReader,
    model,
    countTokens: (text) => Math.ceil(text.length / 4),
  };
  const capture = createMemoryCaptureRuntime({ controlRepository: control, documentRepository: documents, evidenceReader, now: () => 1_000 });
  const background = createMemoryBackgroundPort({ controlRepository: control, documentRepository: documents });
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
    await run({ control, documents, capture, background, history, deps, model });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function acceptAndClaim(control, overrides = {}) {
  await control.acceptConversationSignal({
    conversationId: "c1",
    ownerKey: "space:s1",
    stableThroughOrdinal: 4,
    sourceFingerprint: "fp",
    eligibleAt: 100,
    now: 0,
    generation: 0,
    policyRevision: "g1:r1:s1:gen0",
    ...overrides,
  });
  const [queued] = await control.listJobsByStatus("queued");
  const claimToken = `claim-${queued.jobId}`;
  const job = await control.claimJob({ jobId: queued.jobId, claimToken, now: 200 });
  return { job, claimToken };
}

test("end-to-end: accept → maintain → bind → inject → search/read", async () => {
  await withChain(async ({ control, capture, deps, background, history, documents }) => {
    // 1. 稳定信号接单。
    const acceptance = await capture.acceptStableSignal({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      stableThrough: { turnId: "u4", ordinal: 4, sourceRevision: 4 },
    });
    assert.equal(acceptance.status, "accepted");

    // 2. 整理批次（一次请求双输出；领取由管线 CAS 完成）。
    const [queued] = await control.listJobsByStatus("queued");
    const outcome = await maintainConversationJob(deps, queued.jobId);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.longTermUpdated, true);

    // 3. 新会话绑定当前 head。
    const head = await background.getActiveSpaceMemoryHead({ kind: "space", id: "s1" });
    assert.ok(head.revisionId.length > 0);

    // 4. 背景供给（effective=active + generation 一致）。
    const supplied = await background.resolveSupplyableBackground({
      owner: { kind: "space", id: "s1" },
      revisionId: head.revisionId,
      generation: head.generation,
    });
    assert.ok(supplied !== undefined);
    const block = renderMemoryBackgroundBlock(supplied);
    assert.ok(block.includes("[Space memory — historical background]"));
    assert.ok(block.includes("18000"));

    // 5. search_history 命中摘要与原文（含 transcript 索引）。
    const search = await history.search({
      owner: { kind: "space", id: "s1" },
      query: "预算 18000",
      sources: "all",
      limit: 8,
    });
    assert.equal(search.outcome, "ok");
    const types = new Set(search.items.map((item) => item.type));
    assert.ok(types.has("conversation_summary"));
    assert.ok(types.has("raw_excerpt"));
    assert.equal(search.coverage.summary, "available");

    // 6. read_history 摘要标注覆盖与未总结增量。
    const read = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      source: "summary",
      limitTokens: 4_000,
    });
    assert.equal(read.outcome, "ok");
    assert.equal(read.coveredThroughOrdinal, 4);

    // 7. read_history 原文按序带 role 与时间。
    const transcript = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      source: "transcript",
      limitTokens: 6_000,
    });
    assert.equal(transcript.outcome, "ok");
    assert.ok(transcript.text.includes("[user · 2026-09-05T00:00:00.000Z]"));

    void documents;
  });
});

test("cross-space access is rejected by structural identity, not by result filtering", async () => {
  await withChain(async ({ history }) => {
    const search = await history.search({
      owner: { kind: "space", id: "s2" },
      query: "预算",
      sources: "all",
      limit: 8,
    });
    assert.equal(search.items.length, 0);

    const read = await history.read({
      owner: { kind: "space", id: "s2" },
      conversationId: "c1",
      source: "transcript",
      limitTokens: 4_000,
    });
    assert.equal(read.outcome, "unavailable");
    assert.equal(read.reason, "conversation_outside_scope");
  });
});
