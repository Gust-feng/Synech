import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { POLICY_KEY } from "../dist/app/memory/policy/policy-snapshot.js";
import { createSqliteMemoryControlRepository } from "../dist/app/memory/store/control-repository.js";
import { createSqliteMemoryDocumentRepository } from "../dist/app/memory/store/content-repository.js";
import { maintainConversationJob, consumeEvidenceGroups } from "../dist/app/memory/capture/consolidation.js";

function ready(payload, mutate = false) {
  const evidence = payload.evidence.at(-1);
  const entryId = payload.availableNewEntryIds[0];
  return { status: "ready", conversationSummary: { markdown: "累计总结：本地存储采用 SQLite。", sourceRefs: payload.allowedSummaryRefs }, topics: [],
    mutations: mutate ? [{ operation: "create", entryId, expectedRevisionId: null, kind: "initial", markdown: "本地存储采用 SQLite。",
      applicability: null, occurredAt: null, reportedAt: evidence.reportedAt, reason: null, topicIds: [], related: [], sourceIds: [evidence.sourceId], retractsRevisionIds: [] }] : [],
    overview: mutate ? { markdown: "本地存储采用 SQLite。", entryIds: [entryId] } : null };
}
async function harness(run, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-maint-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "test.sqlite3"));
  const control = createSqliteMemoryControlRepository(database);
  const documents = createSqliteMemoryDocumentRepository(database);
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
  const turns = [1, 2, 3, 4].flatMap((ordinal) => ["user", "assistant"].map((role) => ({ turnId: `${role}${ordinal}`, ordinal, role,
    text: `第${ordinal}轮：本地存储采用 SQLite。${options.pad ?? ""}`, runId: `r${ordinal}`, occurredAt: `2026-09-05T00:00:0${ordinal}.000Z`, sourceRevision: ordinal })));
  let now = 1_000_000;
  let calls = 0;
  const seen = [];
  const reads = [];
  const deps = { controlRepository: control, documentRepository: documents, now: () => now,
    countTokens: (text) => Math.ceil(text.length / 4),
    evidenceReader: { async readTurnWindow(input) { reads.push(input); return { turns: turns.filter((t) => t.ordinal >= input.fromOrdinal && t.ordinal <= input.through.ordinal), nextCursor: undefined }; } },
    model: { async generate({ messages, maxLatencyMs }) { calls++; const payload = JSON.parse(messages[1].content); seen.push(payload);
      assert.ok(maxLatencyMs > 0 && maxLatencyMs <= 120_000);
      const output = options.model ? await options.model({ payload, call: calls, control, documents, deps }) : ready(payload, true);
      return output.status === "unavailable" ? output : { status: "completed", text: typeof output === "string" ? output : JSON.stringify(output) }; } },
  };
  const index = async (conversationId, through) => documents.indexTranscriptRange({ conversationId, ownerKey: "space:s1",
    entries: turns.filter((t) => t.role === "user" && t.ordinal <= through).map((t) => ({ ordinal: t.ordinal, text: t.text, sourceRevision: t.sourceRevision })),
    publication: { policyRevision: "g1:r1:gen0", generation: 0, conversationGeneration: 0 }, now });
  const signal = async (through = 2) => { await index("c1", through); await control.acceptConversationSignal({ conversationId: "c1", ownerKey: "space:s1", stableThroughOrdinal: through,
    sourceFingerprint: "fp", eligibleAt: now, now, generation: 0, conversationGeneration: 0, policyRevision: "g1:r1:gen0" });
    return (await control.listJobsByStatus("queued"))[0]; };
  try { await run({ control, documents, deps, signal, seen, reads, calls: () => calls, advance: () => { now += 1_000_000; }, database, index }); }
  finally { database.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

test("one generate atomically publishes summary, entries and overview with host-issued revisions and true source identities", async () => {
  await harness(async ({ documents, deps, signal, calls, seen }) => {
    const result = await maintainConversationJob(deps, (await signal()).jobId);
    assert.equal(result.status, "completed", JSON.stringify(result)); assert.equal(result.mode, "full_conversation"); assert.equal(calls(), 1);
    const overview = await documents.getActiveOwnerMemoryHead("space:s1");
    const refs = (await documents.listOverviewDependencies(overview.revisionId)).entries;
    assert.equal(refs.length, 1); assert.notEqual(refs[0].revisionId, refs[0].entryId);
    const entry = await documents.getEntryRevision({ ownerKey: "space:s1", ...refs[0] });
    assert.equal(entry.revision.reportedAt, seen[0].evidence.at(-1).reportedAt);
    assert.equal(entry.revision.occurredAt, null);
    assert.equal(entry.sources[0].locator.sourceRevision, 2);
    assert.equal((await documents.getProgress("c1")).processedThroughOrdinal, 2);
  });
});

test("a host-issued topic publishes with its entry and overview, and its evidence-backed alias is searchable", async () => {
  await harness(async ({ documents, deps, signal, seen, calls }) => {
    const result = await maintainConversationJob(deps, (await signal()).jobId);
    assert.equal(result.status, "completed", JSON.stringify(result)); assert.equal(calls(), 1);
    const [topic] = await documents.listTopics("space:s1");
    assert.equal(topic.topicId, seen[0].availableNewTopicIds[0]);
    assert.deepEqual(topic.owner, { kind: "space", id: "s1" });
    assert.equal(topic.name, "本地存储"); assert.deepEqual(topic.aliases, ["SQLite"]);
    const overview = await documents.getActiveOwnerMemoryHead("space:s1");
    const [ref] = (await documents.listOverviewDependencies(overview.revisionId)).entries;
    const item = await documents.getEntryRevision({ ownerKey: "space:s1", ...ref });
    assert.deepEqual(item.revision.topicIds, [topic.topicId]);
    assert.ok(!item.revision.markdown.includes("SQLite"), "alias discovery must come from the topic projection");
    const found = await documents.searchEntryCandidates({ ownerKey: "space:s1", match: '"sqlite"', includeHistory: false, topicId: topic.topicId, limit: 8 });
    assert.deepEqual(found.candidates, [ref]);
    const otherOwner = await documents.searchEntryCandidates({ ownerKey: "space:other", match: '"sqlite"', includeHistory: false, limit: 8 });
    assert.deepEqual(otherOwner.candidates, []);
  }, { model: async ({ payload }) => {
    const output = ready(payload, true);
    const topicId = payload.availableNewTopicIds[0];
    output.topics = [{ topicId, name: "本地存储", aliases: ["SQLite"] }];
    output.mutations[0].topicIds = [topicId];
    output.mutations[0].markdown = "采用嵌入式数据库持久化。";
    output.overview.markdown = "采用嵌入式数据库持久化。";
    return output;
  } });
});

test("summary-only batch keeps existing overview and model unavailable uses bounded backoff", async () => {
  await harness(async ({ documents, deps, signal, advance }) => {
    await maintainConversationJob(deps, (await signal()).jobId);
    const before = await documents.getActiveOwnerMemoryHead("space:s1"); advance();
    const job = await signal(4);
    const result = await maintainConversationJob({ ...deps, model: { async generate({ messages }) { return { status: "completed", text: JSON.stringify(ready(JSON.parse(messages[1].content))) }; } } }, job.jobId);
    assert.equal(result.status, "completed", JSON.stringify(result)); assert.equal(result.longTermUpdated, false);
    assert.equal((await documents.getActiveOwnerMemoryHead("space:s1")).revisionId, before.revisionId);
  });
  await harness(async ({ documents, deps, signal, advance, control }) => {
    const job = await signal();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await maintainConversationJob(deps, job.jobId);
      assert.equal(result.status, attempt === 3 ? "failed" : "retry_queued"); advance();
    }
    assert.equal(await documents.getProgress("c1"), undefined);
    assert.equal((await control.listJobsByStatus("failed")).length, 1);
  }, { model: async () => ({ status: "unavailable", reason: "not_configured" }) });
});

