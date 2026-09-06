import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import {
  POLICY_KEY,
  createSqliteMemoryControlRepository,
  createSqliteMemoryDocumentRepository,
  maintainConversationJob,
  spaceParticipationKey,
} from "../dist/app/memory/index.js";

async function withHarness(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-maint-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: spaceParticipationKey("s1"), kind: "space_participation", scopeOwnerKey: "space:s1", enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });

  const pad = options.turnTextPad ?? "";
  const turns = (options.turns ?? [1, 2, 3, 4]).flatMap((ordinal) => ([
    { turnId: `u${ordinal}`, ordinal, role: "user", text: `第${ordinal}轮：我们确认本地存储采用 SQLite。${pad}`, runId: `r${ordinal}`, occurredAt: "2026-09-05T00:00:00.000Z", sourceRevision: ordinal },
    { turnId: `a${ordinal}`, ordinal, role: "assistant", text: `第${ordinal}轮已确认。${pad}`, runId: `r${ordinal}`, occurredAt: "2026-09-05T00:00:01.000Z", sourceRevision: ordinal },
  ]));
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
  const deps = {
    controlRepository: control,
    documentRepository: documents,
    evidenceReader,
    model: {
      async generate({ messages }) {
        modelCalls += 1;
        return await options.model({ messages, call: modelCalls });
      },
    },
    countTokens: (text) => Math.ceil(text.length / 4),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  try {
    await run({ control, documents, deps, database, modelCallCount: () => modelCalls });
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** 登记信号并返回排队中的待办；领取由整理管线自行完成（claim CAS）。 */
async function acceptSignal(control, overrides = {}) {
  await control.acceptConversationSignal({
    conversationId: "c1",
    ownerKey: "space:s1",
    stableThroughOrdinal: 2,
    sourceFingerprint: "fp",
    eligibleAt: 100,
    now: 0,
    generation: 0,
    policyRevision: "g1:r1:s1:gen0",
    ...overrides,
  });
  const [queued] = await control.listJobsByStatus("queued");
  assert.ok(queued !== undefined, "expected a queued job after the signal");
  return queued;
}

test("one bounded request publishes summary + optional memory revision atomically", async () => {
  await withHarness(async ({ control, documents, deps }) => {
    const job = await acceptSignal(control);
    const outcome = await maintainConversationJob(deps, job.jobId);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.mode, "full_conversation");
    assert.equal(outcome.longTermUpdated, true);

    const summary = await documents.getLatestValidSummary("c1");
    assert.ok(summary.markdown.includes("累计总结"));
    const head = await documents.getActiveSpaceMemoryHead("space:s1");
    assert.ok(head.markdown.includes("长期记忆"));
    assert.equal((await control.listJobsByStatus("done")).length, 1);
    const progress = await documents.getProgress("c1");
    assert.equal(progress.processedThroughOrdinal, 2);
  }, {
    model: async () => ({
      status: "completed",
      text: JSON.stringify({
        conversationSummary: { markdown: "## 累计总结\n确认 SQLite。", sourceRefs: ["source:u1"] },
        longTermUpdate: { markdown: "# 长期记忆\n- 本地存储采用 SQLite。", sourceRefs: ["source:u1"] },
      }),
    }),
  });
});

test("longTermUpdate=null leaves memory body, sources, revision and update time untouched", async () => {
  await withHarness(async ({ control, documents, deps }) => {
    const first = await acceptSignal(control);
    await maintainConversationJob({
      ...deps,
      model: { async generate() { return { status: "completed", text: JSON.stringify({
        conversationSummary: { markdown: "s1", sourceRefs: [] },
        longTermUpdate: { markdown: "# M", sourceRefs: [] },
      }) }; } },
    }, first.jobId);
    const head = await documents.getActiveSpaceMemoryHead("space:s1");

    // 第二批：新信号新待办，输出 null 修订。
    await control.acceptConversationSignal({
      conversationId: "c1", ownerKey: "space:s1", stableThroughOrdinal: 4,
      sourceFingerprint: "fp", eligibleAt: 500, now: 400,
      generation: 0, policyRevision: "g1:r1:s1:gen0",
    });
    const [second] = await control.listJobsByStatus("queued");
    const outcome = await maintainConversationJob({
      ...deps, model: { async generate() { return { status: "completed", text: JSON.stringify({
        conversationSummary: { markdown: "s2", sourceRefs: [] },
        longTermUpdate: null,
      }) }; } },
    }, second.jobId);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.longTermUpdated, false);
    const after = await documents.getActiveSpaceMemoryHead("space:s1");
    assert.equal(after.revisionId, head.revisionId);
    assert.equal(after.updatedAt, head.updatedAt);
  });
});

