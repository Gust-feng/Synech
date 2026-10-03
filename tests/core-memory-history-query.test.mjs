import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { lexicalMatchExpression } from "../dist/app/memory/recall/lexical-projection.js";
import { historyCountTokens } from "../dist/app/memory/history/history-query-port.js";
import { POLICY_KEY, createControlMemoryLifecycle, createMemoryHistoryQueryPort, createSqliteMemoryControlRepository, createSqliteMemoryDocumentRepository } from "../dist/app/memory/composition.js";

/**
 * 历史查询端口（正式设计 §10，E10/E13）：
 * - scope 由宿主注入（Space 与 Workspace 同源），跨 owner 读取按结构身份拒绝；
 * - memory 关闭时摘要与原文来源都 disabled（不得伪装完整 no_hit）；
 * - 读取结果有 token 预算边界并支持续读。
 */

async function withHarness(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-history-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  const enabled = options.consentEnabled ?? true;
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });

  const turns = [];
  for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
    turns.push(
      { turnId: `u${ordinal}`, ordinal, role: "user", text: `第${ordinal}轮：讨论安装器设计与预算。`, runId: `r${ordinal}`, occurredAt: "2026-09-05T00:00:00.000Z", sourceRevision: ordinal },
      { turnId: `a${ordinal}`, ordinal, role: "assistant", text: `第${ordinal}轮回复。`, runId: `r${ordinal}`, occurredAt: "2026-09-05T00:00:01.000Z", sourceRevision: ordinal },
    );
  }
  const turnsByConversation = new Map([[ "c1", turns ]]);
  if (options.extraConversation !== undefined) {
    const extra = options.extraConversation;
    turnsByConversation.set(extra.conversationId, extra.turns.map((turn) => ({
      turnId: `u-${extra.conversationId}-${turn.ordinal}`,
      ordinal: turn.ordinal,
      role: turn.role,
      text: turn.text,
      runId: `r-${extra.conversationId}-${turn.ordinal}`,
      occurredAt: turn.occurredAt,
      sourceRevision: turn.ordinal,
    })));
  }
  const evidenceReader = {
    async readTurnWindow({ conversationId, fromOrdinal, through }) {
      await options.beforeEvidenceRead?.(conversationId);
      const source = turnsByConversation.get(conversationId) ?? [];
      const selected = source.filter((turn) => turn.ordinal >= fromOrdinal && turn.ordinal <= through.ordinal);
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
  for (const [conversationId, evidence] of turnsByConversation) {
    await documents.indexTranscriptRange({
      conversationId, ownerKey: "space:s1",
      entries: evidence.filter(turn => turn.role === "user").map(turn => ({ ordinal: turn.ordinal, text: turn.text, sourceRevision: turn.sourceRevision })),
      publication: { policyRevision: "g1:r1:gen0", generation: 0, conversationGeneration: 0 }, now: 0,
    });
  }
  const history = createMemoryHistoryQueryPort({
    controlRepository: control,
    documentRepository: documents,
    evidenceReader,
    conversationLookup: {
      resolveConversationOwner: async (conversationId) =>
        conversationId === "c1" || conversationId === "c2" ||
        conversationId.startsWith("c-huge") || conversationId.startsWith("c-many") || conversationId.startsWith("c-emoji")
          ? { kind: "space", id: "s1" }
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

async function seed(documents, control, options = {}) {
  // transcript 索引 + 会话总结 + Space 文档，全部走真实提交/写入边界。
  await documents.indexTranscriptRange({
    conversationId: "c1",
    ownerKey: "space:s1",
    publication: { policyRevision: "g1:r1:gen0", generation: 0, conversationGeneration: 0 },
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
    generation: 0, policyRevision: "g1:r1:gen0",
  });
  const [queued] = await control.listJobsByStatus("queued");
  const claimToken = "claim-seed";
  await control.claimJob({ jobId: queued.jobId, claimToken, now: 100 });
  const committed = await documents.commitMaintenanceBatch({
    jobId: queued.jobId,
    claimToken,
    conversationId: "c1",
    ownerKey: "space:s1",
    expectedPolicyRevision: "g1:r1:gen0",
    expectedGeneration: 0,
    expectedSummaryRevisionId: null,
    expectedMemoryHeadRevisionId: null,
    summary: { markdown: options.summaryMarkdown ?? "c1 的累计总结：围绕安装器设计与预算展开。", coveredThroughOrdinal: 6 },
    expectedConversationGeneration: 0,
    readSet: [], entryReadSet: [], topics: [],
    sources: Array.from({ length: options.sourceCount ?? 1 }, (_, index) => ({ sourceId: index === 0 ? "source-c1" : `source-c1-${index}`, owner: { kind: "space", id: "s1" },
      locator: { kind: "conversation_range", conversationId: "c1", fromOrdinal: 1, toOrdinal: 6, sourceRevision: 6, conversationGeneration: 0 },
      lifecycle: "present", branch: "selected", createdAt: 100 })),
    mutations: [{ operation: "create", entryId: "entry-c1", revisionId: "revision-c1", expectedRevisionId: null, kind: "initial",
      markdown: "项目围绕安装器设计与预算展开。", applicability: null, occurredAt: null, reportedAt: "2026-09-05T00:00:00.000Z",
      reason: null, topicIds: [], related: [], sourceIds: Array.from({ length: options.sourceCount ?? 1 }, (_, index) => index === 0 ? "source-c1" : `source-c1-${index}`), retractsRevisionIds: [] }],
    overview: { markdown: "Space 长期记忆：项目围绕安装器设计与预算展开。", entries: [{ entryId: "entry-c1", revisionId: "revision-c1" }] },
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

test("history search drops evidence if the global switch closes while evidence is being read", async () => {
  let signalEvidenceRead;
  let releaseEvidenceRead;
  const evidenceReadStarted = new Promise((resolve) => { signalEvidenceRead = resolve; });
  const evidenceReadGate = new Promise((resolve) => { releaseEvidenceRead = resolve; });

  await withHarness(async ({ control, documents, history }) => {
    await seed(documents, control);
    const pendingSearch = history.search({
      owner: { kind: "space", id: "s1" },
      query: "安装器",
      sources: "transcript",
      limit: 8,
    });

    await evidenceReadStarted;
    await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: false });
    releaseEvidenceRead();

    const result = await pendingSearch;
    assert.equal(result.outcome, "degraded");
    assert.deepEqual(result.coverage, { summary: "disabled", transcript: "disabled" });
    assert.deepEqual(result.items, []);
  }, {
    beforeEvidenceRead: async () => {
      signalEvidenceRead();
      await evidenceReadGate;
    },
  });
});

test("history read rejects evidence when the target conversation generation changes during an await", async () => {
  let signalEvidenceRead;
  let releaseEvidenceRead;
  const evidenceReadStarted = new Promise((resolve) => { signalEvidenceRead = resolve; });
  const evidenceReadGate = new Promise((resolve) => { releaseEvidenceRead = resolve; });

  await withHarness(async ({ control, documents, history }) => {
    await seed(documents, control);
    const lifecycle = createControlMemoryLifecycle(control, { documentRepository: documents });
    const pendingRead = history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      source: "transcript",
      limitTokens: 4_000,
    });

    await evidenceReadStarted;
    // Branch retirement fences old evidence requests and restores participation at a higher generation.
    await lifecycle.supersedeConversationSources({
      conversationId: "c1", owner: { kind: "space", id: "s1" }, retainedThroughOrdinal: 6,
    });
    const lifecycleRow = await control.getLifecycle("conversation:c1");
    assert.equal(lifecycleRow.fenceState, "none");
    assert.equal(lifecycleRow.generation, 1);
    releaseEvidenceRead();

    const result = await pendingRead;
    assert.equal(result.outcome, "unavailable");
    assert.equal(result.reason, "conversation_changed");
  }, {
    beforeEvidenceRead: async () => {
      signalEvidenceRead();
      await evidenceReadGate;
    },
  });
});

test("memory off globally: history search and read are blocked for both summary and transcript", async () => {
  await withHarness(async ({ control, documents, history }) => {
    await seed(documents, control);
    // s1（全局开关开启 + rollout active）：摘要与原文均可用。
    const ok = await history.search({
      owner: { kind: "space", id: "s1" },
      query: "安装器",
      sources: "all",
      limit: 8,
    });
    assert.equal(ok.outcome, "ok");
    assert.equal(ok.coverage.summary, "available");
    assert.notEqual(ok.coverage.transcript, "disabled");

    // ADR 0018：Space 与 Workspace 同源，只有全局开关。关掉后记忆供给整体停止：
    // 摘要与 transcript 都 disabled、outcome=degraded（不伪装完整 no_hit），
    // read 两个来源都 unavailable——工具不得绕开用户开关继续读历史。
    await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: false });
    const off = await history.search({
      owner: { kind: "workspace", id: "w1" },
      query: "安装器",
      sources: "all",
      limit: 8,
    });
    assert.equal(off.coverage.summary, "disabled");
    assert.equal(off.coverage.transcript, "disabled");
    assert.equal(off.outcome, "degraded");
    assert.equal(off.items.length, 0);

    const offSummary = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      source: "summary",
      limitTokens: 4_000,
    });
    assert.equal(offSummary.outcome, "unavailable");
    assert.equal(offSummary.reason, "summary_disabled");

    const offTranscript = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      source: "transcript",
      limitTokens: 4_000,
    });
    assert.equal(offTranscript.outcome, "unavailable");
    assert.equal(offTranscript.reason, "transcript_disabled");
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
    assert.ok(firstPage.nextFromOrdinal >= 1);

    const secondPage = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      source: "transcript",
      fromOrdinal: firstPage.nextFromOrdinal,
      fragmentStart: firstPage.nextFragmentStart,
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

test("R12: conversation-scoped search filters before the limit, not after", async () => {
  await withHarness(async ({ control, documents, history }) => {
    await seed(documents, control);
    // c2（同 Space）制造 10 个更强的命中，占满全 Space 的 top-k。
    await documents.indexTranscriptRange({
      conversationId: "c2", ownerKey: "space:s1",
      publication: { policyRevision: "g1:r1:gen0", generation: 0, conversationGeneration: 0 },
      entries: Array.from({ length: 10 }, (_, index) => ({
        ordinal: index + 1,
        text: `安装器 安装器 安装器 设计第${index + 1}条。`,
        sourceRevision: index + 1,
      })),
      now: 30,
    });
    const result = await history.search({
      owner: { kind: "space", id: "s1" },
      query: "安装器",
      conversationId: "c1",
      sources: "transcript",
      limit: 8,
    });
    assert.equal(result.outcome, "ok");
    assert.ok(result.items.length > 0, "scoped search must find the target conversation's hits");
    assert.ok(result.items.every((item) => item.conversationId === "c1"));
  });
});

test("R13: caller limit is respected and all sources participate in candidate selection", async () => {
  await withHarness(async ({ control, documents, history }) => {
    await seed(documents, control);
    const limited = await history.search({
      owner: { kind: "space", id: "s1" },
      query: "安装器",
      sources: "all",
      limit: 1,
    });
    assert.equal(limited.items.length, 1);

    const full = await history.search({
      owner: { kind: "space", id: "s1" },
      query: "安装器",
      sources: "all",
      limit: 8,
    });
    const types = new Set(full.items.map((item) => item.type));
    assert.ok(types.has("conversation_summary") && types.has("raw_excerpt"),
      "round-robin merge must let both source types into the results");
  });
});

test("R11: pagination covers every message without gaps, repeats or empty pages", async () => {
  await withHarness(async ({ history }) => {
    const pages = [];
    let fromOrdinal;
    for (let page = 0; page < 12; page += 1) {
      const result = await history.read({
        owner: { kind: "space", id: "s1" },
        conversationId: "c1",
        source: "transcript",
        ...(fromOrdinal === undefined ? {} : { fromOrdinal }),
        limitTokens: 300,
      });
      if (result.outcome !== "ok") break;
      assert.ok(result.text.length > 0, "a page must never be empty");
      pages.push(result);
      if (!result.truncated || result.nextFromOrdinal === undefined) break;
      assert.ok(result.nextFromOrdinal > (fromOrdinal ?? 1), "continuation must advance");
      fromOrdinal = result.nextFromOrdinal;
    }
    const joined = pages.map((page) => page.text).join("\n");
    for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
      assert.ok(joined.includes(`第${ordinal}轮`), `ordinal ${ordinal} must appear in some page`);
    }
  });
});

test("N01: an oversized message is fragment-continuable — all pages reassemble the full text", async () => {
  const fullText = Array.from({ length: 500 }, (_, index) => `记录${index}：\"条件未变\"，路径 C:\\项目\\资料\t🦊。`).join("\n");
  const expected = `[user · 2026-09-05T00:00:00.000Z]\n${fullText}\n\n[assistant · 2026-09-05T00:00:01.000Z]\n第1轮回复。`;
  await withHarness(async ({ history }) => {
    for (const limitTokens of [100, 4_000]) {
      const pages = [];
      let cursor = { fromOrdinal: 1, fragmentStart: undefined };
      let complete = false;
      for (let page = 0; page < 500; page += 1) {
        const result = await history.read({
          owner: { kind: "space", id: "s1" },
          conversationId: "c-huge",
          source: "transcript",
          fromOrdinal: cursor.fromOrdinal,
          ...(cursor.fragmentStart === undefined ? {} : { fragmentStart: cursor.fragmentStart }),
          limitTokens,
        });
        assert.equal(result.outcome, "ok");
        assert.ok(result.text.length > 0, "a page must never be empty");
        assert.ok(historyCountTokens(JSON.stringify({ status: "ok", ...result })) <= limitTokens);
        pages.push(result.text);
        if (!result.truncated) { complete = true; break; }
        assert.ok(result.nextFromOrdinal !== undefined, "every truncated transcript must be continuable");
        assert.ok(
          result.nextFromOrdinal > cursor.fromOrdinal ||
            (result.nextFromOrdinal === cursor.fromOrdinal && (result.nextFragmentStart ?? 0) > (cursor.fragmentStart ?? 0)),
          "continuation must advance within the ordinal or move to the next one",
        );
        cursor = { fromOrdinal: result.nextFromOrdinal, fragmentStart: result.nextFragmentStart };
      }
      assert.ok(complete, "pagination must reach the end");
      assert.equal(pages.join(""), expected, "every character must be returned exactly once");
    }
  }, {
    extraConversation: {
      conversationId: "c-huge",
      ownerKey: "space:s1",
      turns: [
        { ordinal: 1, role: "user", text: fullText, occurredAt: "2026-09-05T00:00:00.000Z" },
        { ordinal: 1, role: "assistant", text: "第1轮回复。", occurredAt: "2026-09-05T00:00:01.000Z" },
      ],
    },
  });
});

test("R11: the scan-span end probes for more messages instead of claiming the end", async () => {
  await withHarness(async ({ history }) => {
    // 201 轮短消息 > 200 的扫描跨度：第一页必须给出续读位置。
    const first = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c-many",
      source: "transcript",
      limitTokens: 6_000,
    });
    assert.equal(first.outcome, "ok");
    assert.equal(first.truncated, true);
    assert.equal(first.nextFromOrdinal, 201);
    const second = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c-many",
      source: "transcript",
      fromOrdinal: first.nextFromOrdinal,
      limitTokens: 6_000,
    });
    assert.equal(second.outcome, "ok");
    assert.ok(second.text.includes("第201轮"));
    const expected = Array.from({ length: 201 }, (_, index) =>
      `[user · 2026-09-05T00:00:00.000Z]\n第${index + 1}轮短消息。`).join("\n\n");
    assert.equal(first.text + second.text, expected, "span continuation preserves separators exactly");
    assert.ok(historyCountTokens(JSON.stringify({ status: "ok", ...first })) <= 6_000);
  }, {
    extraConversation: {
      conversationId: "c-many",
      ownerKey: "space:s1",
      turns: Array.from({ length: 201 }, (_, index) => ({
        ordinal: index + 1,
        role: "user",
        text: `第${index + 1}轮短消息。`,
        occurredAt: "2026-09-05T00:00:00.000Z",
      })),
    },
  });
});