test("one repair only, and the old whole-document schema never publishes", async () => {
  await harness(async ({ deps, signal, calls, documents }) => {
    const result = await maintainConversationJob(deps, (await signal()).jobId);
    assert.equal(result.status, "failed"); assert.equal(calls(), 2);
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
  }, { model: async () => ({ conversationSummary: { markdown: "s", sourceRefs: [] }, longTermUpdate: null }) });
});

test("continuation only grants owner entries/discovered sources and stops after two rounds plus one repair", async () => {
  await harness(async ({ deps, signal, calls, seen, reads }) => {
    const result = await maintainConversationJob(deps, (await signal()).jobId);
    assert.equal(result.status, "failed"); assert.equal(calls(), 4);
    assert.equal(reads.filter((r) => r.conversationId !== "c1").length, 0);
    assert.ok(seen[1].readResults.every((r) => r.outcome !== "ok"));
  }, { model: async () => ({ status: "needs_read", requests: [{ kind: "read_evidence", sourceId: "arbitrary-source" }, { kind: "read_entry", entryId: "foreign-entry" }] }) });
});

test("an extra raw source deleted during final generate discards the entire batch, even if proposal omits it", async () => {
  await harness(async ({ deps, signal, documents, control, index }) => {
    // Publish a second conversation using the same real pipeline and reader.
    await index("c2", 1);
    await control.acceptConversationSignal({ conversationId: "c2", ownerKey: "space:s1", stableThroughOrdinal: 1, sourceFingerprint: "fp",
      eligibleAt: 1_000_000, now: 1_000_000, generation: 0, conversationGeneration: 0, policyRevision: "g1:r1:gen0" });
    const second = (await control.listJobsByStatus("queued"))[0];
    assert.equal((await maintainConversationJob(deps, second.jobId)).status, "completed");
    let calls = 0;
    const result = await maintainConversationJob({ ...deps, model: { async generate({ messages }) {
      const p = JSON.parse(messages[1].content); calls++;
      if (calls === 1) return { status: "completed", text: JSON.stringify({ status: "needs_read", requests: [{ kind: "read_evidence", sourceId: p.entries[0].sources[0].sourceId }] }) };
      assert.equal(p.readResults[0].outcome, "ok");
      await control.setLifecycleFence("conversation:c2", "fenced");
      await documents.markConversationSourcesDeleted("c2");
      return { status: "completed", text: JSON.stringify(ready(p)) };
    } } }, (await signal()).jobId);
    assert.equal(result.status, "retry_queued");
    assert.equal(await documents.getLatestValidSummary("c1"), undefined);
    assert.equal(await documents.getProgress("c1"), undefined);
  });
});