test("invalid model output gets exactly one bounded format repair, then the job fails", async () => {
  await withHarness(async ({ control, deps, modelCallCount }) => {
    const job = await acceptSignal(control);
    const outcome = await maintainConversationJob(deps, job.jobId);
    assert.equal(outcome.status, "failed");
    assert.equal(modelCallCount(), 2);
  }, {
    model: async () => ({ status: "completed", text: "not-json" }),
  });
});

test("model unavailable requeues with backoff and does not advance the cursor", async () => {
  await withHarness(async ({ control, documents, deps }) => {
    const job = await acceptSignal(control);
    const outcome = await maintainConversationJob(deps, job.jobId);
    assert.equal(outcome.status, "retry_queued");
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    const [queued] = await control.listJobsByStatus("queued");
    assert.equal(queued.jobId, job.jobId);
    assert.ok(queued.nextAttemptAt > 0);
  }, {
    model: async () => ({ status: "unavailable", reason: "model_provider_not_configured" }),
  });
});

test("no new eligible evidence converges the job without calling the model", async () => {
  await withHarness(async ({ control, deps, modelCallCount, documents }) => {
    const job = await acceptSignal(control);
    // 信号之后、领取之前发生 clear：排除高水位越过目标边界。
    await documents.setExcludedThrough({
      conversationId: "c1", ownerKey: "space:s1", excludedThroughOrdinal: 2, now: 150,
    });
    const outcome = await maintainConversationJob(deps, job.jobId);
    assert.equal(outcome.status, "no_evidence");
    assert.equal(modelCallCount(), 0);
    assert.equal((await control.listJobsByStatus("done")).length, 1);
  }, {
    model: async () => { throw new Error("model must not be called"); },
  });
});

test("a user edit during the model call discards the batch and the retry re-reads the edit", async () => {
  let fakeNow = 1_000_000;
  await withHarness(async ({ control, documents, deps }) => {
    deps.now = () => fakeNow;
    const job = await acceptSignal(control);
    // 用户编辑发生在"模型调用期间"（由模型桩在首次调用时同步执行）：
    // 管线读取 expected head 在模型调用之前，提交时 CAS 失败 → 整批废弃并重排。
    let firstCall = true;
    const outcome = await maintainConversationJob({
      ...deps,
      model: { async generate() {
        if (firstCall) {
          firstCall = false;
          await documents.recordUserSpaceMemoryEdit({
            ownerKey: "space:s1",
            markdown: "用户直接修订",
            requestId: "req-1",
            expectedRevisionId: null,
            now: 300,
          });
        }
        return { status: "completed", text: JSON.stringify({
          conversationSummary: { markdown: "s-stale", sourceRefs: [] },
          longTermUpdate: null,
        }) };
      } },
    }, job.jobId);
    assert.equal(outcome.status, "retry_queued");
    // 被废弃批次不产生任何总结，用户编辑仍是最新的有效 head。
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    assert.equal((await documents.getActiveSpaceMemoryHead("space:s1")).markdown, "用户直接修订");

    // 重试（越过退避时间）：管线以最新 head（用户编辑）为输入，可成功提交。
    fakeNow += 31_000;
    const [queued] = await control.listJobsByStatus("queued");
    const retry = await maintainConversationJob({
      ...deps,
      model: { async generate() { return { status: "completed", text: JSON.stringify({
        conversationSummary: { markdown: "s-retry", sourceRefs: [] },
        longTermUpdate: null,
      }) }; } },
    }, queued.jobId);
    assert.equal(retry.status, "completed");
    assert.equal((await documents.getLatestValidSummary("c1")).markdown, "s-retry");
  });
});

