import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import { runBackgroundProgramCommand } from "../dist/app/tool-center/adapters/background-process.js";
import {
  COMMAND_CANCELLED_EXIT_CODE,
  markCommandProcessStopPending,
  normalizeShellCommandInput,
  runForegroundProgramCommand,
} from "../dist/app/tool-center/adapters/command-execution.js";
import {
  createCommandLogTarget,
  readLocalCommandLogRef,
  releaseCommandLogPath,
  removeCommandLog,
} from "../dist/app/tool-center/adapters/command-log.js";

test("command input normalization keeps direct argv separate from its shell display", () => {
  assert.deepEqual(
    normalizeShellCommandInput({ command: "node", args: ["hello world", "it's"] }, "posix"),
    {
      command: "node",
      commandLine: "node 'hello world' 'it'\\''s'",
      directProgram: "node",
      directArgs: ["hello world", "it's"],
    },
  );
  assert.deepEqual(
    normalizeShellCommandInput({ commandLine: "pnpm test" }, "powershell"),
    { command: "pnpm test", commandLine: "pnpm test", directArgs: [] },
  );
});

test("foreground execution preserves stdout, stderr, progress, and registry exit facts", async () => {
  const registry = recordingRegistry();
  const progress = [];
  const outcome = await runForegroundProgramCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
    commandLine: "node output-test",
    workingDirectory: process.cwd(),
    relativeCwd: ".",
    timeoutMs: 5_000,
    context: { reportProgress: (fact) => progress.push(fact) },
    processFacts: processFacts(registry),
  });

  assert.equal(outcome.result.exitCode, 0);
  assert.equal(outcome.result.stdout, "out");
  assert.equal(outcome.result.stderr, "err");
  assert.equal(registry.registrations[0].kind, "foreground");
  assert.equal(registry.exits[0].exitCode, 0);
  assert.equal(progress.at(-1).stdoutTail, "out");
  assert.equal(progress.at(-1).stderrTail, "err");
});

test("foreground execution preserves UTF-8 characters split across process chunks", async () => {
  const childScript = [
    "const bytes = Buffer.from('中文');",
    "process.stdout.write(bytes.subarray(0, 1));",
    "setTimeout(() => process.stdout.write(bytes.subarray(1)), 25);",
  ].join("");
  const outcome = await runForegroundProgramCommand({
    command: process.execPath,
    args: ["-e", childScript],
    commandLine: "node split-utf8-output",
    workingDirectory: process.cwd(),
    relativeCwd: ".",
    timeoutMs: 5_000,
    context: {},
  });

  assert.equal(outcome.result.exitCode, 0);
  assert.equal(outcome.result.stdout, "中文");
});

test("retained foreground logs preserve UTF-8 characters split across chunks", async () => {
  const childScript = [
    "const bytes = Buffer.from('中文');",
    "process.stdout.write(bytes.subarray(0, 1));",
    "setTimeout(() => { process.stdout.write(bytes.subarray(1)); process.stdout.write('x'.repeat(13000)); }, 25);",
  ].join("");
  const outcome = await runForegroundProgramCommand({
    command: process.execPath,
    args: ["-e", childScript],
    commandLine: "node retained-split-utf8-output",
    workingDirectory: process.cwd(),
    relativeCwd: ".",
    timeoutMs: 5_000,
    context: {},
  });
  try {
    assert.equal(outcome.result.truncated, true);
    const log = await readLocalCommandLogRef(outcome.result.logRef, { maxLength: 30_000 });
    assert.match(log.content, /中文/u);
    assert.doesNotMatch(log.content, /�/u);
  } finally {
    if (outcome.result.logPath !== undefined) await fs.rm(outcome.result.logPath, { force: true });
  }
});

test("foreground cancellation reports the canonical cancellation fact", async () => {
  const controller = new AbortController();
  controller.abort("cancel test");
  const outcome = await runForegroundProgramCommand({
    command: process.execPath,
    args: ["-e", "setInterval(() => undefined, 1000)"],
    commandLine: "node cancellable-test",
    workingDirectory: process.cwd(),
    relativeCwd: ".",
    timeoutMs: 5_000,
    context: { abortSignal: controller.signal },
  });

  assert.equal(outcome.result.exitCode, COMMAND_CANCELLED_EXIT_CODE);
  assert.equal(outcome.result.cancelled, true);
  assert.match(outcome.result.stderr, /cancelled/u);
});

test("an early background exit keeps its process registration and complete command log", async () => {
  const registry = recordingRegistry();
  const outcome = await runBackgroundProgramCommand({
    shell: shellConfig(),
    command: process.execPath,
    args: ["-e", "process.stdout.write('ready')"],
    commandLine: "node background-test",
    workingDirectory: process.cwd(),
    relativeCwd: ".",
    waitMs: 500,
    lifetime: "run",
    maxLogBytes: 1_000_000,
    processFacts: processFacts(registry),
  });
  try {
    assert.equal(outcome.result.processState, "exited");
    assert.equal(outcome.result.exitCode, 0);
    assert.match(outcome.result.stdout, /ready/u);
    assert.equal(registry.registrations[0].status, "exited");
    const log = await readLocalCommandLogRef(outcome.result.logRef, { maxLength: 30_000 });
    assert.match(log.content, /\[stdout\]\nready/u);
  } finally {
    if (outcome.result.logPath !== undefined) await fs.rm(outcome.result.logPath, { force: true });
  }
});

test("command log refs resolve only product-created log identities", async () => {
  const target = await createCommandLogTarget("node log-test");
  try {
    await fs.writeFile(target.path, "complete output", "utf8");
    releaseCommandLogPath(target.path);
    assert.equal((await readLocalCommandLogRef(target.ref, { maxLength: 30_000 })).content, "complete output");
    assert.equal(await readLocalCommandLogRef("command-log://../outside", { maxLength: 30_000 }), undefined);
  } finally {
    await removeCommandLog(target);
  }
});

test("an unconfirmed termination keeps the foreground process eligible for later cleanup", () => {
  const updates = [];
  const registry = {
    register() {},
    update(processId, patch) { updates.push({ processId, patch }); },
  };

  markCommandProcessStopPending(processFacts(registry), "process-1");

  assert.deepEqual(updates, [{
    processId: "process-1",
    patch: { status: "unknown", permissionState: "stop_pending" },
  }]);
});

function processFacts(registry) {
  return { registry, authorizationMode: "confirm_each" };
}

function recordingRegistry() {
  const registrations = [];
  const exits = [];
  return {
    registrations,
    exits,
    register(input) {
      registrations.push(structuredClone(input));
    },
    markExited(processId, input) {
      exits.push({ processId, ...structuredClone(input) });
    },
  };
}

function shellConfig() {
  return {
    kind: "system",
    label: "System shell",
    executable: process.execPath,
    syntax: process.platform === "win32" ? "powershell" : "posix",
    platform: process.platform,
    invocation: [],
    commandLineParameter: "commandLine",
    notes: [],
  };
}
