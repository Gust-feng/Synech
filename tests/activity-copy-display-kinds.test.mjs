import assert from "node:assert/strict";
import test from "node:test";

import { activityItemsForNodes } from "../dist/app/panel-read-model/transcript/panel-transcript-activity-copy.js";

test("file diff copy keeps operation, path, diff section, and line delta", () => {
  const item = activityItem("Edit", {
    kind: "file_diff_preview",
    path: "src/example.ts",
    operation: "edit",
    preview: "@@ -1 +1 @@\n-old\n+new",
  });

  assert.deepEqual(item.copy, { label: "编辑", detail: "src/example.ts" });
  assert.deepEqual(item.lead, { action: "编辑", subject: "src/example.ts", monospace: true });
  assert.deepEqual(item.lineDelta, { added: 1, removed: 1 });
  assert.deepEqual(item.expandedSections, [{
    title: "差异预览",
    content: "@@ -1 +1 @@\n-old\n+new",
    format: "diff",
  }]);
});

test("directory copy exposes declared entries and unreadable samples", () => {
  const item = activityItem("List", {
    kind: "directory_listing",
    path: ".",
    entries: [
      { path: "src", kind: "directory" },
      { path: "README.md", kind: "file" },
    ],
    unreadableDirectories: 1,
    unreadableSamples: [{ path: "private", errorCode: "EACCES" }],
  });

  assert.deepEqual(item.copy, { label: "查看", detail: "当前目录" });
  assert.equal(item.toolKind, "directory");
  assert.deepEqual(item.lead, { action: "查看", subject: "当前目录", monospace: true });
  assert.deepEqual(item.expandedSections, [
    {
      title: "条目",
      content: "src/\nREADME.md",
      format: "path_list",
      items: [
        { title: "src/", monospace: true },
        { title: "README.md", monospace: true },
      ],
    },
    { title: "异常目录", content: "private · EACCES", format: "list", tone: "warning" },
  ]);
});

test("file search copy uses explicit query and match positions", () => {
  const item = activityItem("Grep", {
    kind: "file_search_results",
    query: "ToolCenter",
    path: "src",
    matches: [{ path: "src/tool-center.ts", line: 42, preview: "class ToolCenter" }],
  });

  assert.deepEqual(item.copy, { label: "搜索", detail: "ToolCenter" });
  assert.equal(item.toolKind, "search");
  assert.deepEqual(item.expandedSections, [{
    title: "匹配位置",
    content: "src/tool-center.ts:42 - class ToolCenter",
    format: "path_list",
    items: [{ title: "src/tool-center.ts:42", detail: "class ToolCenter", monospace: true }],
  }]);
});

test("web search copy renders only declared result sources", () => {
  const item = activityItem("WebSearch", {
    kind: "search_results",
    query: "Synech",
    results: [{ title: "Synech", url: "https://docs.example.test/synech", source: "Docs" }],
  });

  assert.deepEqual(item.copy, { label: "搜索", detail: "Synech" });
  assert.deepEqual(item.lead, { action: "搜索", subject: "Synech" });
  assert.deepEqual(item.expandedSections, [{
    title: "来源",
    content: "Synech · Docs",
    format: "source_list",
    items: [{
      title: "Synech",
      href: "https://docs.example.test/synech",
      meta: [{ value: "docs.example.test" }],
    }],
  }]);
});

test("command copy separates command and canonical output", () => {
  const item = activityItem("Shell", {
    kind: "command_summary",
    commandLine: "pnpm test",
    exitCode: 0,
    stdoutPreview: "all tests passed",
  });

  assert.deepEqual(item.copy, { label: "命令", detail: "终端" });
  assert.deepEqual(item.lead, { action: "运行", subject: "终端" });
  assert.deepEqual(item.expandedSections, [
    { title: "命令", content: "$ pnpm test", format: "console" },
    { title: "输出", content: "all tests passed", format: "console", tone: undefined },
  ]);
});

test("unknown tool copy stays raw without inferring URL or file meaning", () => {
  const value = {
    title: "Not an article",
    url: "https://example.test/article",
    path: "src/not-a-file-contract.ts",
  };
  const item = activityItem("server__inspect", {
    kind: "raw_tool_result",
    toolName: "server__inspect",
    label: "server__inspect",
    value,
  });

  assert.deepEqual(item.copy, { label: "工具", detail: "server__inspect" });
  assert.equal(item.toolKind, "other");
  assert.deepEqual(item.lead, { action: "工具", subject: "server__inspect" });
  assert.deepEqual(item.expandedSections, [{
    title: "原始结果",
    content: JSON.stringify(value, undefined, 2),
    format: "code",
  }]);
});

function activityItem(toolName, display) {
  const items = activityItemsForNodes([{
    nodeId: `node-${toolName}`,
    runId: "run-1",
    sequence: 1,
    eventType: "tool.completed",
    kind: "tool",
    phase: "completed",
    title: "",
    timestamp: "2026-08-24T00:00:00.000Z",
    toolName,
    display,
    refs: [{ kind: "tool_call", id: `call-${toolName}` }],
  }]);
  assert.equal(items.length, 1);
  return items[0];
}