test("R01: a batch only ends on complete ordinals; the shared-ordinal assistant is never skipped", async () => {
  await withHarness(async ({ control, documents, deps }) => {
    // 预算只装得下 ordinal 1 的 user：按完整轮次切批后，整轮（user+assistant）
    // 必须一起进入模型输入，进度推进到该轮并包含两条来源。
    const job = await acceptSignal(control);
    const seenEvidenceIds = [];
    const outcome = await maintainConversationJob({
      ...deps,
      countTokens: (text) => (text.includes("assistant") ? 10_000 : 100),
      model: { async generate({ messages }) {
        const payload = JSON.parse(messages[1].content);
        for (const item of payload.evidence) seenEvidenceIds.push(item.id);
        return { status: "completed", text: JSON.stringify({
          conversationSummary: { markdown: "s", sourceRefs: payload.allowedSummaryRefs },
          longTermUpdate: null,
        }) };
      } },
    }, job.jobId);
    assert.equal(outcome.status, "completed");
    assert.ok(seenEvidenceIds.includes("source:u1"), "user turn must be in the batch");
    assert.ok(seenEvidenceIds.includes("source:a1"), "shared-ordinal assistant must be in the same batch");
    const progress = await documents.getProgress("c1");
    assert.equal(progress.processedThroughOrdinal, 1);
    const summary = await documents.getLatestValidSummary("c1");
    const sources = await documents.listSummarySources(summary.revisionId);
    const coveredOrdinals = new Set(sources.map((source) => source.toOrdinal));
    // 来源覆盖包含 ordinal 1 的全部消息（没有只覆盖 user 的半轮）。
    assert.ok(coveredOrdinals.has(1));
  }, { turns: [1] });
});

test("R02: adjacent context never crosses the exclusion boundary and requires a legal dependency", async () => {
  await withHarness(async ({ control, documents, deps }) => {
    await documents.setExcludedThrough({
      conversationId: "c1", ownerKey: "space:s1", excludedThroughOrdinal: 5, now: 10,
    });
    const job = await acceptSignal(control, { stableThroughOrdinal: 8 });
    const seenOrdinals = [];
    const outcome = await maintainConversationJob({
      ...deps,
      model: { async generate({ messages }) {
        const payload = JSON.parse(messages[1].content);
        for (const item of payload.evidence) {
          const match = /source:[ua](\d+)/u.exec(item.id);
          if (match !== null) seenOrdinals.push(Number(match[1]));
        }
        return { status: "completed", text: JSON.stringify({
          conversationSummary: { markdown: "s", sourceRefs: [] },
          longTermUpdate: null,
        }) };
      } },
    }, job.jobId);
    assert.equal(outcome.status, "completed");
    // 清除后不存在合法旧产物：没有 ordinal ≤ 5 的相邻旧内容进入后台输入。
    assert.ok(seenOrdinals.length > 0);
    assert.ok(seenOrdinals.every((ordinal) => ordinal >= 6));
  }, { turns: [1, 2, 3, 4, 5, 6, 7, 8] });
});

