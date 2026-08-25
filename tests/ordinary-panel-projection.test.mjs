import assert from "node:assert/strict";
import test from "node:test";

import {
  OrdinaryPanelCursorError,
  encodeOrdinaryPanelCursor,
  parseOrdinaryPanelCursor,
  projectOrdinaryPanelActivityBatch,
  projectOrdinaryPanelConversation,
  projectOrdinaryPanelRunView,
} from "../dist/app/panel-server/ordinary/ordinary-agent-panel-projection.js";
import { projectOrdinaryConversation } from "../dist/app/ordinary-agent/conversation-projection.js";
import { appendLiveRunEvents, projectLiveRunTranscript } from "../dist/app/panel-api/ui-read-model.js";

test("cursor round-trips exact stream position and rejects extra facts", () => {
  const cursor = { streamId: "stream-1", sequence: 7 };
  assert.deepEqual(parseOrdinaryPanelCursor(encodeOrdinaryPanelCursor(cursor)), cursor);

  const extra = Buffer.from(JSON.stringify({ ...cursor, extra: true }), "utf8").toString("base64url");
  assert.throws(() => parseOrdinaryPanelCursor(extra), OrdinaryPanelCursorError);
});

test("activity replay preserves event order while transcript coalesces adjacent deltas", () => {
  const run = runState({ status: { kind: "running" } });
  const replay = activityReplay([
    activity("request", 1, { type: "model.request", reason: "initial" }),
    activity("reasoning-1", 2, { type: "model.reasoning.delta", modelRequestId: "model-1", contentIndex: 0, delta: "先分析" }),
    activity("reasoning-2", 3, { type: "model.reasoning.delta", modelRequestId: "model-1", contentIndex: 0, delta: "，再处理" }),
    activity("tool", 4, {
      type: "tool.requested",
      request: {
        providerCallId: "call-1",
        invocationId: "invocation-1",
        toolName: "Read",
        input: { path: "README.md" },
      },
    }),
    activity("output-1", 5, { type: "model.output.delta", modelRequestId: "model-1", contentIndex: 1, delta: "Hello " }),
    activity("output-2", 6, { type: "model.output.delta", modelRequestId: "model-1", contentIndex: 1, delta: "world" }),
  ]);

  const batch = projectOrdinaryPanelActivityBatch({ run, replay });
  assert.deepEqual(batch.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(batch.events.map((event) => event.type), [
    "model.requested",
    "model.reasoning.delta",
    "model.reasoning.delta",
    "tool.requested",
    "model.output.delta",
    "model.output.delta",
  ]);

  const view = projectOrdinaryPanelRunView({ run, fullReplay: replay });
  assert.equal(view.workView.stage, "composing_result");
  assert.deepEqual(view.workView.transcriptNodes.map((node) => [node.eventType, node.text]), [
    ["model.requested", undefined],
    ["model.reasoning.delta", "先分析，再处理"],
    ["tool.requested", undefined],
    ["model.output.delta", "Hello world"],
  ]);
});

test("reasoning completion keeps its content block identity across panel projection", () => {
  const run = runState({ status: { kind: "running" } });
  const replay = activityReplay([
    activity("reasoning-delta", 1, {
      type: "model.reasoning.delta",
      modelRequestId: "model-1",
      contentIndex: 0,
      delta: "分析中",
    }),
    activity("output-delta", 2, {
      type: "model.output.delta",
      modelRequestId: "model-1",
      contentIndex: 1,
      delta: "正式回答",
    }),
    activity("reasoning-completed", 3, {
      type: "run.transition",
      durability: "durable",
      event: {
        eventId: "event-reasoning-completed",
        runId: "run-1",
        sequence: 1,
        recordedAt: "2026-08-24T00:00:03.000Z",
        type: "model.reasoning.completed",
        modelRequestId: "model-1",
        contentIndex: 0,
        content: "分析完成",
      },
    }),
  ]);

  const batch = projectOrdinaryPanelActivityBatch({ run, replay });
  const completed = batch.events.find((event) => event.type === "model.reasoning.completed");
  assert.equal(completed?.contentIndex, 0);

  const live = appendLiveRunEvents("run-1", undefined, batch.events);
  assert.deepEqual(live.turns.map((turn) => ({
    contentIndex: turn.contentIndex,
    reasoning: turn.reasoning.text,
    output: turn.output.text,
  })), [
    { contentIndex: 0, reasoning: "分析完成", output: "" },
    { contentIndex: 1, reasoning: "", output: "正式回答" },
  ]);
});

test("completed snapshots use structured content without parsing localized summaries", () => {
  const live = appendLiveRunEvents("run-1", undefined, [
    panelEvent("request", 1, "model.requested", "model-1"),
    panelEvent("output-delta", 2, "model.output.delta", "model-1", { delta: "流式正文" }),
    panelEvent("output-summary", 3, "model.output.completed", "model-1", { summary: "任意完成摘要" }),
    panelEvent("reasoning-delta", 4, "model.reasoning.delta", "model-1", { delta: "真实思考" }),
    panelEvent("reasoning-summary", 5, "model.reasoning.completed", "model-1", { summary: "任意思考摘要" }),
    panelEvent("output-authoritative", 6, "model.output.completed", "model-1", { delta: "权威最终正文" }),
  ]);

  assert.equal(live.turns[0].output.text, "权威最终正文");
  assert.equal(live.turns[0].reasoning.text, "真实思考");
});

test("streaming answer joins text blocks only within the latest model request", () => {
  const live = appendLiveRunEvents("run-1", undefined, [
    panelEvent("request-1", 1, "model.requested", "model-1"),
    panelEvent("request-1-text-0", 2, "model.output.delta", "model-1", { contentIndex: 0, delta: "准备读取。" }),
    panelEvent("request-1-text-1", 3, "model.output.delta", "model-1", { contentIndex: 1, delta: "继续处理。" }),
    panelEvent("tool-request", 4, "tool.requested", undefined, {
      toolName: "Read",
      refs: [{ kind: "tool_call", id: "invocation-1" }],
    }),
    panelEvent("request-2", 5, "model.requested", "model-2"),
    panelEvent("request-2-text-0", 6, "model.output.delta", "model-2", { contentIndex: 0, delta: "最终" }),
    panelEvent("request-2-text-1", 7, "model.output.delta", "model-2", { contentIndex: 1, delta: "回答" }),
  ]);

  assert.equal(projectLiveRunTranscript([], live).answer?.text, "最终回答");
});

test("approval run keeps status copy, owner-scoped confirmation, and continuation facts", () => {
  const confirmation = {
    confirmationId: "confirmation-1",
    invocationId: "call-1",
    title: "删除文件",
    actionSummary: "删除 temp.txt",
    affectedResources: ["temp.txt"],
    riskLevel: "medium",
    resumeAvailability: "live",
    requestedAt: "2026-08-24T00:00:01.000Z",
    sourceRefs: ["tool:call-1"],
  };
  const run = runState({
    status: {
      kind: "awaiting_approval",
      confirmationRequests: [confirmation],
      continuationAvailability: "live_only",
    },
  });
  const view = projectOrdinaryPanelRunView({ run, fullReplay: activityReplay([]) });

  assert.equal(view.run.status, "approval_needed");
  assert.equal(view.run.currentStep, "删除 temp.txt");
  assert.equal(view.run.nextStep, "等待你的决定");
  assert.equal(view.workView.stage, "awaiting_approval");
  assert.equal(view.workView.headline, "待处理");
  assert.deepEqual(view.workView.pendingConfirmation, { ...confirmation, ownerRunId: "run-1" });
  assert.equal(view.detail.stopReason, "approval_required");
  assert.equal(view.detail.continuationAvailability, "live");
});

test("completed run projects the final Session answer and completion copy", () => {
  const run = runState({ status: { kind: "completed" } });
  const replay = activityReplay([activity("answer", 1, {
    type: "model.output.completed",
    modelRequestId: "model-1",
    assistantEntryRef: { sessionId: "session-1", entryId: "assistant-1" },
    content: "Final answer",
  })]);
  const view = projectOrdinaryPanelRunView({ run, fullReplay: replay });

  assert.equal(view.run.status, "completed");
  assert.equal(view.workView.headline, "");
  assert.deepEqual(view.workView.answer, {
    title: "",
    content: "Final answer",
    evidenceRefs: [],
    nextActions: [],
  });
  assert.equal(view.detail.stopReason, "completed");
  assert.equal(view.detail.continuationAvailability, "none");
});

test("failed conversation turns keep failure facts separate from assistant content", () => {
  const base = runState();
  const conversation = projectOrdinaryConversation({
    control: {
      state: {
        conversationId: "conversation-1",
        createdAt: "2026-08-24T00:00:00.000Z",
      },
      savedAt: "2026-08-24T00:00:02.000Z",
    },
    runs: [{
      ...base,
      birth: { ...base.birth, config: modelProfile() },
      status: { kind: "failed", error: { code: "provider_failed", message: "模型请求失败。" } },
    }],
  });

  assert.deepEqual(conversation.turns[1].content, "");
  assert.deepEqual(conversation.turns[1].failure, {
    code: "provider_failed",
    message: "模型请求失败。",
  });
});

test("conversation filters owner context and preserves encoded attachment media URL", () => {
  const conversation = {
    conversationId: "conversation-1",
    title: "Attachment discussion",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:02.000Z",
    activeRunId: "run-1",
    latestRunId: "run-1",
    queuedRunIds: [],
    turns: [
      {
        role: "user",
        turnId: "user-1",
        runId: "run-1",
        content: "Review this image",
        input: {
          userMessage: "Review this image",
          context: {
            contextRefs: [
              { kind: "workspace", ref: "workspace:root", automaticSpaceReference: true },
              {
                kind: "file",
                ref: "managed:image-1",
                attachmentId: "image/id 1",
                title: "diagram.png",
                metadata: { available: true, mimeType: "image/png", byteLength: 123, truncated: false },
              },
            ],
            permissionBoundaryRefs: [],
          },
        },
        status: "completed",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
      },
      {
        role: "assistant",
        turnId: "assistant-1",
        runId: "run-1",
        content: "",
        status: "awaiting_approval",
        model: modelProfile(),
        createdAt: "2026-08-24T00:00:01.000Z",
        updatedAt: "2026-08-24T00:00:02.000Z",
      },
    ],
  };
  const projected = projectOrdinaryPanelConversation({ conversation });

  assert.equal(projected.status, "approval_needed");
  assert.equal(projected.requiresUserAction, true);
  assert.deepEqual(projected.pendingAction, {
    kind: "approval",
    runId: "run-1",
    assistantTurnId: "assistant-1",
  });
  assert.equal(projected.turns[0].attachments.length, 1);
  assert.equal(projected.turns[0].attachments[0].title, "diagram.png");
  assert.deepEqual(projected.turns[0].attachments[0].mediaPreview, {
    kind: "image",
    url: "/api/context/attachments/media/image%2Fid%201",
    mimeType: "image/png",
    byteLength: 123,
  });
});

function runState(overrides = {}) {
  return {
    runId: "run-1",
    sessionRef: { sessionId: "session-1" },
    turn: {
      conversationId: "conversation-1",
      ordinal: 1,
      userTurnId: "user-1",
      assistantTurnId: "assistant-1",
    },
    input: { userMessage: "Do the work" },
    birth: {
      agentDefinitionRef: { agentId: "ordinary", revision: "1" },
      capabilitySnapshot: { executionRoot: "Z:/Workspace" },
    },
    status: { kind: "running" },
    session: { phase: "not_started" },
    toolCalls: [],
    toolResultRecordedAt: {},
    usage: {},
    timeline: [],
    timestamps: {
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:01.000Z",
    },
    ...overrides,
  };
}

function activityReplay(activities) {
  return {
    cursor: { streamId: "stream-1", sequence: activities.at(-1)?.sequence ?? 0 },
    reset: false,
    activities,
  };
}

function panelEvent(id, sequence, type, modelRequestId, overrides = {}) {
  return {
    id,
    runId: "run-1",
    sequence,
    type,
    title: "",
    status: "running",
    refs: modelRequestId === undefined ? [] : [{ kind: "model_call", id: modelRequestId }],
    ...overrides,
  };
}

function activity(activityId, sequence, facts) {
  return {
    activityId,
    runId: "run-1",
    sequence,
    recordedAt: `2026-08-24T00:00:0${sequence}.000Z`,
    durability: facts.type === "model.output.completed" ? "durable" : "live_only",
    ...facts,
  };
}

function modelProfile() {
  return {
    profileId: "default",
    label: "Model",
    providerKind: "openai_compatible",
    protocolKind: "openai_compatible_chat_completions",
    baseUrl: "https://example.test/v1",
    model: "model",
    defaultAiMode: "openai-compatible",
    secretRef: "secret://model",
    secretConfigured: true,
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}