test("N03: the serialized tool result — not just the text — respects the token budget", async () => {
  await withHarness(async ({ control, documents, history }) => {
    await seed(documents, control);
    // emoji 在字符近似估算下严重低估（R14 复现）；以完整序列化结果计数。
    const result = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c-emoji",
      source: "transcript",
      limitTokens: 6_000,
    });
    assert.equal(result.outcome, "ok");
    const serialized = JSON.stringify({ status: "ok", ...result });
    const actual = historyCountTokens(serialized);
    assert.ok(actual <= 6_000, `serialized tool result must stay within budget (actual ${actual})`);

    const summaryRead = await history.read({
      owner: { kind: "space", id: "s1" },
      conversationId: "c1",
      source: "summary",
      limitTokens: 100,
    });
    assert.equal(summaryRead.outcome, "ok");
    const summarySerialized = JSON.stringify({ status: "ok", ...summaryRead });
    assert.ok(historyCountTokens(summarySerialized) <= 100,
      `summary envelope must stay within budget (actual ${historyCountTokens(summarySerialized)})`);
  }, {
    extraConversation: {
      conversationId: "c-emoji",
      ownerKey: "space:s1",
      turns: [{ ordinal: 1, role: "user", text: "🦊🐶🐹".repeat(800), occurredAt: "2026-09-05T00:00:00.000Z" }],
    },
  });
});