test("R08: full_conversation mode actually re-reads the processed legal range", async () => {
  await withHarness(async ({ control, deps }) => {
    // 第一批（1..2）正常提交。
    const firstJob = await acceptSignal(control);
    await maintainConversationJob({
      ...deps,
      model: { async generate({ messages }) {
        return { status: "completed", text: JSON.stringify({
          conversationSummary: { markdown: "v1", sourceRefs: [] },
          longTermUpdate: null,
        }) };
      } },
    }, firstJob.jobId);
    // 第二批：新增 3..4，合法全文（1..4）可容纳 → full 模式必须真实重读 ordinal 1。
    await control.acceptConversationSignal({
      conversationId: "c1", ownerKey: "space:s1", stableThroughOrdinal: 4,
      sourceFingerprint: "fp", eligibleAt: 500, now: 400,
      generation: 0, policyRevision: "g1:r1:s1:gen0",
    });
    const [second] = await control.listJobsByStatus("queued");
    const seenOrdinals = [];
    const outcome = await maintainConversationJob({
      ...deps,
      model: { async generate({ messages }) {
        const payload = JSON.parse(messages[1].content);
        for (const item of payload.evidence) {
          const match = /source:[ua](\d+)/u.exec(item.id);
          if (match !== null) seenOrdinals.push(Number(match[1]));
        }
        return { status: "completed", text: JSON.stringify({
          conversationSummary: { markdown: "v2", sourceRefs: [] },
          longTermUpdate: null,
        }) };
      } },
    }, second.jobId);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.mode, "full_conversation");
    assert.ok(seenOrdinals.includes(1), "full mode must re-read already-processed legal range");
    assert.ok(seenOrdinals.includes(4));
  });
});

test("N04: a single oversized ordinal is consumed in bounded fragments with fragment-precise progress", async () => {
  let fakeNow = 10_000_000;
  await withHarness(async ({ control, documents, deps }) => {
    deps.now = () => fakeNow;
    const job = await acceptSignal(control, { stableThroughOrdinal: 1 });
    let seenTotalTokens = 0;
    let calls = 0;
    // 每次请求的模型输入必须低于容量硬顶；分片推进直到整轮读完。
    for (let round = 0; round < 10; round += 1) {
      const progress = await documents.getProgress("c1");
      if ((progress?.processedThroughOrdinal ?? 0) === 1) break;
      const [queued] = await control.listJobsByStatus("queued");
      if (queued === undefined) break;
      const outcome = await maintainConversationJob({
        ...deps,
        maxRequestInputTokens: 20_000,
        model: { async generate({ messages }) {
          calls += 1;
          const payload = JSON.parse(messages[1].content);
          const evidenceText = payload.evidence.map((item) => item.text).join("\n");
          seenTotalTokens = Math.max(seenTotalTokens, Math.ceil(evidenceText.length / 4));
          return { status: "completed", text: JSON.stringify({
            conversationSummary: { markdown: `s-${calls}`, sourceRefs: [] },
            longTermUpdate: null,
          }) };
        } },
      }, queued.jobId);
      assert.ok(
        ["completed", "retry_queued", "no_evidence"].includes(outcome.status),
        `unexpected outcome ${JSON.stringify(outcome)}`,
      );
      fakeNow += 10_000_000;
    }
    assert.ok(calls >= 2, `an oversized ordinal must consume in fragments (calls=${calls})`);
    assert.ok(seenTotalTokens <= 20_000, `every request must respect the input capacity (max ${seenTotalTokens})`);
    const progress = await documents.getProgress("c1");
    assert.equal(progress.processedThroughOrdinal, 1, "the full ordinal must eventually be consumed");
    assert.equal(progress.processedFragmentOrdinal, null, "fragment state clears when the ordinal completes");
  }, {
    turns: [1],
    turnTextPad: "x".repeat(16_000),
  });
});

test("N04: capacity below the minimum processing unit fails explicitly without advancing the cursor", async () => {
  await withHarness(async ({ control, documents, deps }) => {
    const job = await acceptSignal(control);
    const outcome = await maintainConversationJob({
      ...deps,
      maxRequestInputTokens: 500,
      model: { async generate() { throw new Error("model must not be called"); } },
    }, job.jobId);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "input_capacity_exceeded");
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    const [queued] = await control.listJobsByStatus("failed");
    assert.equal(queued.jobId, job.jobId);
  });
});
