import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { createHash } from "node:crypto";
import {
  appendList, branchTip, insertEntry, laneState, list, operationState,
  operationToolArgsPrefix, pendingEntry, setValue,
} from "@earendil-works/pi-agent-core/harness/session";

const outputRoot = path.resolve(process.env.SYNECH_TEST_DIST ?? "dist");
const { FileSystemAgentSessionRepository } = await import(pathToFileURL(path.join(outputRoot, "adapters/intelligence/file-system-agent-session-repository.js")));
const { AgentSessionRepositoryError } = await import(pathToFileURL(path.join(outputRoot, "app/model-runtime/agent-session.js")));
const { createAgentRuntimeEnvironment } = await import(pathToFileURL(path.join(outputRoot, "adapters/intelligence/pi-agent/runtime-environment.js")));
const { SessionGenerationError } = await import(pathToFileURL(path.join(outputRoot, "adapters/intelligence/session-write-fence.js")));

function createRepository(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "synech-agent-session-"));
  const sessionsRoot = path.join(root, "sessions");
  const repo = new FileSystemAgentSessionRepository({
    executionEnvironment: createAgentRuntimeEnvironment(root),
    sessionsRoot,
    ...options,
  });
  return { repo, root, sessionsRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function userMessage(text) {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text, toolCalls = []) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "openai",
    model: "m",
    content: toolCalls.length === 0 ? [{ type: "text", text }] : toolCalls,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: toolCalls.length === 0 ? "stop" : "toolUse",
    timestamp: Date.now(),
  };
}

function toolResult(providerCallId, invocationId, toolName, text) {
  return {
    providerCallId,
    invocationId,
    toolName,
    input: {},
    output: { kind: "text", text },
    status: "completed",
  };
}

async function seedBranch(session, entries) {
  await session.createBranch("main", null, TODO_CONTEXT);
  const branch = await session.branch("main", TODO_CONTEXT);
  for (const entry of entries) await branch.appendMessage(entry, TODO_CONTEXT);
  return branch;
}

/** Records one checkpoint per transcript position, in branch order. */
async function recordPositionCheckpoints(repo, sessionRef, positions, kind) {
  const checkpoints = [];
  for (const entryRef of positions) {
    checkpoints.push(await repo.recordSessionCheckpoint({ sessionRef, kind, entryRef }));
  }
  return checkpoints;
}

test("Agent session repository serves reads on the live writer's line across release and reopen", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "round-trip", sessionCwd: process.cwd() });
    assert.equal(ref.sessionId, "round-trip");

    const first = await repo.acquire(ref);
    assert.ok(first.session !== undefined, "acquire must expose a usable session handle");
    // Pi opens a session only once, so a read during an active writer runs on the
    // writer's own line instead of opening a second handle.
    assert.deepEqual(await repo.activeTranscriptPositions(ref), [], "a fresh session has no transcript position");
    await seedBranch(first.session, [userMessage("committed by the live writer")]);
    assert.equal(
      (await repo.activeTranscriptPositions(ref)).length,
      1,
      "a read must see the entry the live writer committed",
    );
    await first.release();

    const second = await repo.acquire(ref);
    assert.equal(
      (await repo.activeTranscriptPositions(ref)).length,
      1,
      "the reopened writer also serves reads on the session's line",
    );
    await second.release();
    assert.equal(
      (await repo.activeTranscriptPositions(ref)).length,
      1,
      "reads succeed once the writer is released",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session repository reads provider-ordered tool calls by checkpoint", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "checkpoint-toolcalls", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [
      userMessage("go"),
      assistantMessage("", [
        { type: "toolCall", id: "call-x", name: "ToolX", arguments: { a: 1 } },
        { type: "toolCall", id: "call-y", name: "ToolY", arguments: { b: 2 } },
      ]),
    ]);
    await lease.release();

    const positions = await repo.activeTranscriptPositions(ref);
    const checkpoint = await repo.recordSessionCheckpoint({
      sessionRef: ref,
      kind: "assistant_tool_calls_committed",
      entryRef: positions[1],
    });
    assert.equal(checkpoint.checkpointId, "assistant_tool_calls_committed#1");

    const calls = await repo.readToolCallsByCheckpoint({ sessionRef: ref, checkpoint });
    assert.equal(calls.length, 2, "both provider calls must be read back");
    assert.deepEqual(calls.map((call) => call.providerCallId), ["call-x", "call-y"]);
    assert.deepEqual(calls.map((call) => call.toolName), ["ToolX", "ToolY"]);
    assert.deepEqual(calls[1].input, { b: 2 });

    await assert.rejects(
      () => repo.readToolCallsByCheckpoint({
        sessionRef: ref,
        checkpoint: { ...checkpoint, checkpointId: "missing#1" },
      }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_checkpoint_unknown",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session repository mints one identity per checkpoint of a kind", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "checkpoint-ordinal", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [userMessage("a"), assistantMessage("b"), assistantMessage("c")]);
    await lease.release();

    const positions = await repo.activeTranscriptPositions(ref);
    const firstInput = await repo.recordSessionCheckpoint({
      sessionRef: ref,
      kind: "assistant_response_committed",
      entryRef: positions[1],
    });
    const secondInput = await repo.recordSessionCheckpoint({
      sessionRef: ref,
      kind: "assistant_response_committed",
      entryRef: positions[2],
    });

    // A per-kind ordinal held only in memory would hand both writes the same
    // identity and silently overwrite the first mapping.
    assert.equal(firstInput.checkpointId, "assistant_response_committed#1");
    assert.equal(secondInput.checkpointId, "assistant_response_committed#2");
    const texts = await repo.readAssistantEntriesByCheckpoint({
      sessionRef: ref,
      checkpoints: [
        { sessionId: ref.sessionId, checkpointId: firstInput.checkpointId, kind: firstInput.kind },
        { sessionId: ref.sessionId, checkpointId: secondInput.checkpointId, kind: secondInput.kind },
      ],
    });
    assert.deepEqual(texts.map((entry) => entry.text), ["b", "c"]);
  } finally {
    await cleanup();
  }
});

