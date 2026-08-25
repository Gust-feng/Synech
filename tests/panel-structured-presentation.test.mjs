import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantFailureParts,
  projectConfirmationDisplay,
} from "../dist/app/panel-api/ui-read-model.js";
import {
  transcriptNodesWithoutFailureEcho,
} from "../dist/app/panel-api/read-model/assistant/panel-assistant-failure.js";

test("confirmation display consumes structured fields without parsing presentation copy", () => {
  const projected = projectConfirmationDisplay({
    title: "需要确认删除",
    actionSummary: "执行 Shell：Remove-Item temp.txt",
    consequence: "批准后只执行这一次操作。",
    affectedResources: ["tool:visible-by-contract", "temp.txt"],
    riskLevel: "high",
    resumeAvailability: "live",
  });

  assert.deepEqual(projected, {
    title: "需要确认删除",
    description: "批准后只执行这一次操作。",
    resources: ["tool:visible-by-contract", "temp.txt"],
    riskLevel: "high",
    resumeLost: false,
  });
});

test("assistant failure keeps marker-like text as data and filters only the terminal event identity", () => {
  const failure = assistantFailureParts({
    code: "model_failed",
    message: "模型返回了正文。\n\n错误信息：这是原始错误中的字面量。",
  });
  assert.equal(failure.code, "model_failed");
  assert.match(failure.error, /模型返回了正文/);
  assert.match(failure.error, /错误信息：这是原始错误中的字面量/);

  const toolFailure = failureNode("tool-failed", "tool.failed", "tool");
  const runFailure = failureNode("run-failed", "run.failed", "system");
  const unrelatedSystemFailure = failureNode("model-failed", "model.failed", "system");
  assert.deepEqual(
    transcriptNodesWithoutFailureEcho([toolFailure, runFailure, unrelatedSystemFailure], "failed")
      .map((node) => node.nodeId),
    ["tool-failed", "model-failed"],
  );
});

function failureNode(nodeId, eventType, kind) {
  return {
    nodeId,
    runId: "run-1",
    sequence: 1,
    eventType,
    kind,
    phase: "failed",
    title: "未完成",
    summary: "同一段显示文案",
    timestamp: "2026-08-25T00:00:00.000Z",
    refs: [{ kind: "event", id: nodeId }],
  };
}
