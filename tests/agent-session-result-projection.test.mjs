import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assistantText,
  modelMessageFromAssistant,
  modelUsageFromProvider,
  providerFailureFromAssistant,
  providerRefusalFromAssistant,
} from "../dist/adapters/intelligence/provider-result-projection.js";
import {
  cancelledApprovalResult,
  deniedToolResult,
  harnessToolResult,
  pendingToolResultForMessage,
  piImmediateToolResult,
} from "../dist/adapters/intelligence/tool-result-transport.js";
import {
  AgentSessionProviderTiming,
  mergeModelUsage,
} from "../dist/adapters/intelligence/agent-session-provider-timing.js";
import {
  AcceptedNestedToolRequestRegistry,
  ToolInvocationBindingTable,
  acceptedToolRequests,
  providerToolCallsForRound,
} from "../dist/adapters/intelligence/agent-session-tool-bindings.js";
import { withToolModelAttachments } from "../dist/domain/tools/model-attachments.js";
import { sameResultForIdempotency } from "../dist/domain/tools/contracts.js";

const modelInput = { supportsVisionInput: true, modelInputSupportsImage: true };

test("provider timing aggregates observed latency and merge preserves the selected latest request", () => {
  let now = 0;
  const timing = new AgentSessionProviderTiming(() => now);

  timing.startRequest();
  now = 120;
  timing.observeVisibleOutput();
  now = 1_120;
  let usage = timing.completeUsage({ requestCount: 1 }, 1_000);
  assert.deepEqual(usage, {
    requestCount: 1,
    latencyMs: 1_120,
    firstTokenLatencyMs: 120,
    outputDurationMs: 1_000,
    outputTokensPerSecond: 1_000,
  });

  now = 2_000;
  timing.startRequest();
  now = 2_200;
  timing.observeVisibleOutput();
  now = 2_700;
  usage = timing.completeUsage(usage, 500);
  assert.deepEqual(usage, {
    requestCount: 1,
    latencyMs: 910,
    firstTokenLatencyMs: 160,
    outputDurationMs: 750,
    outputTokensPerSecond: 1_000,
  });

  const previousRequest = { inputTokens: 10, outputTokens: 2 };
  const nextRequest = { inputTokens: 20, outputTokens: 4 };
  const current = { requestCount: 1, inputTokens: 10, latestAgentRequest: previousRequest };
  const next = { requestCount: 1, inputTokens: 20, latestAgentRequest: nextRequest };
  assert.equal(mergeModelUsage(current, next).latestAgentRequest, nextRequest);
  assert.deepEqual(
    mergeModelUsage(current, next, { preserveLatestAgentRequest: true }),
    { requestCount: 2, inputTokens: 30, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, uncachedInputTokens: 0, reasoningOutputTokens: 0,
      estimatedCostUsd: 0, latestAgentRequest: previousRequest },
  );
});

test("tool binding helpers keep root rounds and nested acceptance scoped", () => {
  const providerCalls = providerToolCallsForRound([
    { providerCallId: "call-1", toolName: "Read", input: { path: "README.md" } },
  ], "round-1", "parent-1");
  assert.deepEqual(providerCalls, [{
    providerCallId: "call-1",
    toolName: "Read",
    input: { path: "README.md" },
    parentInvocationId: "parent-1",
    roundId: "round-1",
  }]);

  const accepted = [{ ...providerCalls[0], invocationId: "invocation-1" }];
  const requests = acceptedToolRequests(accepted);
  const bindings = new ToolInvocationBindingTable();
  bindings.replace(accepted);
  assert.deepEqual(bindings.get("call-1"), {
    invocationId: "invocation-1",
    parentInvocationId: "parent-1",
  });

  const nested = new AcceptedNestedToolRequestRegistry();
  nested.remember(requests[0]);
  assert.equal(nested.matches(structuredClone(requests[0])), true);
  assert.equal(nested.matches({ ...requests[0], toolName: "Write" }), false);
  assert.equal(nested.matches({ ...requests[0], input: { path: "other.md" } }), false);
  assert.equal(nested.matches({ ...requests[0], input: { path: "README.md" } }), true);

  bindings.replace([]);
  assert.equal(bindings.get("call-1"), undefined);
});

