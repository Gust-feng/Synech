import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { InMemoryProcessRegistry } from "../dist/app/runtime-guard/process-registry.js";
import { ToolCenter } from "../dist/app/tool-center/tool-center.js";
import { runBackgroundProgramCommand } from "../dist/app/tool-center/adapters/background-process.js";
import { createHttpRequestTool } from "../dist/app/tool-center/adapters/http-request-tool.js";

test("background startup cancellation registers and settles the owned process", { timeout: 2_000 }, async (t) => {
  const fixture = await backgroundFixture(t, { confirmTermination: true });
  const pending = fixture.start();
  const rejection = assert.rejects(pending, { name: "AbortError" });
  const starting = await fixture.registered;
  assert.equal(starting.status, "starting");
  fixture.controller.abort();
  await rejection;
  assert.equal(fixture.terminationRequests(), 1);
  assert.equal(fixture.registry.get(starting.processId).status, "exited");
});

test("cancellation interrupts startup drain without declaring descendants stopped", { timeout: 2_000 }, async (t) => {
  const fixture = await backgroundFixture(t);
  const pending = fixture.start();
  const rejection = assert.rejects(pending, { name: "AbortError" });
  const starting = await fixture.registered;
  fixture.exitParent(0);
  await nextTurn();
  fixture.controller.abort();
  await rejection;
  const record = fixture.registry.get(starting.processId);
  assert.equal(record.status, "unknown");
  assert.equal(record.permissionState, "stop_pending");
  assert.equal(fixture.child.stdout.destroyed, true);
  assert.equal(fixture.child.stderr.destroyed, true);
  assert.equal(fixture.terminationRequests(), 1);
});

test("inherited background pipes cannot hold startup indefinitely", { timeout: 8_000 }, async (t) => {
  const fixture = await backgroundFixture(t);
  const pending = fixture.start();
  const starting = await fixture.registered;
  fixture.exitParent(0);
  const outcome = await pending;
  assert.equal(outcome.result.processState, "unknown");
  assert.equal(fixture.registry.get(starting.processId).permissionState, "stop_pending");
  assert.match(outcome.result.stderr, /cleanup remains unconfirmed/u);
  assert.equal(fixture.terminationRequests(), 1);
});

test("a running background process becomes exited after output drains", { timeout: 2_000 }, async (t) => {
  const fixture = await backgroundFixture(t);
  const outcome = await fixture.start({ waitMs: 1 });
  assert.equal(outcome.result.processState, "running");
  assert.equal(fixture.registry.get(outcome.processId).status, "running");
  fixture.exitParent(0);
  fixture.child.stdout.end();
  fixture.child.stderr.end();
  await nextTurn();
  assert.equal(fixture.registry.get(outcome.processId).status, "exited");
});

test("HTTP cancellation during request or response body remains cancelled", async (t) => {
  for (const phase of ["request", "body"]) {
    await t.test(phase, async () => {
      const controller = new AbortController();
      const entered = Promise.withResolvers();
      const tool = createHttpRequestTool({
        fetch: async (_url, init) => {
          if (phase === "request") {
            return new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
              entered.resolve();
            });
          }
          return {
            status: 200,
            body: new ReadableStream({
              start(stream) {
                init.signal.addEventListener("abort", () => stream.error(init.signal.reason), { once: true });
                entered.resolve();
              },
            }),
          };
        },
      });
      const center = new ToolCenter();
      center.register(tool);
      const pending = center.execute(
        request("HttpRequest", { url: "https://example.invalid" }),
        { ...context, abortSignal: controller.signal },
        permission("HttpRequest"),
      );
      await entered.promise;
      controller.abort();
      const result = await pending;
      assert.equal(result.status, "cancelled");
      assert.equal(result.errorFacts.abortRequested, true);
      assert.equal(result.errorFacts.doNotBlindlyRetry, true);
    });
  }
});

test("HTTP POST requires approval without interpreting an MCP URI as HTTP", async () => {
  const center = new ToolCenter();
  let executions = 0;
  center.register(createHttpRequestTool({ fetch: async () => { executions += 1; return { status: 200 }; } }));
  const post = await center.execute(
    request("HttpRequest", { url: "https://example.invalid", method: "POST", body: "change" }),
    context,
    permission("HttpRequest"),
  );
  assert.equal(post.status, "approval_required");
  assert.equal(executions, 0);

  center.register({
    definition: {
      name: "mcp__local__read",
      description: "Read a resource URI.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      metadata: { category: "mcp", riskLevel: "low", operationType: "read-only", requiresConfirmation: false },
    },
    execute: async (input) => { executions += 1; return { resource: input.url }; },
  });
  const uri = "file:///Z:/project/readme.md";
  const result = await center.execute(request("mcp__local__read", { url: uri }), context, permission("mcp__local__read"));
  assert.equal(result.status, "completed");
  assert.equal(result.output.resource, uri);
  assert.equal(executions, 1);
});

const context = { callerAgentId: "agent", traceId: "run", goalId: "goal" };
const permission = (toolName) => ({ callerAgentId: context.callerAgentId, allowedTools: [toolName] });
const request = (toolName, input) => ({ providerCallId: "provider-call", invocationId: "invocation", toolName, input });
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function backgroundFixture(t, { confirmTermination = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-core-background-lifecycle-"));
  const controller = new AbortController();
  const registered = Promise.withResolvers();
  const registry = new InMemoryProcessRegistry();
  const register = registry.register.bind(registry);
  registry.register = (input) => {
    const record = register(input);
    registered.resolve(record);
    return record;
  };
  const child = new EventEmitter();
  Object.assign(child, {
    // No OS pid: production termination reaches the fake child's kill method.
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref() {},
  });
  const exitParent = (code) => {
    child.exitCode = code;
    child.emit("exit", code, null);
  };
  let terminationRequests = 0;
  child.kill = () => {
    terminationRequests += 1;
    if (confirmTermination) queueMicrotask(() => {
      exitParent(130);
      child.stdout.end();
      child.stderr.end();
    });
    return true;
  };
  const spawnMock = t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  t.after(async () => {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
    child.stdout.destroy();
    child.stderr.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return {
    child,
    controller,
    registered: registered.promise,
    registry,
    exitParent,
    terminationRequests: () => terminationRequests,
    start: (options = {}) => runBackgroundProgramCommand({
      shell: { executable: "unused", syntax: "posix", platform: process.platform },
      command: "fake-program",
      args: [],
      commandLine: "fake-program",
      workingDirectory: directory,
      relativeCwd: ".",
      waitMs: 5_000,
      lifetime: "run",
      maxLogBytes: 1_000_000,
      commandLogDirectory: directory,
      processFacts: { registry, runId: "run", authorizationMode: "confirm_each" },
      abortSignal: controller.signal,
      ...options,
    }),
  };
}