async function createUserEntry(documents, entryId, markdown, options = {}) {
  return documents.recordUserMemoryEdit({ owner: options.owner ?? { kind: "space", id: "s1" },
    requestId: options.requestId ?? `request-${entryId}`, expectedGeneration: 0, now: 100,
    edit: { operation: options.expectedRevisionId ? "revise" : "create", entryId,
      expectedRevisionId: options.expectedRevisionId ?? null, kind: options.kind ?? "initial", markdown,
      applicability: null, occurredAt: null, reason: null, topicIds: [], related: [],
      retractsRevisionIds: options.retractsRevisionIds ?? [] } });
}

test("entry budget continuations reassemble immutable text and bind owner/filter/generation", async () => {
  await withHarness(async ({ history, documents, control }) => {
    const markdown = Array.from({ length: 140 }, (_, index) => `预算记录${index}：条件未变，路径 C:\\资料\\项目。`).join("\n");
    const published = await createUserEntry(documents, "entry-long", markdown);
    const pages = [];
    let cursor;
    for (let page = 0; page < 100; page += 1) {
      const result = await history.readEntry({ owner: { kind: "space", id: "s1" }, entryId: "entry-long", limitTokens: 1_000, ...(cursor ? { cursor } : {}) });
      assert.equal(result.outcome, "ok");
      assert.ok(historyCountTokens(JSON.stringify({ status: "ok", ...result })) <= 1_000);
      pages.push(result.item.revision.markdown);
      if (!result.truncated) { cursor = undefined; break; }
      assert.ok(result.nextCursor && result.nextCursor !== cursor);
      cursor = result.nextCursor;
    }
    assert.equal(cursor, undefined, "must reach the end");
    assert.equal(pages.join(""), markdown);
    const first = await history.readEntry({ owner: { kind: "space", id: "s1" }, entryId: "entry-long", limitTokens: 1_000 });
    const wrongOwner = await history.readEntry({ owner: { kind: "space", id: "s2" }, entryId: "entry-long", limitTokens: 1_000, cursor: first.nextCursor });
    assert.equal(wrongOwner.outcome, "unavailable");
    await control.fenceForRemoval("space:s1");
    const cleared = await history.readEntry({ owner: { kind: "space", id: "s1" }, entryId: "entry-long", limitTokens: 1_000, cursor: first.nextCursor });
    assert.notEqual(cleared.outcome, "ok");
    assert.ok(published.revisionId);
  });
});