test("Pi transport preserves completed, failed, and cancelled execution facts", () => {
  for (const result of [
    toolResult({ status: "completed", output: { value: 42 } }),
    toolResult({
      status: "failed",
      output: { partial: "kept" },
      error: "tool failed",
      errorDomain: "tool_error",
      errorFacts: { code: "execution_failed" },
    }),
    toolResult({
      status: "cancelled",
      error: "user stopped",
      errorDomain: "runtime_error",
      errorFacts: { code: "cancelled" },
    }),
  ]) {
    const projected = harnessToolResult(result, modelInput);
    assert.deepEqual(projected.details.result, result);
    const payload = JSON.parse(projected.content[0].text);
    assert.equal(payload.status, result.status);
    if (result.status === "failed" || result.status === "cancelled") {
      assert.equal(payload.error.message, result.error);
      assert.equal(payload.error.facts.code, result.errorFacts.code);
    }
  }
});

test("approval decisions become one resolved failed or cancelled fact", () => {
  const approval = toolResult({
    status: "approval_required",
    output: { preview: "delete temp.txt" },
    confirmationRequest: {
      confirmationId: "confirmation-1",
      invocationId: "invocation-1",
      title: "Delete file",
      actionSummary: "Delete temp.txt",
      affectedResources: ["temp.txt"],
      riskLevel: "medium",
      requestedAt: "2026-08-24T00:00:00.000Z",
      sourceRefs: [],
    },
  });

  const denied = deniedToolResult(approval, {
    confirmationId: "confirmation-1",
    decision: "guidance",
    guidance: "Keep the file",
    decidedAt: "2026-08-24T00:00:01.000Z",
  });
  assert.equal(denied.status, "failed");
  assert.equal(denied.errorFacts.code, "tool_call_guidance");
  assert.equal(denied.confirmationRequest, undefined);
  assert.equal(denied.error, "User rejected this tool call with guidance: Keep the file");

  const cancelled = cancelledApprovalResult(approval, new Error("run stopped"));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.errorFacts.code, "tool_call_cancelled");
  assert.equal(cancelled.confirmationRequest, undefined);
  assert.match(cancelled.error, /run stopped/u);
});

test("inline image transport emits image content and durable attachment identity", () => {
  const data = Buffer.from("image-bytes").toString("base64");
  const output = withToolModelAttachments({ caption: "sample" }, [{
    kind: "image",
    attachmentId: "image-1",
    inputRef: "input-1",
    byteLength: 11,
    source: { kind: "data", mimeType: "image/png", data },
  }]);
  const projected = harnessToolResult(toolResult({ status: "completed", output }), modelInput);

  assert.deepEqual(projected.content[1], { type: "image", mimeType: "image/png", data });
  assert.deepEqual(projected.details.result.modelAttachmentRefs, [{
    kind: "image",
    attachmentId: "image-1",
    inputRef: "input-1",
    mimeType: "image/png",
    byteLength: 11,
    sha256: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"),
  }]);
});

test("unsupported attachment becomes one explicit transport failure", () => {
  const output = withToolModelAttachments({ transcript: "sample" }, [{
    kind: "audio",
    filename: "sample.mp3",
    source: { kind: "file_id", fileId: "audio-1" },
  }]);
  const projected = harnessToolResult(toolResult({ status: "completed", output }), modelInput);

  assert.equal(projected.terminate, true);
  assert.equal(projected.details.result.status, "failed");
  assert.equal(projected.details.result.errorFacts.code, "tool_result_attachment_not_supported");
  assert.equal(projected.details.result.errorFacts.sourceExecutionStatus, "completed");
  assert.equal(projected.content.length, 1);
});

test("tool continuation remains a durable fact and a model-visible next input", () => {
  const output = {
    contentRef: "tool-output:1",
    contentBytes: 1024,
    contentSha256: "sha256",
    continuationAvailability: "available",
    preview: "first page",
    continuation: {
      ref: "tool-output:1",
      note: "Read the next page",
      nextInput: { ref: "tool-output:1", offset: 100 },
    },
  };
  const projected = harnessToolResult(toolResult({ status: "completed", output }), modelInput);
  assert.deepEqual(projected.details.result.output, output);

  const payload = JSON.parse(projected.content[0].text);
  assert.deepEqual(payload.body.value.continuation, {
    nextInput: { ref: "tool-output:1", offset: 100 },
  });
  assert.equal(payload.body.value.preview, "first page");
});

