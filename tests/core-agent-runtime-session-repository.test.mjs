import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";

import {
  FileSystemAgentSessionRepository,
} from "../dist/adapters/intelligence/file-system-agent-session-repository.js";
import { AgentSessionRepositoryError } from "../dist/app/model-runtime/agent-session.js";
import { createAgentRuntimeEnvironment } from "../dist/adapters/intelligence/pi-agent/runtime-environment.js";

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "synech-agent-session-"));
  const sessionsRoot = path.join(root, "sessions");
  const repo = new FileSystemAgentSessionRepository({
    executionEnvironment: createAgentRuntimeEnvironment(root),
    sessionsRoot,
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

test("Agent session repository deletes a session and forgets it", async () => {
  const { repo, cleanup } = createRepository();
  try {
    const ref = await repo.create({ sessionId: "delete-me", sessionCwd: process.cwd() });
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
