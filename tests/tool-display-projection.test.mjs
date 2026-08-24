import assert from "node:assert/strict";
import test from "node:test";

import { projectToolDisplay } from "../dist/app/panel-api/read-model/tool-projection/tool-display-projection.js";
import { activityItemsForNodes } from "../dist/app/panel-api/read-model/transcript/panel-transcript-activity-copy.js";

function request(toolName, input = {}) {
  return { callId: `call-${toolName}`, toolName, input };
}

test("Write uses its explicit output path, operation, and diff", () => {
  const display = projectToolDisplay(request("Write", {
    path: "src/example.ts",
    content: "https://example.com is plain file content",
  }), {
    path: "src/example.ts",
    operation: "write",
    diff: { status: "available", unifiedDiff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new" },
  });

  assert.deepEqual(display, {
    kind: "file_diff_preview",
    path: "src/example.ts",
    operation: "write",
    preview: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new",
    truncated: undefined,
    continuation: undefined,
  });
});

test("Shell uses explicit command and output fields without rewriting stdout", () => {
  const display = projectToolDisplay(request("Shell", { command: "pnpm build" }), {
    command: "pnpm",
    commandLine: "pnpm build",
    args: ["build"],
    exitCode: 0,
    stdout: "build complete\n",
    stderr: "",
    timedOut: false,
  });

  assert.equal(display.kind, "command_summary");
  assert.equal(display.commandLine, "pnpm build");
  assert.equal(display.exitCode, 0);
  assert.equal(display.stdoutPreview, "build complete\n");
  assert.equal(display.stderrPreview, undefined);
});

test("WebSearch projects only its declared result fields", () => {
  const display = projectToolDisplay(request("WebSearch", { query: "Synech" }), {
    provider: "tavily",
    status: "completed",
    searched: true,
    query: "Synech",
    results: [{
      title: "Synech overview",
      url: "https://example.com/synech",
      snippet: "Result body",
      source: "example.com",
    }],
  });

  assert.deepEqual(display, {
    kind: "search_results",
    query: "Synech",
    message: undefined,
    results: [{
      title: "Synech overview",
      url: "https://example.com/synech",
      source: "example.com",
    }],
    truncated: undefined,
    continuation: undefined,
  });
});

test("unknown and MCP tools remain raw even when output resembles an article or file", () => {
  const output = {
    text: "Title: Guessed title\nURL: https://example.com/article",
    path: "src/guessed.ts",
    nested: { results: [{ title: "Nested", url: "https://example.com/nested" }] },
  };
  for (const toolName of ["UnknownTool", "server__inspect"]) {
    const display = projectToolDisplay(request(toolName, { query: "ignored" }), output);
    assert.equal(display.kind, "raw_tool_result");
    assert.equal(display.toolName, toolName);
    assert.deepEqual(display.value, output);
  }
});

test("truncated result keeps its continuation facts intact", () => {
  const continuation = {
    ref: "tool-output:1",
    note: "Read the remaining content",
    nextInput: { path: "src/large.ts", startChar: 1200 },
  };
  const display = projectToolDisplay(request("Read", { path: "src/large.ts" }), {
    path: "src/large.ts",
    content: "partial content",
    truncated: true,
    continuation,
  });

  assert.equal(display.kind, "read_result");
  assert.equal(display.truncated, true);
  assert.deepEqual(display.continuation, continuation);
});

test("raw transcript activity shows the original fact instead of inferred source cards", () => {
  const output = { title: "Not an article", url: "https://example.com", path: "not-a-file-owner" };
  const display = projectToolDisplay(request("server__inspect"), output);
  const items = activityItemsForNodes([{
    nodeId: "node-1",
    runId: "run-1",
    sequence: 1,
    eventType: "tool.completed",
    kind: "tool",
    phase: "completed",
    title: "",
    timestamp: "2026-01-01T00:00:00.000Z",
    toolName: "server__inspect",
    display,
    refs: [{ kind: "tool_call", id: "call-1" }],
  }]);

  assert.equal(items.length, 1);
  assert.equal(items[0].toolKind, "other");
  assert.equal(items[0].lead.action, "工具");
  assert.deepEqual(items[0].expandedSections, [{
    title: "原始结果",
    content: JSON.stringify(output, undefined, 2),
    format: "code",
  }]);
});
