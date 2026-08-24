import assert from "node:assert/strict";
import test from "node:test";

import { ToolCenter } from "../dist/app/tool-center/tool-center.js";
import { createReadToolOutputTool } from "../dist/app/tool-center/adapters/tool-output-read-tool.js";
import {
  InMemoryToolOutputStore,
  ToolOutputStoreError,
} from "../dist/app/tool-center/tool-output-store.js";

const context = { callerAgentId: "ordinary", traceId: "trace-1", goalId: "goal-1" };

test("short successful output remains inline and unchanged", async () => {
  const store = outputStore();
  const center = toolCenter(store, async () => ({ message: "done" }));
  const result = await center.execute(request(), context, permission());

  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { message: "done" });
});

test("oversized output is retained exactly and its continuation reads every character", async () => {
  const store = outputStore();
  const content = `${"alpha😀beta\n".repeat(40)}tail`;
  const center = toolCenter(store, async () => content);
  const retained = await center.execute(request(), context, permission());

  assert.equal(retained.status, "completed");
  assert.equal(retained.output.contentChars, content.length);
  assert.equal(retained.output.truncated, true);
  assert.equal(retained.output.continuation.nextInput.ref, retained.output.contentRef);

  let nextInput = { ...retained.output.continuation.nextInput, maxChars: 73 };
  let reconstructed = "";
  while (nextInput !== undefined) {
    const page = await center.execute({
      callId: `read-${reconstructed.length}`,
      toolName: "ReadOutput",
      input: nextInput,
    }, context, permission());
    assert.equal(page.status, "completed");
    reconstructed += page.output.content;
    nextInput = page.output.continuation?.nextInput;
  }
  assert.equal(reconstructed, content);
});

test("retention failure returns one explicit failed delivery fact", async () => {
  const store = {
    retain: async () => {
      throw new ToolOutputStoreError(
        "tool_output_capacity_exceeded",
        "retention capacity reached",
        { maxEntries: 1 },
      );
    },
    read: async () => undefined,
    release: async () => false,
    releaseOwner: async () => 0,
    clear: async () => {},
  };
  const center = toolCenter(store, async () => "x".repeat(500));
  const result = await center.execute(request(), context, permission());

  assert.equal(result.status, "failed");
  assert.equal(result.error, "retention capacity reached");
  assert.equal(result.errorFacts.code, "tool_output_capacity_exceeded");
  assert.equal(result.errorFacts.originalStatus, "completed");
  assert.equal(result.output.retentionFailed, true);
  assert.equal(result.output.contentIncomplete, true);
});

test("preflight rejects a tool outside the run permission without executing it", () => {
  let executions = 0;
  const center = toolCenter(outputStore(), async () => {
    executions += 1;
    return "unused";
  });
  const outcome = center.preflight(request(), context, {
    callerAgentId: "ordinary",
    allowedTools: ["ReadOutput"],
  });

  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.result.status, "failed");
  assert.match(outcome.result.error, /未授权/u);
  assert.equal(executions, 0);
});

function toolCenter(store, execute) {
  const center = new ToolCenter({ outputStore: store, maxInlineOutputChars: 120 });
  center.register(createReadToolOutputTool(store));
  center.register({
    definition: {
      name: "Echo",
      description: "Return deterministic test content.",
      inputSchema: { type: "object", properties: {} },
      metadata: {
        category: "other",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
    },
    execute,
  });
  return center;
}

function request() {
  return { callId: "call-echo", toolName: "Echo", input: {} };
}

function permission() {
  return { callerAgentId: "ordinary", allowedTools: ["Echo", "ReadOutput"] };
}

function outputStore() {
  let refSequence = 0;
  return new InMemoryToolOutputStore({
    now: () => Date.parse("2026-08-24T00:00:00.000Z"),
    createRefToken: () => `retained-${++refSequence}`,
  });
}