test("Agent session repository reads a checkpoint the live writer just recorded", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "live-writer-read", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [userMessage("go"), assistantMessage("live answer")]);
    const positions = await repo.activeTranscriptPositions(ref);
    const checkpoint = await lease.recordCheckpoint("assistant_response_committed", positions[1]);

    // The run reads back the text of the checkpoint it just committed on its own
    // line, so this read must be served while the writer is still live.
    const entries = await repo.readAssistantEntriesByCheckpoint({ sessionRef: ref, checkpoints: [checkpoint] });
    assert.deepEqual(entries.map((entry) => entry.text), ["live answer"]);
    await lease.release();
  } finally {
    await cleanup();
  }
});

test("Agent session repository keeps the checkpoint mapping across reopen", async () => {
  const { repo, root, sessionsRoot, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "checkpoint-durable", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [userMessage("one"), assistantMessage("durable answer")]);
    await lease.release();
    const positions = await repo.activeTranscriptPositions(ref);
    const checkpoint = await repo.recordSessionCheckpoint({
      sessionRef: ref,
      kind: "assistant_response_committed",
      entryRef: positions[1],
    });

    // A fresh repository instance over the same directory must resolve the
    // mapping from durable state, not from in-memory writer bookkeeping.
    const reopened = new FileSystemAgentSessionRepository({
      executionEnvironment: createAgentRuntimeEnvironment(root),
      sessionsRoot,
    });
    const entries = await reopened.readAssistantEntriesByCheckpoint({
      sessionRef: ref,
      checkpoints: [checkpoint],
    });
    assert.equal(entries.length, 1, "a new repository instance must resolve the same checkpoint");
    assert.equal(entries[0].text, "durable answer");
  } finally {
    await cleanup();
  }
});

test("Agent session repository fails explicitly on an unknown checkpoint", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "checkpoint-missing", sessionCwd: process.cwd() });
    await assert.rejects(
      () => repo.readAssistantEntriesByCheckpoint({
        sessionRef: ref,
        checkpoints: [{
          sessionId: ref.sessionId,
          checkpointId: "never_recorded#1",
          kind: "input_committed",
        }],
      }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_checkpoint_unknown",
      "a missing mapping must not be guessed or silently rebuilt",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session repository fails explicitly on a checkpoint kind conflict", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "checkpoint-conflict", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [userMessage("one"), assistantMessage("two")]);
    await lease.release();
    const positions = await repo.activeTranscriptPositions(ref);
    const recorded = await repo.recordSessionCheckpoint({
      sessionRef: ref,
      kind: "input_committed",
      entryRef: positions[0],
    });

    await assert.rejects(
      () => repo.readAssistantEntriesByCheckpoint({
        sessionRef: ref,
        checkpoints: [{ ...recorded, kind: "assistant_response_committed" }],
      }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_checkpoint_conflict",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session repository rejects a checkpoint from another session", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const a = await repo.create({ sessionId: "checkpoint-own", sessionCwd: process.cwd() });
    const b = await repo.create({ sessionId: "checkpoint-foreign", sessionCwd: process.cwd() });
    const lease = await repo.acquire(a);
    await seedBranch(lease.session, [userMessage("one")]);
    await lease.release();
    const positions = await repo.activeTranscriptPositions(a);
    const checkpoint = await repo.recordSessionCheckpoint({
      sessionRef: a,
      kind: "input_committed",
      entryRef: positions[0],
    });

    await assert.rejects(
      () => repo.readAssistantEntriesByCheckpoint({ sessionRef: b, checkpoints: [checkpoint] }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_ref_invalid",
    );

    await assert.rejects(
      () => repo.recordSessionCheckpoint({ sessionRef: b, kind: "input_committed", entryRef: positions[0] }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_ref_invalid",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session repository reads assistant text by checkpoint only", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "checkpoint-read", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [
      userMessage("one"),
      assistantMessage("first answer"),
      assistantMessage("second answer"),
    ]);
    await lease.release();

    const positions = await repo.activeTranscriptPositions(ref);
    const firstAnswer = await repo.recordSessionCheckpoint({
      sessionRef: ref,
      kind: "assistant_response_committed",
      entryRef: positions[1],
    });
    const secondAnswer = await repo.recordSessionCheckpoint({
      sessionRef: ref,
      kind: "assistant_response_committed",
      entryRef: positions[2],
    });

    const entries = await repo.readAssistantEntriesByCheckpoint({
      sessionRef: ref,
      checkpoints: [secondAnswer, firstAnswer],
    });
    assert.deepEqual(entries.map((entry) => entry.text), ["second answer", "first answer"]);
  } finally {
    await cleanup();
  }
});

test("Agent session repository rejects a duplicate session id", async () => {
  const { repo, cleanup } = createRepository();
  try {
    await repo.create({ sessionId: "dup", sessionCwd: process.cwd() });
    await assert.rejects(
      () => repo.create({ sessionId: "dup", sessionCwd: process.cwd() }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_duplicate",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session repository reports a missing session as not found", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "exists", sessionCwd: process.cwd() });
    await assert.rejects(
      () => repo.acquire({ ...ref, sessionId: "absent" }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_not_found",
    );
    await assert.rejects(
      () => repo.activeTranscriptPositions({ ...ref, sessionId: "absent" }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_not_found",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session repository allows only one active writer per session", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "single-writer", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await assert.rejects(
      () => repo.acquire(ref),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_writer_active",
    );
    await lease.release();

    const reopened = await repo.acquire(ref);
    await reopened.release();
  } finally {
    await cleanup();
  }
});

test("Agent session repository restores the active branch to a product checkpoint", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "branch-order", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [
      userMessage("first"),
      assistantMessage("second"),
      userMessage("third"),
    ]);
    await lease.release();

    const positions = await repo.activeTranscriptPositions(ref);
    assert.equal(positions.length, 3, "the active branch must expose every committed entry");
    const assistantAnswer = await repo.recordSessionCheckpoint({
      sessionRef: ref,
      kind: "assistant_response_committed",
      entryRef: positions[1],
    });
    const entries = await repo.readAssistantEntriesByCheckpoint({
      sessionRef: ref,
      checkpoints: [assistantAnswer],
    });
    assert.deepEqual(entries.map((entry) => entry.text), ["second"]);

    assert.equal(await repo.moveActiveCheckpoint(ref, assistantAnswer), assistantAnswer);
    const restored = await repo.activeTranscriptPositions(ref);
    assert.equal(restored.length, 2, "the active branch must stop at the restored checkpoint");
    assert.equal(restored.at(-1).entryId, positions[1].entryId);
  } finally {
    await cleanup();
  }
});

test("Agent session repository rejects restoring an unknown checkpoint", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "branch-unknown", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [userMessage("first"), assistantMessage("second")]);
    await lease.release();

    await assert.rejects(
      () => repo.moveActiveCheckpoint(ref, {
        sessionId: ref.sessionId,
        checkpointId: "run_started#1",
        kind: "run_started",
      }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_checkpoint_unknown",
      "a rollback target must never fall back to the current branch tip",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session repository reconciles tool results in provider order", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "reconcile", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [
      userMessage("go"),
      assistantMessage("", [
        { type: "toolCall", id: "call-a", name: "ToolA", arguments: { v: 1 } },
        { type: "toolCall", id: "call-b", name: "ToolB", arguments: { v: 2 } },
      ]),
    ]);
    await lease.release();

    const positions = await repo.activeTranscriptPositions(ref);
    const assistantCheckpoint = await repo.recordSessionCheckpoint({
      sessionRef: ref,
      kind: "assistant_tool_calls_committed",
      entryRef: positions[1],
    });
    const toolRound = await repo.reconcileToolResultEntries({
      sessionRef: ref,
      assistantCheckpoint,
      orderedResults: [
        toolResult("call-a", "inv-a", "ToolA", "handled-a"),
        toolResult("call-b", "inv-b", "ToolB", "handled-b"),
      ],
    });

    const after = await repo.activeTranscriptPositions(ref);
    assert.equal(after.length, 4, "the tool results must be appended in provider order");
    assert.equal(toolRound.kind, "tool_results_committed");
    assert.equal(toolRound.checkpointId, "tool_results_committed#1");

    // Reconciliation is idempotent: the same durable round keeps its identity.
    const repeated = await repo.reconcileToolResultEntries({
      sessionRef: ref,
      assistantCheckpoint,
      orderedResults: [
        toolResult("call-a", "inv-a", "ToolA", "handled-a"),
        toolResult("call-b", "inv-b", "ToolB", "handled-b"),
      ],
    });
    assert.equal(repeated.checkpointId, toolRound.checkpointId, "a retried round must not mint a new identity");
    assert.equal((await repo.activeTranscriptPositions(ref)).length, 4, "a retried round must not duplicate writes");
  } finally {
    await cleanup();
  }
});