test("source deletion retains entry queries, superseded branches return historical roles, and fenced originals are unavailable", async () => {
  await withHarness(async ({ history, documents, control }) => {
    await seed(documents, control);
    const lifecycle = createControlMemoryLifecycle(control, { documentRepository: documents });
    await lifecycle.supersedeConversationSources({ owner: { kind: "space", id: "s1" }, conversationId: "c1", retainedThroughOrdinal: 0 });
    const current = await history.searchEntries({ owner: { kind: "space", id: "s1" }, query: "安装器", limit: 8 });
    assert.equal(current.outcome, "no_hit");
    const historical = await history.searchEntries({ owner: { kind: "space", id: "s1" }, query: "安装器", includeHistory: true, limit: 8 });
    assert.equal(historical.outcome, "ok");
    assert.equal(historical.items[0].role, "historical");
    assert.equal(historical.items[0].currentRevisionId, null);
    const ticket = await lifecycle.prepareConversationRemoval("c1");
    for (const source of ["summary", "transcript"]) {
      const read = await history.read({ owner: { kind: "space", id: "s1" }, conversationId: "c1", source, limitTokens: 4_000 });
      assert.equal(read.outcome, "unavailable");
    }
    await lifecycle.finalizeConversationRemoval(ticket);
    const afterDelete = await history.readEntry({ owner: { kind: "space", id: "s1" }, entryId: "entry-c1", revisionId: "revision-c1", includeHistory: true, limitTokens: 6_000 });
    assert.equal(afterDelete.outcome, "ok");
    assert.equal(afterDelete.item.role, "historical");
    assert.equal(afterDelete.item.sources[0].lifecycle, "deleted");
    assert.equal(afterDelete.item.sources[0].branch, "superseded");
  });
});

