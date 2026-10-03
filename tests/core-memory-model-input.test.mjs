import assert from "node:assert/strict";
import test from "node:test";

import { renderMemoryBackgroundBlock } from "../dist/app/memory/index.js";
import { buildOrdinaryAgentModelInput } from "../dist/app/ordinary-agent/model-input.js";
import { maintenanceOutputSchema, validateMaintenanceOutput } from "../dist/app/memory/capture/maintenance-output.js";
import { buildMaintenanceMessages } from "../dist/app/memory/capture/maintenance-prompt.js";
import { createConfigCenterConsolidationModel } from "../dist/app/panel-server/memory/consolidation-model.js";

/**
 * 背景渲染与模型输入边界（0.6.0 正式设计 §9.2）：
 * - 背景作为独立 contribution 由 session loop 的 provider 钩子插入，model-input
 *   不再持有任何隐式记忆段；
 * - 空正文（修订后无内容保留）不渲染，新会话不注入空背景。
 */

test("memory background block renders the advisory header with update time and origin", () => {
  const block = renderMemoryBackgroundBlock({
    revisionId: "rev-1",
    revision: 1,
    origin: "model",
    markdown: "## 稳定事实\n- 本地存储采用 SQLite。",
    generation: 0,
    updatedAt: Date.UTC(2026, 8, 5, 12, 0, 0),
  });
  assert.ok(block.includes("[Memory — historical background]"));
  assert.ok(block.includes("advisory background"));
  assert.ok(block.includes("2026-09-05"));
  assert.ok(block.includes("## 稳定事实"));
  assert.ok(!block.includes("user-edited"));
});

test("user-edited origin is rendered as provenance", () => {
  const block = renderMemoryBackgroundBlock({
    revisionId: "rev-2",
    revision: 2,
    origin: "user_edit",
    markdown: "用户手写背景。",
    generation: 0,
    updatedAt: Date.UTC(2026, 8, 5, 13, 0, 0),
  });
  assert.ok(block.includes("user-edited"));
});

test("an empty revision body renders nothing (no empty background injection)", () => {
  const block = renderMemoryBackgroundBlock({
    revisionId: "rev-3",
    revision: 3,
    origin: "model",
    markdown: "",
    generation: 0,
    updatedAt: Date.UTC(2026, 8, 5, 14, 0, 0),
  });
  assert.equal(block, "");
});

test("model input keeps a byte-stable shape without any memory parameter", () => {
  const base = buildOrdinaryAgentModelInput({
    agentDefinition: { agentId: "ordinary", prompt: { systemPrompt: "SYS", promptRef: "prompt:ordinary" } },
    goal: "帮我检查方案",
    runContext: { contextRefs: [], traceId: "t1", contextId: "c1" },
    collaborationRulesContext: "[Standing collaboration rules]\n- concise",
  });
  assert.equal(base.messages.length, 2);
  assert.equal(base.messages[0].role, "system");
  assert.equal(base.messages[1].role, "user");
  assert.ok(base.messages[1].content.includes("[Current user request]"));
  assert.ok(!base.messages[1].content.includes("Space memory"));
});

test("maintenance JSON rejects arbitrary tools/owner and invented dependencies, timestamps and cross-entry retractions", () => {
  for (const request of [{ kind: "shell", command: "ls" }, { kind: "read_evidence", sourceId: "s", conversationId: "other" }, { kind: "search_entries", query: "x", owner: "other" }]) {
    assert.equal(maintenanceOutputSchema.safeParse({ status: "needs_read", requests: [request] }).success, false);
  }
  const m = { operation: "create", entryId: "new", expectedRevisionId: null, kind: "initial", markdown: "认识", applicability: null,
    occurredAt: null, reportedAt: "2026-09-01", reason: null, topicIds: [], related: [], sourceIds: ["new-source"], retractsRevisionIds: [] };
  const out = { status: "ready", conversationSummary: { markdown: "总结", sourceRefs: ["e"] }, topics: [], mutations: [m], overview: { markdown: "认识", entryIds: ["new"] } };
  const validate = (output) => validateMaintenanceOutput({ output, allowedSummaryRefs: ["e"], allowedSourceIds: ["new-source"],
    newEvidence: [{ id: "e", sourceId: "new-source", role: "user", reportedAt: "2026-09-01", text: "认识", sourceRef: "run:r1" }],
    entries: [], availableNewEntryIds: ["new"], existingTopics: [], availableNewTopicIds: ["topic-new"], countTokens: (t) => t.length });
  assert.equal(validate(out).ok, true);
  const withTopic = { ...out, topics: [{ topicId: "topic-new", name: "认识", aliases: [] }], mutations: [{ ...m, topicIds: ["topic-new"] }] };
  assert.equal(validate(withTopic).ok, true);
  assert.equal(validate({ ...withTopic, topics: [{ ...withTopic.topics[0], topicId: "foreign-topic" }] }).reason, "topic_identity_invalid");
  assert.equal(validate({ ...withTopic, topics: [{ ...withTopic.topics[0], aliases: ["invented"] }] }).reason, "topic_evidence_required");
  assert.equal(maintenanceOutputSchema.safeParse({ ...withTopic, topics: [{ ...withTopic.topics[0], owner: { kind: "space", id: "other" } }] }).success, false);
  assert.equal(validate({ ...out, mutations: [{ ...m, reportedAt: "2026-10-03" }] }).reason, "new_evidence_required");
  assert.equal(validate({ ...out, mutations: [{ ...m, reason: { text: "猜测原因", sourceIds: ["forged"] } }] }).reason, "reason_source_invalid");
  assert.equal(validate({ ...out, overview: { markdown: "任意认识", entryIds: ["unknown"] } }).reason, "overview_dependency_invalid");
  assert.equal(validate({ ...out, mutations: [{ ...m, kind: "correction", operation: "revise", expectedRevisionId: "other-rev", retractsRevisionIds: ["other-rev"] }] }).ok, false);
});

test("maintenance prompt separates reported time, finite reads and host-issued identities", () => {
  const messages = buildMaintenanceMessages({ requestMetadata: {}, previousSummary: null, currentMemory: null, evidence: [], entries: [],
    existingTopics: [], availableNewEntryIds: ["host-new"], availableNewTopicIds: ["host-topic"], readResults: [], allowedSourceIds: [] });
  assert.equal(messages.length, 2);
  assert.ok(messages[0].content.includes("最多两轮"));
  assert.ok(messages[0].content.includes("generatedAt仅处理时间"));
  assert.deepEqual(JSON.parse(messages[1].content).availableNewEntryIds, ["host-new"]);
});

test("unconfigured consolidation model stays unavailable without creating a model channel", async () => {
  const model = createConfigCenterConsolidationModel({ configCenter: { async getModelProviderConfig() { return { defaultAiMode: "none" }; } },
    async createModelChannel() { throw new Error("must not call any model API"); } });
  assert.equal((await model.generate({ messages: [], maxLatencyMs: 10 })).status, "unavailable");
});
