import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { renderMemoryBackgroundBlock } from "../dist/app/memory/index.js";
import { POLICY_KEY, createMemoryCaptureRuntime, createMemoryBackgroundPort, createMemoryHistoryQueryPort, createSqliteMemoryControlRepository, createSqliteMemoryDocumentRepository, maintainConversationJob } from "../dist/app/memory/composition.js";

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
  let modelCalls = 0;
  const model = options.model ?? { async generate({ messages }) {
    modelCalls += 1;
    const payload = JSON.parse(messages.find(message => message.role === "user").content);
    const entryId = payload.availableNewEntryIds[0];
    const evidence = payload.evidence.find(item => item.role === "user");
    return { status: "completed", text: JSON.stringify({ status: "ready",
      conversationSummary: { markdown: "## 累计总结\n用户确认出版项目首批预算 18000 元。", sourceRefs: [evidence.id] },
      mutations: [{ operation: "create", entryId, expectedRevisionId: null, kind: "initial",
        markdown: "[用户陈述] 首批预算上限 18000 元。", applicability: "出版项目", occurredAt: null, reportedAt: evidence.reportedAt,
        reason: null, topicIds: [], related: [], sourceIds: [evidence.sourceId], retractsRevisionIds: [] }], topics: [],
      overview: { markdown: "出版项目首批预算上限 18000 元。", entryIds: [entryId] },
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
    await run({ control, documents, capture, background, history, deps, model, getModelCalls: () => modelCalls });
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
    policyRevision: "g1:r1:gen0",
    ...overrides,
  });
  const [queued] = await control.listJobsByStatus("queued");
  const claimToken = `claim-${queued.jobId}`;
  const job = await control.claimJob({ jobId: queued.jobId, claimToken, now: 200 });
  return { job, claimToken };
}

test("end-to-end: accept → maintain → bind → inject → search/read", async () => {
  await withChain(async ({ control, capture, deps, background, history, documents, getModelCalls }) => {
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
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    assert.equal(outcome.longTermUpdated, true);

    // 3. 新会话绑定当前 head。
    const head = await background.getActiveOwnerMemoryHead({ kind: "space", id: "s1" });
    assert.ok(head.revisionId.length > 0);

    // 4. 背景供给（effective=active + generation 一致）。
    const supplied = await background.resolveSupplyableBackground({
      owner: { kind: "space", id: "s1" },
      revisionId: head.revisionId,
      generation: head.generation,
    });
    assert.ok(supplied !== undefined);
    const block = renderMemoryBackgroundBlock(supplied);
    assert.ok(block.includes("[Memory — historical background]"));
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

    const beforeQueryCalls = getModelCalls();
    const entries = await history.searchEntries({ owner: { kind: "space", id: "s1" }, query: "预算", limit: 8 });
    assert.equal(entries.outcome, "ok");
    assert.equal(entries.items[0].role, "current");
    const entryRead = await history.readEntry({ owner: { kind: "space", id: "s1" }, entryId: entries.items[0].entry.entryId, includeRelated: true, includeHistory: true, limitTokens: 6_000 });
    assert.equal(entryRead.outcome, "ok");
    assert.ok(entryRead.item.revision.markdown.includes("18000"));
    assert.equal(getModelCalls(), beforeQueryCalls, "front queries never call the maintenance model");
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

test("background supply is owner-isolated across Space and second Space", async () => {
  await withChain(async ({ documents, background }) => {
    const publish = async (owner, entryId, markdown) => {
      const result = await documents.recordUserMemoryEdit({ owner, requestId: `r-${entryId}`, expectedGeneration: 0, now: 10,
        edit: { operation: "create", entryId, expectedRevisionId: null, kind: "initial", markdown,
          applicability: null, occurredAt: null, reason: null, topicIds: [], related: [], retractsRevisionIds: [] } });
      return documents.getOwnerMemoryRevision(result.overviewRevisionId);
    };
    const spaceHead = await publish({ kind: "space", id: "s1" }, "entry-space", "# space");
    const workspaceHead = await publish({ kind: "space", id: "s2" }, "entry-workspace", "# workspace");

    // 每个 owner 只读自己的 head。
    assert.equal((await background.getActiveOwnerMemoryHead({ kind: "space", id: "s1" })).revisionId, spaceHead.revisionId);
    assert.equal((await background.getActiveOwnerMemoryHead({ kind: "space", id: "s2" })).revisionId, workspaceHead.revisionId);

    // 用另一个 owner 的 opaque revisionId + 其真实 generation 冒充绑定：结构身份必须拒绝。
    assert.equal(await background.resolveSupplyableBackground({
      owner: { kind: "space", id: "s1" },
      revisionId: workspaceHead.revisionId,
      generation: workspaceHead.generation,
    }), undefined);

    // generation 不一致（clear/删除推进后）同样拒绝，即使 revision 行仍在。
    assert.equal(await background.resolveSupplyableBackground({
      owner: { kind: "space", id: "s1" },
      revisionId: spaceHead.revisionId,
      generation: spaceHead.generation + 1,
    }), undefined);

    // second Space owner 与 space owner 同源：自己的绑定正常供给。
    const supplied = await background.resolveSupplyableBackground({
      owner: { kind: "space", id: "s2" },
      revisionId: workspaceHead.revisionId,
      generation: workspaceHead.generation,
    });
    assert.equal(supplied.markdown, "# workspace");
  });
});