test("80 actual published sources remain searchable and completely readable within the normal 4000-token budget", async () => {
  await withHarness(async ({ history, documents, control }) => {
    await seed(documents, control, { sourceCount: 80 });
    for (const mode of ["search", "read"]) {
      const seen = new Set();
      let cursor;
      let completed = false;
      let text = "";
      for (let page = 0; page < 100; page += 1) {
        const result = mode === "search"
          ? await history.searchEntries({ owner: { kind: "space", id: "s1" }, query: "安装器", limit: 8, ...(cursor ? { cursor } : {}) })
          : await history.readEntry({ owner: { kind: "space", id: "s1" }, entryId: "entry-c1", limitTokens: 4_000, ...(cursor ? { cursor } : {}) });
        assert.equal(result.outcome, "ok");
        assert.ok(historyCountTokens(JSON.stringify({ status: "ok", ...result })) <= 4_000);
        const item = mode === "search" ? result.items[0] : result.item;
        assert.equal(item.sourceSummary.total, 80);
        assert.ok(item.sources.length <= 8);
        assert.deepEqual(item.revision.sourceIds, item.sources.map(source => source.sourceId));
        text += item.revision.markdown;
        item.sources.forEach(source => seen.add(source.sourceId));
        if (!result.truncated) { completed = true; break; }
        assert.ok(result.nextCursor && result.nextCursor !== cursor);
        cursor = result.nextCursor;
      }
      assert.equal(completed, true);
      assert.equal(seen.size, 80, "every source remains reachable");
      assert.equal(text, "项目围绕安装器设计与预算展开。", "source-only continuation never repeats the body");
    }
  });
});

test("summary continuation preserves every character with the serialized cursor in its budget", async () => {
  await withHarness(async ({ history, documents, control }) => {
    const markdown = Array.from({ length: 100 }, (_, index) => `累计记录${index}，预算条件未变。`).join("\n");
    await seed(documents, control, { summaryMarkdown: markdown });
    const expected = `[模型生成摘要 · 覆盖至 ordinal 6]\n${markdown}`;
    const pages = [];
    let cursor;
    for (let page = 0; page < 100; page += 1) {
      const result = await history.read({ owner: { kind: "space", id: "s1" }, conversationId: "c1", source: "summary", limitTokens: 400, ...(cursor ? { cursor } : {}) });
      assert.equal(result.outcome, "ok");
      assert.ok(historyCountTokens(JSON.stringify({ status: "ok", ...result })) <= 400);
      pages.push(result.text);
      if (!result.truncated) break;
      assert.ok(result.nextCursor);
      cursor = result.nextCursor;
    }
    assert.equal(pages.join(""), expected);
  });
});
