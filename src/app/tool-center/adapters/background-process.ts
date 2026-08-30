import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import type { SanitizedCommandShellConfig } from "../../../domain/config/index.js";
import type { ProcessFact, ProcessLifetime } from "../../runtime-guard/index.js";
import {
  appendCommandProcessFact,
  COMMAND_CANCELLED_EXIT_CODE,
  markCommandProcessExited,
  MAX_COMMAND_STDOUT_CHARS,
  registerCommandProcess,
  shellArgs,
  terminateProcessTree,
  type CommandExecutionOutcome,
  type CommandProcessFacts,
} from "./command-execution.js";
import {
  commandLogHeader,
  createCommandLogTarget,
  readCommandLogPreview,
  releaseCommandLogPath,
} from "./command-log.js";

const BACKGROUND_LOG_PREVIEW_CHARS = 2_000;

export async function runBackgroundShellCommand(input: {
  readonly shell: SanitizedCommandShellConfig;
  readonly commandLine: string;
  readonly workingDirectory: string;
  readonly relativeCwd: string;
  readonly waitMs: number;
  readonly lifetime: ProcessLifetime;
  readonly maxLogBytes: number;
  readonly commandLogDirectory?: string;
  readonly processFacts?: CommandProcessFacts;
}): Promise<CommandExecutionOutcome> {
  return runBackgroundCommand({
    file: input.shell.executable,
    args: shellArgs(input.shell, input.commandLine),
    commandLine: input.commandLine,
    workingDirectory: input.workingDirectory,
    relativeCwd: input.relativeCwd,
    waitMs: input.waitMs,
    stopShellSyntax: input.shell.syntax,
    platform: input.shell.platform,
    lifetime: input.lifetime,
    maxLogBytes: input.maxLogBytes,
    commandLogDirectory: input.commandLogDirectory,
    windowsVerbatimArguments: input.shell.syntax === "cmd",
    processFacts: input.processFacts,
  });
}

export async function runBackgroundProgramCommand(input: {
  readonly shell: SanitizedCommandShellConfig;
  readonly command: string;
  readonly args: readonly string[];
  readonly commandLine: string;
  readonly workingDirectory: string;
  readonly relativeCwd: string;
  readonly waitMs: number;
  readonly lifetime: ProcessLifetime;
  readonly maxLogBytes: number;
  readonly commandLogDirectory?: string;
  readonly processFacts?: CommandProcessFacts;
}): Promise<CommandExecutionOutcome> {
  return runBackgroundCommand({
    file: input.command,
    args: input.args,
    commandLine: input.commandLine,
    workingDirectory: input.workingDirectory,
    relativeCwd: input.relativeCwd,
    waitMs: input.waitMs,
    stopShellSyntax: input.shell.syntax,
    platform: input.shell.platform,
    lifetime: input.lifetime,
    maxLogBytes: input.maxLogBytes,
    commandLogDirectory: input.commandLogDirectory,
    processFacts: input.processFacts,
  });
}

