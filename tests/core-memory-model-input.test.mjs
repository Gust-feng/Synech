import assert from "node:assert/strict";
import test from "node:test";

import { renderMemoryBackgroundBlock } from "../dist/app/memory/index.js";
import { buildOrdinaryAgentModelInput } from "../dist/app/ordinary-agent/model-input.js";

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
  assert.ok(block.includes("[Space memory — historical background]"));
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