test("clear excludes all old evidence, and full mode re-reads processed legal ordinals", async () => {
  await harness(async ({ deps, signal, documents, seen, advance }) => {
    await documents.setExcludedThrough({ conversationId: "c1", ownerKey: "space:s1", excludedThroughOrdinal: 1, now: 0 });
    await maintainConversationJob(deps, (await signal()).jobId); advance();
    const result = await maintainConversationJob(deps, (await signal(4)).jobId);
    assert.equal(result.status, "completed", JSON.stringify(result)); assert.equal(result.mode, "full_conversation");
    assert.ok(seen.at(-1).evidence.every((e) => !e.sourceRef.endsWith("ordinal:1")));
    assert.ok(seen.at(-1).evidence.some((e) => e.sourceRef.endsWith("ordinal:2")));
  });
});

test("oversized shared ordinal preserves every user/assistant character and advances only after complete consumption", () => {
  const turns = ["user", "assistant"].map((role) => ({ ordinal: 1, role, text: role.repeat(150), runId: "r1", turnId: role, occurredAt: "2026-09-05", sourceRevision: 1 }));
  let offset = 0; const actual = { user: "", assistant: "" };
  for (let i = 0; i < 1000; i++) {
    const c = consumeEvidenceGroups(turns, { startOrdinal: 1, startFragmentOffset: offset, capacity: 13, countTokens: (t) => t.length });
    for (const t of c.batch) actual[t.role] += t.text;
    if (c.fragment === null) { assert.equal(c.completeThroughOrdinal, 1); break; }
    assert.equal(c.completeThroughOrdinal, 0); assert.ok(c.fragment.end > offset); offset = c.fragment.end;
  }
  assert.equal(actual.user, turns[0].text); assert.equal(actual.assistant, turns[1].text);
});