async function runBackgroundCommand(input: {
  readonly file: string;
  readonly args: readonly string[];
  readonly commandLine: string;
  readonly workingDirectory: string;
  readonly relativeCwd: string;
  readonly waitMs: number;
  readonly stopShellSyntax: SanitizedCommandShellConfig["syntax"];
  readonly platform: NodeJS.Platform;
  readonly lifetime: ProcessLifetime;
  readonly maxLogBytes: number;
  readonly commandLogDirectory?: string;
  readonly windowsVerbatimArguments?: boolean;
  readonly processFacts?: CommandProcessFacts;
}): Promise<CommandExecutionOutcome> {
  const logTarget = await createCommandLogTarget(input.commandLine, {
    directory: input.commandLogDirectory,
  });
  const logPath = logTarget.path;
  const logFd = openSync(logPath, "a");
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let child: ChildProcess | undefined;
  let processId: string | undefined;
  let logClosed = false;
  let logBytes = 0;
  let logLimitExceeded = false;
  let logLimitFactRecorded = false;
  let earlyExit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
  const startedAt = new Date().toISOString();
  const appendLogText = (stream: "stdout" | "stderr", text: string) => {
    if (logClosed || text.length === 0) return;
    const block = `\n[${stream}]\n${text}`;
    writeSync(logFd, block);
    logBytes += Buffer.byteLength(block, "utf8");
    if (!logLimitExceeded && logBytes > input.maxLogBytes) {
      logLimitExceeded = true;
      const diagnostic = `Background process terminated because its command log exceeded ${input.maxLogBytes} bytes.`;
      const diagnosticBlock = `\n[stderr]\n${diagnostic}`;
      writeSync(logFd, diagnosticBlock);
      logBytes += Buffer.byteLength(diagnosticBlock, "utf8");
      recordCommandLogLimitFact();
      if (child !== undefined) terminateProcessTree(child);
    }
  };
  const recordCommandLogLimitFact = () => {
    if (!logLimitExceeded || logLimitFactRecorded || processId === undefined) return;
    logLimitFactRecorded = true;
    appendCommandProcessFact(input.processFacts, processId, commandLogLimitFact(input.maxLogBytes, logBytes));
  };
  const flushAndCloseLog = () => {
    if (logClosed) return;
    appendLogText("stdout", stdoutDecoder.end());
    appendLogText("stderr", stderrDecoder.end());
    logClosed = true;
    closeSync(logFd);
    releaseCommandLogPath(logPath);
  };

  try {
    const header = commandLogHeader(input.commandLine, input.relativeCwd);
    writeSync(logFd, header);
    logBytes = Buffer.byteLength(header, "utf8");
    child = spawn(input.file, [...input.args], {
      cwd: input.workingDirectory,
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: input.windowsVerbatimArguments === true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => appendLogText("stdout", stdoutDecoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => appendLogText("stderr", stderrDecoder.write(chunk)));
    const start = await waitForBackgroundStart(child, input.waitMs);
    if (start.status === "exited") earlyExit = { code: start.code, signal: start.signal };
  } catch (error) {
    flushAndCloseLog();
    throw error;
  }
  if (child === undefined) {
    flushAndCloseLog();
    throw new Error("Failed to start background command.");
  }
  const pid = child.pid;
  if (earlyExit !== undefined) {
    await waitForBackgroundOutputDrain(child);
    flushAndCloseLog();
    processId = registerCommandProcess(input.processFacts, {
      kind: "background",
      lifetime: input.lifetime,
      pid,
      commandLine: input.commandLine,
      cwd: input.workingDirectory,
      startedAt,
      status: "exited",
      exitCode: typeof earlyExit.code === "number" ? earlyExit.code : COMMAND_CANCELLED_EXIT_CODE,
      signal: earlyExit.signal ?? undefined,
      logRef: logTarget.ref,
      logPath,
      facts: logLimitExceeded ? [commandLogLimitFact(input.maxLogBytes, logBytes)] : [],
    });
    const logPreview = await readCommandLogPreview(logPath, MAX_COMMAND_STDOUT_CHARS);
    const stderr = logLimitExceeded
      ? `Background command exceeded its ${input.maxLogBytes} byte log limit during startup and was terminated.`
      : `Background command exited before it stayed running${earlyExit.signal == null ? "" : ` with signal ${earlyExit.signal}`}.`;
    return {
      processId,
      result: {
        stdout: logPreview.text,
        stderr,
        exitCode: typeof earlyExit.code === "number" ? earlyExit.code : COMMAND_CANCELLED_EXIT_CODE,
        background: true,
        processState: "exited",
        lifetime: input.lifetime,
        cwd: input.relativeCwd,
        signal: earlyExit.signal ?? undefined,
        logRef: logTarget.ref,
        logPath,
        stdoutChars: logPreview.chars,
        stderrChars: stderr.length,
        stdoutOmittedChars: logPreview.omittedChars,
        stderrOmittedChars: 0,
        truncated: logPreview.truncated,
      },
    };
  }
  const stopCommand = pid === undefined ? undefined : stopCommandForPid(pid, input.platform, input.stopShellSyntax);
  try {
    processId = registerCommandProcess(input.processFacts, {
      kind: "background",
      lifetime: input.lifetime,
      pid,
      commandLine: input.commandLine,
      cwd: input.workingDirectory,
      startedAt,
      status: "running",
      logRef: logTarget.ref,
      logPath,
      stopCommand,
    });
  } catch (error) {
    child.once("error", () => undefined);
    terminateProcessTree(child);
    flushAndCloseLog();
    throw error;
  }
  recordCommandLogLimitFact();
  child.unref();
  unrefChildOutput(child);
  observeBackgroundExit(child, input.processFacts, processId, logPath, async () => {
    await waitForBackgroundOutputDrain(child);
    flushAndCloseLog();
  });
  const initialLogPreview = await readCommandLogPreview(logPath, BACKGROUND_LOG_PREVIEW_CHARS);
  const stdout = [
    `Started background process${pid === undefined ? "" : ` pid ${pid}`}.`,
    `Log: ${logTarget.ref}`,
    stopCommand === undefined ? undefined : `Stop: ${stopCommand}`,
    initialLogPreview.text.trim().length === 0 ? undefined : `Initial output:\n${initialLogPreview.text}`,
  ].filter((line): line is string => line !== undefined).join("\n");
  return {
    processId,
    result: {
      stdout,
      stderr: "",
      exitCode: null,
      cwd: input.relativeCwd,
      background: true,
      processState: "running",
      lifetime: input.lifetime,
      pid,
      logRef: logTarget.ref,
      logPath,
      stopCommand,
      stdoutChars: stdout.length + initialLogPreview.omittedChars,
      stderrChars: 0,
      stdoutOmittedChars: initialLogPreview.omittedChars,
      stderrOmittedChars: 0,
      truncated: initialLogPreview.truncated,
    },
  };
}

function commandLogLimitFact(limitBytes: number, observedBytes: number): ProcessFact {
  return {
    kind: "command_log_limit",
    observedAt: new Date().toISOString(),
    limitBytes,
    observedBytes,
    action: "terminate_process",
  };
}

async function waitForBackgroundOutputDrain(child: ChildProcess): Promise<void> {
  await Promise.all([waitForReadableEnd(child.stdout), waitForReadableEnd(child.stderr)]);
}

function waitForReadableEnd(stream: import("node:stream").Readable | null): Promise<void> {
  if (stream === null || stream.readableEnded === true || stream.destroyed === true) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      stream.removeListener("end", finish);
      stream.removeListener("close", finish);
      resolve();
    };
    stream.once("end", finish);
    stream.once("close", finish);
  });
}