test("Agent session repository rejects reconciliation whose results do not match the assistant order", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "reconcile-mismatch", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [
      userMessage("go"),
      assistantMessage("", [{ type: "toolCall", id: "call-a", name: "ToolA", arguments: {} }]),
    ]);
    await lease.release();
    const positions = await repo.activeTranscriptPositions(ref);
    const assistantCheckpoint = await repo.recordSessionCheckpoint({
      sessionRef: ref,
      kind: "assistant_tool_calls_committed",
      entryRef: positions[1],
    });

    await assert.rejects(
      () => repo.reconcileToolResultEntries({
        sessionRef: ref,
        assistantCheckpoint,
        orderedResults: [toolResult("call-a", "inv-a", "WrongTool", "x")],
      }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_ref_invalid",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session image reconciliation after reopen uses durable refs without a second payload store", async () => {
  const { repo, cleanup } = createRepository();
  const data = "aW1hZ2U=";
  const result = {
    ...toolResult("image-call", "image-invocation", "ImageTool", "image metadata"),
    modelAttachmentRefs: [{ kind: "image", mimeType: "image/png",
      sha256: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex") }],
  };
  try {
    const ref = await repo.create({ sessionId: "reconcile-image", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    const { canonicalToolResultMessage } = await import(pathToFileURL(path.join(outputRoot, "app/model-runtime/tool-result-message.js")));
    await seedBranch(lease.session, [
      userMessage("inspect"),
      assistantMessage("", [{ type: "toolCall", id: "image-call", name: "ImageTool", arguments: {} }]),
      { role: "toolResult", toolCallId: "image-call", toolName: "ImageTool", isError: false,
        content: [{ type: "text", text: canonicalToolResultMessage(result).content },
          { type: "image", mimeType: "image/png", data }], timestamp: Date.now() },
    ]);
    await lease.release();
    const positions = await repo.activeTranscriptPositions(ref);
    const checkpoint = await repo.recordSessionCheckpoint({ sessionRef: ref,
      kind: "assistant_tool_calls_committed", entryRef: positions[1] });
    await repo.reconcileToolResultEntries({ sessionRef: ref, assistantCheckpoint: checkpoint, orderedResults: [result] });
    assert.equal((await repo.activeTranscriptPositions(ref)).length, 3);
    assert.ok(!JSON.stringify(result).includes(data));
    await assert.rejects(repo.reconcileToolResultEntries({ sessionRef: ref, assistantCheckpoint: checkpoint,
      orderedResults: [{ ...result, modelAttachmentRefs: [{ ...result.modelAttachmentRefs[0], sha256: "0".repeat(64) }] }] }),
    (error) => error.code === "agent_session_attachment_mismatch");
  } finally { await cleanup(); }
});

/** Runs in a child so process exit cannot give Pi a chance to clean up pending outcomes. */
async function crashAtPendingImage({ root, sessionsRoot, outputRoot }) {
  const { AgentHarness } = await import("@earendil-works/pi-agent-core");
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
  const { TODO_CONTEXT } = await import("@earendil-works/pi-agent-core/harness/context");
  const { laneState, operationState, pendingEntry } = await import("@earendil-works/pi-agent-core/harness/session");
  const { pathToFileURL } = await import("node:url");
  const path = await import("node:path");
  const { writeSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { FileSystemAgentSessionRepository } = await import(pathToFileURL(path.join(outputRoot,
    "adapters/intelligence/file-system-agent-session-repository.js")));
  const { createAgentRuntimeEnvironment } = await import(pathToFileURL(path.join(outputRoot,
    "adapters/intelligence/pi-agent/runtime-environment.js")));
  const { canonicalToolResultMessage } = await import(pathToFileURL(path.join(outputRoot,
    "app/model-runtime/tool-result-message.js")));
  const repo = new FileSystemAgentSessionRepository({
    executionEnvironment: createAgentRuntimeEnvironment(root), sessionsRoot,
  });
  const ref = await repo.create({ sessionId: "pending-image-crash", sessionCwd: process.cwd() });
  const lease = await repo.acquire(ref);
  const data = "aW1hZ2U=";
  const results = [
    toolResult("text-call", "text-invocation", "TextTool", "text metadata"),
    { ...toolResult("image-call", "image-invocation", "ImageTool", "image metadata"),
      modelAttachmentRefs: [{ kind: "image", mimeType: "image/png", byteLength: Buffer.from(data, "base64").length,
        sha256: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex") }] },
  ];
  const model = {
    id: "m", name: "m", provider: "openai", api: "openai-completions", baseUrl: "https://example.invalid/v1",
    reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0 },
    contextWindow: 32_000, maxTokens: 1_024,
  };
  let requests = 0;
  let executions = 0;
  const models = {
    getProviders: () => [], getProvider: () => undefined,
    getModels: () => [model], getModel: () => model, getAuth: async () => undefined,
    streamSimple() {
      if (++requests !== 1) throw new Error("Unexpected provider replay.");
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage("", [
        { type: "text", text: "Inspect both outputs." },
        ...results.map((result) => ({ type: "toolCall", id: result.providerCallId,
          name: result.toolName, arguments: {} })),
      ]);
      message.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    },
  };
  const created = await AgentHarness.create({ session: lease.session, models, model, toolExecution: "sequential",
    tools: results.map((result, index) => ({
      name: result.toolName, label: result.toolName, description: result.toolName,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        executions += 1;
        return { content: [{ type: "text", text: canonicalToolResultMessage(result).content },
          ...(index === 1 ? [{ type: "image", mimeType: "image/png", data }] : [])],
          ...(index === 1 ? { terminate: true, usage: { input: 0, output: 3,
            cacheRead: 0, cacheWrite: 0, totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}) };
      },
    })), compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 4096 },
  }, TODO_CONTEXT);
  let recoveryCheckpoint;
  let assistantCheckpoint;
  created.harness.events.on("entry_added", async (event) => {
    if (event.entry.type === "message" && event.entry.message.role === "user") {
      recoveryCheckpoint = await lease.recordCheckpoint("input_committed", {
        sessionId: ref.sessionId, entryId: event.entry.id,
      });
    }
  });
  created.harness.events.on("message_end", async (event) => {
    if (event.message.role === "assistant") {
      assistantCheckpoint = await lease.recordCheckpoint("assistant_tool_calls_committed", {
        sessionId: ref.sessionId, entryId: event.entryId,
      });
    }
    if (event.message.role !== "toolResult" || event.message.toolName !== "ImageTool") return;
    const lane = await lease.session.getValue(laneState("main"), TODO_CONTEXT);
    const operationId = lane.value.currentOperationId;
    const operation = (await lease.session.getValue(operationState(operationId), TODO_CONTEXT)).value;
    const pending = await lease.session.getValue(pendingEntry(event.entryId), TODO_CONTEXT);
    assert.equal(operation.at, "tools");
    assert.deepEqual(operation.batch.calls.map((call) => call.status), ["completed", "outcome_ready"]);
    assert.deepEqual(operation.batch.calls.map((call) => call.sourceIndex), [1, 2]);
    assert.deepEqual(pending.value.payload, event.message);
    assert.equal(await lease.session.getEntry(event.entryId, TODO_CONTEXT), undefined);
    assert.ok(recoveryCheckpoint && assistantCheckpoint);
    // Product acceptance has only refs. Rollback hides the assistant and already placed text result.
    await lease.revokeTo(recoveryCheckpoint);
    writeSync(1, JSON.stringify({ ref, results, model, recoveryCheckpoint, assistantCheckpoint,
      operationId, batch: operation.batch, requests, executions }));
    process.exit(73);
  });
  const lane = await created.harness.lane("main", TODO_CONTEXT);
  await lane.prompt("inspect", [], TODO_CONTEXT);
  throw new Error("The pending image crash boundary was not reached.");
}

test("Agent session restores Pi pending images after process exit and rejects mismatches before writes", { timeout: 20_000 }, async () => {
  const { root, sessionsRoot, cleanup } = createRepository();
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const assistantMessage = ${assistantMessage.toString()};
      const toolResult = ${toolResult.toString()};
      await (${crashAtPendingImage.toString()})(${JSON.stringify({ root, sessionsRoot, outputRoot })});
    `], { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 73, child.stderr || child.error?.message || child.stdout);
    const saved = JSON.parse(child.stdout);
    assert.equal(saved.requests, 1);
    assert.equal(saved.executions, 2);
    assert.ok(!child.stdout.includes("aW1hZ2U="), "accepted product facts must contain refs, not image bytes");
    const repo = new FileSystemAgentSessionRepository({
      executionEnvironment: createAgentRuntimeEnvironment(root), sessionsRoot,
    });
    const file = path.join(sessionsRoot, saved.ref.storageKey);
    const before = readFileSync(file);
    const positions = await repo.activeTranscriptPositions(saved.ref);
    assert.equal(positions.length, 1, "crash left the branch at the product rollback checkpoint");
    const imageResult = saved.results[1];
    for (const [change, code] of [
      [{ modelAttachmentRefs: [{ ...imageResult.modelAttachmentRefs[0], sha256: "0".repeat(64) }] }, "agent_session_attachment_mismatch"],
      [{ modelAttachmentRefs: [{ ...imageResult.modelAttachmentRefs[0], byteLength: 99 }] }, "agent_session_attachment_mismatch"],
      [{ output: { kind: "text", text: "different accepted text" } }, "agent_session_ref_invalid"],
      [{ status: "failed" }, "agent_session_ref_invalid"],
      [{ providerCallId: "another-call" }, "agent_session_ref_invalid"],
    ]) {
      await assert.rejects(() => repo.reconcileToolResultEntries({
        sessionRef: saved.ref, assistantCheckpoint: saved.assistantCheckpoint,
        recoveryCheckpoint: saved.recoveryCheckpoint, orderedResults: [saved.results[0], { ...imageResult, ...change }],
      }), (error) => error instanceof AgentSessionRepositoryError && error.code === code);
      assert.deepEqual(readFileSync(file), before, "mismatch must not write branch, pending or operation state");
      assert.deepEqual(await repo.activeTranscriptPositions(saved.ref), positions);
    }
    const input = { sessionRef: saved.ref, assistantCheckpoint: saved.assistantCheckpoint,
      recoveryCheckpoint: saved.recoveryCheckpoint, orderedResults: saved.results };
    const checkpoint = await repo.reconcileToolResultEntries(input);
    assert.deepEqual(await repo.reconcileToolResultEntries(input), checkpoint, "retry must reuse the checkpoint");
    const recovered = await repo.acquire(saved.ref);
    let harness;
    try {
      const after = await repo.activeTranscriptPositions(saved.ref);
      assert.equal(after.length, 4);
      assert.deepEqual(after.slice(2).map((entry) => entry.entryId), saved.batch.calls.map((call) => call.resultEntryId));
      const imageEntry = await recovered.session.getEntry(saved.batch.calls[1].resultEntryId, TODO_CONTEXT);
      assert.equal(imageEntry.terminate, true);
      assert.equal(imageEntry.message.content[1].data, "aW1hZ2U=");
      assert.equal(await recovered.session.getValue(pendingEntry(imageEntry.id), TODO_CONTEXT), undefined);
      const state = (await recovered.session.getValue(operationState(saved.operationId), TODO_CONTEXT)).value;
      assert.equal(state.at, "checkpoint");
      assert.equal(state.triggerEntryId, imageEntry.id);
      assert.deepEqual(state.continuation, { kind: "need_assistant", overflowRecoveryUsed: false });
      assert.deepEqual(await recovered.session.scanValues(operationToolArgsPrefix(saved.operationId), TODO_CONTEXT), []);
      const usage = await recovered.session.getStats(TODO_CONTEXT);
      assert.equal(usage.usage.output, 4, "pending tool usage is inserted exactly once alongside assistant usage");
      const { AgentHarness } = await import("@earendil-works/pi-agent-core");
      const created = await AgentHarness.create({ session: recovered.session, model: saved.model,
        models: { getProviders: () => [], getProvider: () => undefined, getModels: () => [saved.model],
          getModel: () => saved.model, getAuth: async () => undefined,
          streamSimple() { assert.fail("Recovery must not request the provider."); } }, tools: [],
      }, TODO_CONTEXT);
      harness = created.harness;
      assert.equal(created.open.length, 1, "reconciliation leaves lifecycle closure to the existing startup abort");
      const lane = await harness.lane("main", TODO_CONTEXT);
      const aborted = await lane.abort(TODO_CONTEXT);
      assert.equal(aborted.ok, true);
      assert.equal((await recovered.session.getValue(laneState("main"), TODO_CONTEXT)).value.currentOperationId, null);
      assert.deepEqual(await repo.activeTranscriptPositions(saved.ref), after, "abort must not place another result");
    } finally {
      await harness?.close(TODO_CONTEXT);
      await recovered.release();
    }
  } finally {
    cleanup();
  }
});

test("Agent session repository deletes a session and forgets it", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "delete-me", sessionCwd: process.cwd() });
    await repo.delete(ref);
    await repo.delete(ref);
    await assert.rejects(
      () => repo.activeTranscriptPositions(ref),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_not_found",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session repository leaves no open handle after a read", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "repeat-read", sessionCwd: process.cwd() });

    assert.deepEqual(await repo.activeTranscriptPositions(ref), []);
    assert.deepEqual(await repo.activeTranscriptPositions(ref), [], "a second read must not find the session locked");
    assert.deepEqual(await repo.activeTranscriptPositions(ref), [], "a repeated branch read must succeed");

    const lease = await repo.acquire(ref);
    await lease.release();
  } finally {
    await cleanup();
  }
});

test("Agent session repository shares one scoped read handle across concurrent reads", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "concurrent-read", sessionCwd: process.cwd() });
    const jsonlRepository = repo.jsonlRepository;
    const originalOpen = jsonlRepository.open.bind(jsonlRepository);
    let openCount = 0;
    let releaseOpen;
    const firstOpen = new Promise((resolve) => { releaseOpen = resolve; });
    jsonlRepository.open = async (...args) => {
      openCount += 1;
      const session = await originalOpen(...args);
      if (openCount === 1) await firstOpen;
      return session;
    };

    const firstRead = repo.activeTranscriptPositions(ref);
    while (openCount === 0) await new Promise((resolve) => setImmediate(resolve));
    const secondRead = repo.activeTranscriptPositions(ref);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(openCount, 1, "concurrent reads must share the session-scoped handle gate");

    releaseOpen();
    assert.deepEqual(await Promise.all([firstRead, secondRead]), [[], []]);
  } finally {
    await cleanup();
  }
});

test("Agent session repository reads through the fenced writer during a writer callback", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "read-write-interleave", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [userMessage("before interleave")]);

    let releaseMutation;
    let mutationStarted;
    const mutationReady = new Promise((resolve) => { mutationStarted = resolve; });
    const mutationRelease = new Promise((resolve) => { releaseMutation = resolve; });
    const mutation = lease.session.mutate(async () => {
      mutationStarted();
      await mutationRelease;
    }, TODO_CONTEXT);

    await mutationReady;
    assert.deepEqual(
      (await repo.activeTranscriptPositions(ref)).length,
      1,
      "a read during a writer callback must use the active fenced handle",
    );
    releaseMutation();
    await mutation;
    await lease.release();
  } finally {
    await cleanup();
  }
});

test("Agent session repository closes handles after metadata validation failures", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "metadata-close", sessionCwd: process.cwd() });
    const originalOpen = repo.jsonlRepository.open;
    const mismatchedMetadataOpen = async (...args) => {
      const session = await originalOpen.apply(repo.jsonlRepository, args);
      return new Proxy(session, {
        get(target, property, receiver) {
          if (property === "metadata") {
            return { ...target.metadata, createdAt: target.metadata.createdAt + 1 };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    };
    repo.jsonlRepository.open = mismatchedMetadataOpen;

    await assert.rejects(
      () => repo.activeTranscriptPositions(ref),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_metadata_mismatch",
    );
    repo.jsonlRepository.open = originalOpen;

    assert.deepEqual(await repo.activeTranscriptPositions(ref), [], "metadata failures must not strand the handle");
    const lease = await repo.acquire(ref);
    await lease.release();
  } finally {
    await cleanup();
  }
});

test("Agent session repository preserves unknown open failures", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "open-failure", sessionCwd: process.cwd() });
    const jsonlRepository = repo.jsonlRepository;
    const originalOpen = jsonlRepository.open;
    const providerFailure = new Error("storage temporarily unavailable");
    jsonlRepository.open = async () => { throw providerFailure; };

    await assert.rejects(
      () => repo.activeTranscriptPositions(ref),
      (error) => error === providerFailure,
      "an unknown provider open error must not be mapped to not_found",
    );

    jsonlRepository.open = originalOpen;
    assert.deepEqual(await repo.activeTranscriptPositions(ref), []);
  } finally {
    await cleanup();
  }
});

test("Agent session repository locates durable checkpoints by transcript position", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "locate", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [
      userMessage("one"),
      assistantMessage("two"),
      userMessage("three"),
    ]);
    await lease.release();

    const positions = await repo.activeTranscriptPositions(ref);
    const checkpoints = await recordPositionCheckpoints(repo, ref, positions, "input_committed");
    const located = await repo.locateSessionCheckpoints({
      sessionRef: ref,
      checkpoints: [...checkpoints].reverse(),
    });

    assert.equal(located.length, 3, "every supplied on-branch checkpoint must be located");
    const positionById = new Map(located.map((item) => [item.checkpoint.checkpointId, item.position]));
    for (const [index, checkpoint] of checkpoints.entries()) {
      assert.equal(positionById.get(checkpoint.checkpointId), index, "position must follow branch order, not input order");
    }
  } finally {
    await cleanup();
  }
});

test("Agent session repository omits checkpoints that are no longer on the branch", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "locate-off-branch", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [
      userMessage("one"),
      assistantMessage("two"),
      userMessage("three"),
    ]);
    await lease.release();

    const positions = await repo.activeTranscriptPositions(ref);
    const checkpoints = await recordPositionCheckpoints(repo, ref, positions, "input_committed");
    const restoreTarget = checkpoints[1];
    assert.equal(await repo.moveActiveCheckpoint(ref, restoreTarget), restoreTarget);

    const located = await repo.locateSessionCheckpoints({ sessionRef: ref, checkpoints });
    assert.equal(located.length, 2, "an entry beyond the restored tip must not report a position");
    assert.ok(!located.some((item) => item.checkpoint.checkpointId === checkpoints[2].checkpointId));
    assert.equal(
      located.map((item) => item.position).sort((left, right) => right - left)[0],
      1,
      "the deepest located checkpoint must be the restored tip",
    );
  } finally {
    await cleanup();
  }
});

test("Agent session repository deduplicates and rejects foreign checkpoints", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const a = await repo.create({ sessionId: "locate-dup", sessionCwd: process.cwd() });
    const lease = await repo.acquire(a);
    await seedBranch(lease.session, [userMessage("one"), assistantMessage("two")]);
    await lease.release();
    const positions = await repo.activeTranscriptPositions(a);
    const checkpoints = await recordPositionCheckpoints(repo, a, positions, "input_committed");

    const duplicated = await repo.locateSessionCheckpoints({
      sessionRef: a,
      checkpoints: [...checkpoints, checkpoints[0], checkpoints[1]],
    });
    assert.equal(duplicated.length, 2, "identical checkpoints must be located once");

    const b = await repo.create({ sessionId: "locate-other", sessionCwd: process.cwd() });
    await assert.rejects(
      () => repo.locateSessionCheckpoints({ sessionRef: b, checkpoints }),
      (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_ref_invalid",
      "a checkpoint from another session must be rejected, not silently dropped",
    );

    assert.deepEqual(await repo.locateSessionCheckpoints({ sessionRef: a, checkpoints: [] }), []);
  } finally {
    await cleanup();
  }
});

test("Agent session repository allocates concurrent checkpoints atomically across index pages", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "checkpoint-concurrent", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [assistantMessage("first"), assistantMessage("second")]);
    const positions = await repo.activeTranscriptPositions(ref);
    const address = list("synech.checkpoint", "recorded");
    await lease.session.mutate((mutator) => mutator.commit(
      Array.from({ length: 10_001 }, (_, index) => appendList(address, {
        checkpointId: "assistant_response_committed#" + (index + 1),
        kind: "assistant_response_committed",
        entryId: positions[0].entryId,
      })),
      TODO_CONTEXT,
    ), TODO_CONTEXT);

    const checkpoints = await Promise.all(positions.map((entryRef) =>
      lease.recordCheckpoint("assistant_response_committed", entryRef)));
    assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.checkpointId), [
      "assistant_response_committed#10002", "assistant_response_committed#10003",
    ]);
    await lease.release();
    const entries = await repo.readAssistantEntriesByCheckpoint({ sessionRef: ref, checkpoints });
    assert.deepEqual(entries.map((entry) => entry.text), ["first", "second"]);

    const recovery = await repo.acquire(ref);
    await recovery.session.appendList(address, {
      checkpointId: "assistant_response_committed#1",
      kind: "assistant_response_committed",
      entryId: positions[1].entryId,
    }, TODO_CONTEXT);
    await recovery.release();
    await assert.rejects(() => repo.moveActiveCheckpoint(ref, checkpoints[1]), (error) =>
      error instanceof AgentSessionRepositoryError && error.code === "agent_session_checkpoint_conflict");
    assert.deepEqual(await repo.activeTranscriptPositions(ref), positions);
  } finally {
    cleanup();
  }
});

test("Agent session repository keeps checkpoint and release callbacks owned by their generation", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "checkpoint-generation", sessionCwd: process.cwd() });
    const first = await repo.acquire(ref);
    await seedBranch(first.session, [userMessage("first")]);
    const entryRef = (await repo.activeTranscriptPositions(ref))[0];
    await first.revokeTo(null);
    const revoked = (error) => error instanceof SessionGenerationError && error.code === "generation_revoked";
    await assert.rejects(() => first.recordCheckpoint("input_committed", entryRef), revoked);
    await first.release();
    // An old callback must neither take a new writer nor use the successor.
    await assert.rejects(() => first.recordCheckpoint("input_committed", entryRef), revoked);
    const second = await repo.acquire(ref);
    await assert.rejects(() => first.recordCheckpoint("input_committed", entryRef), revoked);
    await first.release();
    assert.deepEqual(await repo.activeTranscriptPositions(ref), []);
    await assert.rejects(() => repo.acquire(ref), (error) =>
      error instanceof AgentSessionRepositoryError && error.code === "agent_session_writer_active");
    assert.deepEqual(await second.session.readList(list("synech.checkpoint", "recorded"), undefined, TODO_CONTEXT), []);
    await second.release();
  } finally {
    cleanup();
  }
});

test("Agent session repository waits for checkpoint resolution before same-turn release in either order", { timeout: 5000 }, async () => {
  const { repo, cleanup } = createRepository();
  try {
    for (const releaseFirst of [false, true]) {
      const ref = await repo.create({ sessionId: "revoke-release-" + releaseFirst, sessionCwd: process.cwd() });
      const lease = await repo.acquire(ref);
      const branch = await seedBranch(lease.session, [userMessage("accepted")]);
      const accepted = (await repo.activeTranscriptPositions(ref))[0];
      const checkpoint = await lease.recordCheckpoint("input_committed", accepted);
      await branch.appendMessage(userMessage("unaccepted"), TODO_CONTEXT);
      await Promise.all(releaseFirst
        ? [lease.release(), lease.revokeTo(checkpoint)]
        : [lease.revokeTo(checkpoint), lease.release()]);
      const successor = await repo.acquire(ref);
      assert.deepEqual(await repo.activeTranscriptPositions(ref), [accepted]);
      await successor.release();
    }
  } finally {
    cleanup();
  }
});

test("Agent session repository accepts live precommit assistant and tool-result checkpoints", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "checkpoint-precommit", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [userMessage("go")]);
    let parentId = (await repo.activeTranscriptPositions(ref))[0].entryId;
    for (const [kind, message] of [
      ["assistant_tool_calls_committed", assistantMessage("", [
        { type: "toolCall", id: "call", name: "Tool", arguments: {} },
      ])],
      ["tool_results_committed", {
        role: "toolResult", toolCallId: "call", toolName: "Tool",
        content: [{ type: "text", text: "result" }], isError: false, timestamp: Date.now(),
      }],
      ["assistant_response_committed", assistantMessage("answer")],
    ]) {
      const entryId = lease.session.idGenerator.next();
      const checkpoint = await lease.recordCheckpoint(kind, { sessionId: ref.sessionId, entryId });
      assert.equal(await lease.session.getEntry(entryId, TODO_CONTEXT), undefined);
      await lease.session.mutate((mutator) => mutator.commit([
        insertEntry({ id: entryId, parentId, type: "message", message }),
        setValue(branchTip("main"), entryId),
      ], TODO_CONTEXT), TODO_CONTEXT);
      const located = await repo.locateSessionCheckpoints({ sessionRef: ref, checkpoints: [checkpoint] });
      assert.equal(located.length, 1);
      parentId = entryId;
    }
    await lease.release();
  } finally {
    cleanup();
  }
});

test("Agent session repository rejects dangling durable restore and recovery mappings without changing the tip", { timeout: 5000 }, async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "checkpoint-dangling", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [userMessage("accepted")]);
    const positions = await repo.activeTranscriptPositions(ref);
    const entryRef = { sessionId: ref.sessionId, entryId: "never-committed" };
    const checkpoint = await lease.recordCheckpoint("assistant_response_committed", entryRef);
    const invalid = (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_ref_invalid";
    await assert.rejects(() => repo.recordSessionCheckpoint({ sessionRef: ref, kind: "input_committed", entryRef }), invalid);
    await lease.release();
    await assert.rejects(() => repo.moveActiveCheckpoint(ref, checkpoint), invalid);
    assert.deepEqual(await repo.activeTranscriptPositions(ref), positions);
    await assert.rejects(() => repo.recordSessionCheckpoint({ sessionRef: ref, kind: "input_committed", entryRef }), invalid);
    const recovery = await repo.acquire(ref);
    const revoking = recovery.revokeTo(checkpoint);
    await Promise.all([
      assert.rejects(() => revoking, (error) =>
        error instanceof SessionGenerationError && error.code === "generation_revoke_failed"),
      recovery.release(),
    ]);
    assert.deepEqual(await repo.activeTranscriptPositions(ref), positions);
    await assert.rejects(() => repo.acquire(ref), (error) =>
      error instanceof AgentSessionRepositoryError && error.code === "agent_session_revoke_failed");
  } finally {
    cleanup();
  }
});

test("Agent session repository rejects persisted checkpoint conflicts and malformed records", async () => {
  const { repo, cleanup } = createRepository();
  try {
    for (const malformed of [false, true]) {
      const ref = await repo.create({ sessionId: "checkpoint-invalid-" + malformed, sessionCwd: process.cwd() });
      const lease = await repo.acquire(ref);
      await seedBranch(lease.session, [userMessage("first"), userMessage("second")]);
      const positions = await repo.activeTranscriptPositions(ref);
      const checkpoint = await lease.recordCheckpoint("input_committed", positions[0]);
      await lease.session.appendList(list("synech.checkpoint", "recorded"), malformed ? {
        checkpointId: "input_committed#2", kind: "input_committed", entryId: null,
      } : {
        checkpointId: checkpoint.checkpointId, kind: checkpoint.kind, entryId: positions[1].entryId,
      }, TODO_CONTEXT);
      const conflict = (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_checkpoint_conflict";
      await assert.rejects(() => lease.recordCheckpoint("input_committed", positions[1]), conflict);
      await lease.release();
      await assert.rejects(() => repo.moveActiveCheckpoint(ref, checkpoint), conflict);
      assert.deepEqual(await repo.activeTranscriptPositions(ref), positions);
    }
  } finally {
    cleanup();
  }
});

test("Agent session repository checks header-derived metadata before opening or deleting", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "metadata-persisted", sessionCwd: process.cwd() });
    for (const changed of [
      { ...ref, createdAt: new Date(Date.parse(ref.createdAt) + 60_000).toISOString() },
      { ...ref, storageKey: "other.jsonl" },
    ]) {
      const mismatch = (error) => error instanceof AgentSessionRepositoryError && error.code === "agent_session_metadata_mismatch";
      await assert.rejects(() => repo.acquire(changed), mismatch);
      await assert.rejects(() => repo.activeTranscriptPositions(changed), mismatch);
      await assert.rejects(() => repo.delete(changed), mismatch);
    }
    assert.deepEqual(await repo.activeTranscriptPositions(ref), []);
    const lease = await repo.acquire(ref);
    await lease.release();
  } finally {
    cleanup();
  }
});


test("explicit branch root selection retains Pi entries and old checkpoints remain selectable", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "editable-root", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    const branch = await seedBranch(lease.session, [userMessage("Original"), assistantMessage("Original answer")]);
    const positions = await repo.activeTranscriptPositions(ref);
    const original = await lease.recordCheckpoint("assistant_response_committed", positions.at(-1));
    await lease.release();
    assert.equal(await repo.moveActiveCheckpoint(ref, null), null);
    assert.deepEqual(await repo.activeTranscriptPositions(ref), []);
    const replacementLease = await repo.acquire(ref);
    const replacementBranch = await replacementLease.session.branch("main", TODO_CONTEXT);
    await replacementBranch.appendMessage(userMessage("Edited"), TODO_CONTEXT);
    await replacementBranch.appendMessage(assistantMessage("Edited answer"), TODO_CONTEXT);
    const replacementPositions = await repo.activeTranscriptPositions(ref);
    const replacement = await replacementLease.recordCheckpoint("assistant_response_committed", replacementPositions.at(-1));
    await replacementLease.release();
    await repo.moveActiveCheckpoint(ref, original);
    assert.equal((await repo.readAssistantEntriesByCheckpoint({ sessionRef: ref, checkpoints: [original] }))[0].text, "Original answer");
    await repo.moveActiveCheckpoint(ref, replacement);
    assert.equal((await repo.readAssistantEntriesByCheckpoint({ sessionRef: ref, checkpoints: [replacement] }))[0].text, "Edited answer");
  } finally { cleanup(); }
});


test("bounded idle Session reuse preserves generation fencing, external edits, eviction and release", async () => {
  const { repo, cleanup } = createRepository({ idleSessionCacheSize: 1 });
  let opens = 0;
  const open = repo.jsonlRepository.open.bind(repo.jsonlRepository);
  repo.jsonlRepository.open = async (...args) => { opens += 1; return open(...args); };
  try {
    const ref = await repo.create({ sessionId: "pooled", sessionCwd: process.cwd() });
    const first = await repo.acquire(ref);
    const branch = await seedBranch(first.session, [userMessage("Original"), assistantMessage("Answer")]);
    const position = (await repo.activeTranscriptPositions(ref)).at(-1);
    const checkpoint = await first.recordCheckpoint("assistant_response_committed", position);
    await first.release();
    const baseline = opens;
    assert.equal(repo.idleSessions.size, 1);
    await repo.moveActiveCheckpoint(ref, checkpoint);
    await repo.readAssistantEntriesByCheckpoint({ sessionRef: ref, checkpoints: [checkpoint] });
    assert.equal(opens, baseline);
    await assert.rejects(first.session.setValue(laneState("main"), null, TODO_CONTEXT), SessionGenerationError);
    const next = await repo.acquire(ref);
    await assert.rejects(repo.acquire(ref), (error) => error.code === "agent_session_writer_active");
    await next.revokeTo(checkpoint);
    await next.release();
    await assert.rejects(next.session.setValue(laneState("main"), null, TODO_CONTEXT), SessionGenerationError);
    const other = await repo.create({ sessionId: "pooled-other", sessionCwd: process.cwd() });
    const otherLease = await repo.acquire(other);
    await seedBranch(otherLease.session, [userMessage("Other")]);
    await otherLease.release();
    assert.equal(repo.idleSessions.size, 1);
    await repo.readAssistantEntriesByCheckpoint({ sessionRef: ref, checkpoints: [checkpoint] });
    assert.equal(opens, baseline + 2);
    const { appendFileSync } = await import("node:fs");
    appendFileSync(repo.idleSessions.get(ref.sessionId).session.metadata.path, "not-valid-json\n");
    await assert.rejects(repo.readAssistantEntriesByCheckpoint({ sessionRef: ref, checkpoints: [checkpoint] }), /Invalid JSONL/);
    assert.equal(repo.idleSessions.has(ref.sessionId), false);
    await repo.release();
    assert.equal(repo.idleSessions.size, 0);
  } finally { await repo.release(); cleanup(); }
});

test("deleting an idle pooled Session closes its provider handle before removing storage", async () => {
  const { repo, cleanup } = createRepository({ idleSessionCacheSize: 2 });
  try {
    const ref = await repo.create({ sessionId: "delete-pooled", sessionCwd: process.cwd() });
    const lease = await repo.acquire(ref);
    await seedBranch(lease.session, [userMessage("Delete")]);
    await lease.release();
    assert.equal(repo.idleSessions.size, 1);
    await repo.delete(ref);
    assert.equal(repo.idleSessions.size, 0);
    await assert.rejects(repo.acquire(ref), (error) => error.code === "agent_session_not_found");
  } finally { await repo.release(); cleanup(); }
});