test("Pi immediate failures distinguish cancellation, execution, and rejected calls", () => {
  const request = {
    providerCallId: "call-1",
    invocationId: "invocation-1",
    toolName: "Read",
    input: { path: "README.md" },
  };
  const rawResult = { content: [{ type: "text", text: "Pi failure" }], details: undefined };

  assert.equal(piImmediateToolResult({
    request,
    rawResult,
    prepared: false,
    knownActiveTool: true,
    cancellationRequested: true,
  }).errorFacts.code, "pi_tool_call_cancelled");
  assert.deepEqual(piImmediateToolResult({
    request,
    rawResult,
    prepared: true,
    knownActiveTool: true,
    cancellationRequested: false,
  }).failureAttribution, "execution_failure");
  assert.equal(piImmediateToolResult({
    request,
    rawResult,
    prepared: false,
    knownActiveTool: false,
    cancellationRequested: false,
  }).errorFacts.code, "pi_tool_call_rejected");
});

test("tool result idempotency includes business result content", () => {
  const completed = toolResult({ status: "completed", output: { value: "A" } });

  assert.equal(sameResultForIdempotency(completed, { ...completed, durationMs: 999 }), true);
  assert.equal(sameResultForIdempotency(completed, { ...completed, output: { value: "B" } }), false);
  assert.equal(sameResultForIdempotency(completed, {
    ...completed,
    status: "failed",
    error: "delivery failed",
  }), false);
});

test("pending image delivery resolves by canonical fact identity or scoped Pi identity", () => {
  const nested = toolResult({
    status: "completed",
    invocationId: "nested-fact",
    parentInvocationId: "parent-fact",
  });
  const pending = new Map([["nested-fact", { result: nested }]]);
  const failAmbiguous = (message) => { throw new Error(message); };

  assert.equal(pendingToolResultForMessage(pending, {
    role: "toolResult",
    toolCallId: "provider-call",
    toolName: "Read",
    content: [],
    details: { kind: "result", result: nested },
  }, "parent-fact", failAmbiguous)?.result, nested);

  assert.equal(pendingToolResultForMessage(pending, {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "Read",
    content: [],
  }, "parent-fact", failAmbiguous)?.result, nested);
});

test("provider projection keeps assistant calls, refusal, and usage facts explicit", () => {
  const assistant = {
    role: "assistant",
    content: [
      { type: "text", text: "Working" },
      { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "README.md" } },
    ],
    stopReason: "toolUse",
    usage: providerUsage(),
    timestamp: 0,
  };
  assert.equal(assistantText(assistant), "Working");
  assert.deepEqual(modelMessageFromAssistant(assistant), {
    role: "assistant",
    content: "Working",
    toolCalls: [{ providerCallId: "call-1", toolName: "Read", input: { path: "README.md" } }],
  });
  assert.equal(providerRefusalFromAssistant({
    ...assistant,
    diagnostics: [{ type: "provider_refusal", details: { refusal: " policy " } }],
  }), "policy");
  assert.deepEqual(providerFailureFromAssistant({
    ...assistant,
    stopReason: "error",
    errorMessage: "provider unavailable",
  }, 128_000), {
    error: "provider unavailable",
    errorCode: "provider_response",
  });
  assert.deepEqual(modelUsageFromProvider(providerUsage()), {
    requestCount: 1,
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 3,
    uncachedInputTokens: 10,
    reasoningOutputTokens: 1,
    estimatedCostUsd: 0.01,
    latestAgentRequest: {
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 3,
      uncachedInputTokens: 10,
      reasoningOutputTokens: 1,
    },
  });
});

function toolResult(overrides) {
  return {
    providerCallId: "call-1",
    invocationId: "invocation-1",
    toolName: "Read",
    input: { path: "README.md" },
    output: undefined,
    durationMs: 12,
    ...overrides,
  };
}

function providerUsage() {
  return {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 3,
    totalTokens: 17,
    reasoning: 1,
    cost: { input: 0.004, output: 0.006, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  };
}