function unrefChildOutput(child: ChildProcess): void {
  (child.stdout as (import("node:stream").Readable & { unref?: () => void }) | null)?.unref?.();
  (child.stderr as (import("node:stream").Readable & { unref?: () => void }) | null)?.unref?.();
}

function waitForBackgroundStart(child: ChildProcess, waitMs: number): Promise<
  | { readonly status: "running" }
  | { readonly status: "exited"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const settle = (result: { readonly status: "running" } | {
      readonly status: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      resolve(result);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle({ status: "exited", code, signal });
    timer = setTimeout(() => settle({ status: "running" }), waitMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function observeBackgroundExit(
  child: ChildProcess,
  processFacts: CommandProcessFacts | undefined,
  processId: string | undefined,
  logPath: string,
  finalizeLog: () => Promise<void>,
): void {
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    void finalizeLog()
      .catch(() => undefined)
      .finally(() => {
        releaseCommandLogPath(logPath);
        markCommandProcessExited(processFacts, processId, {
          exitCode: typeof code === "number" ? code : undefined,
          signal: signal ?? undefined,
        });
      });
  };
  child.once("exit", onExit);
  if (child.exitCode !== null || child.signalCode !== null) {
    child.off("exit", onExit);
    onExit(child.exitCode, child.signalCode);
  }
}

function stopCommandForPid(
  pid: number,
  platform: NodeJS.Platform,
  shellSyntax: SanitizedCommandShellConfig["syntax"],
): string {
  if (platform === "win32") {
    return shellSyntax === "posix"
      ? `taskkill.exe //pid ${pid} //T //F`
      : `taskkill /pid ${pid} /T /F`;
  }
  return `kill -TERM -${pid} || kill -TERM ${pid}`;
}
