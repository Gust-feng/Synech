import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import type { SanitizedCommandShellConfig } from "../../../domain/config/index.js";
import type { ProcessFact, ProcessLifetime } from "../../runtime-guard/index.js";
import {
  appendCommandProcessFact,
  COMMAND_CANCELLED_EXIT_CODE,
  markCommandProcessExited,
  markCommandProcessStopPending,
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
import { throwIfAborted } from "./local-workspace-common.js";

const BACKGROUND_LOG_PREVIEW_CHARS = 2_000;
const BACKGROUND_OUTPUT_DRAIN_TIMEOUT_MS = 5_000;

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
  readonly abortSignal?: AbortSignal;
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
    abortSignal: input.abortSignal,
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
  readonly abortSignal?: AbortSignal;
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
    abortSignal: input.abortSignal,
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
  readonly abortSignal?: AbortSignal;
}): Promise<CommandExecutionOutcome> {
  throwIfAborted(input.abortSignal);
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
    throwIfAborted(input.abortSignal);
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
    processId = registerCommandProcess(input.processFacts, {
      kind: "background",
      lifetime: input.lifetime,
      pid: child.pid,
      commandLine: input.commandLine,
      cwd: input.workingDirectory,
      startedAt,
      status: "starting",
      logRef: logTarget.ref,
      logPath,
      stopCommand: child.pid === undefined ? undefined : stopCommandForPid(child.pid, input.platform, input.stopShellSyntax),
    });
    const start = await waitForBackgroundStart(child, input.waitMs, input.abortSignal);
    if (start.status === "exited") earlyExit = { code: start.code, signal: start.signal };
  } catch (error) {
    if (child !== undefined) {
      child.once("error", () => undefined);
      terminateProcessTree(child);
      markCommandProcessStopPending(input.processFacts, processId);
      const drained = await waitForBackgroundOutputDrain(child);
      if (drained && (child.exitCode !== null || child.signalCode !== null || child.pid === undefined)) {
        markCommandProcessExited(input.processFacts, processId, {
          exitCode: child.exitCode ?? undefined,
          signal: child.signalCode ?? undefined,
        });
      }
      child.unref();
      unrefChildOutput(child);
    }
    flushAndCloseLog();
    throw error;
  }
  if (child === undefined) {
    flushAndCloseLog();
    throw new Error("Failed to start background command.");
  }
  const pid = child.pid;
  if (earlyExit !== undefined) {
    const drained = await waitForBackgroundOutputDrain(child, input.abortSignal);
    if (drained) {
      markCommandProcessExited(input.processFacts, processId, {
        exitCode: earlyExit.code ?? undefined,
        signal: earlyExit.signal ?? undefined,
      });
    } else {
      // Parent exit alone does not confirm termination of descendants holding the pipes.
      markCommandProcessStopPending(input.processFacts, processId);
      terminateProcessTree(child);
      appendLogText("stderr", "Background command output did not close; process cleanup remains unconfirmed.");
    }
    flushAndCloseLog();
    recordCommandLogLimitFact();
    throwIfAborted(input.abortSignal);
    const logPreview = await readCommandLogPreview(logPath, MAX_COMMAND_STDOUT_CHARS);
    const stderr = !drained
      ? "Background command parent exited, but process cleanup remains unconfirmed because its output pipes stayed open."
      : logLimitExceeded
        ? `Background command exceeded its ${input.maxLogBytes} byte log limit during startup and was terminated.`
        : `Background command exited before it stayed running${earlyExit.signal == null ? "" : ` with signal ${earlyExit.signal}`}.`;
    return {
      processId,
      result: {
        stdout: logPreview.text,
        stderr,
        exitCode: typeof earlyExit.code === "number" ? earlyExit.code : COMMAND_CANCELLED_EXIT_CODE,
        background: true,
        processState: drained ? "exited" : "unknown",
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
    if (processId !== undefined) input.processFacts?.registry.update?.(processId, { status: "running" });
  } catch (error) {
    child.once("error", () => undefined);
    terminateProcessTree(child);
    markCommandProcessStopPending(input.processFacts, processId);
    await waitForBackgroundOutputDrain(child, input.abortSignal);
    flushAndCloseLog();
    throw error;
  }
  recordCommandLogLimitFact();
  child.unref();
  unrefChildOutput(child);
  observeBackgroundExit(child, input.processFacts, processId, logPath, async () => {
    const drained = await waitForBackgroundOutputDrain(child);
    if (!drained) {
      terminateProcessTree(child);
      appendLogText("stderr", "Background command output did not close; process cleanup remains unconfirmed.");
    }
    flushAndCloseLog();
    return drained;
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

function waitForBackgroundOutputDrain(child: ChildProcess, signal?: AbortSignal): Promise<boolean> {
  const streams = [child.stdout, child.stderr].filter((stream): stream is import("node:stream").Readable =>
    stream !== null && !stream.readableEnded && !stream.destroyed,
  );
  if (streams.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const pending = new Set(streams);
    const settle = (drained: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const [stream, onEnd] of listeners) {
        stream.off("end", onEnd);
        stream.off("close", onEnd);
        if (!drained) stream.destroy();
      }
      resolve(drained);
    };
    const onAbort = () => settle(false);
    const listeners = streams.map((stream) => {
      const onEnd = () => {
        pending.delete(stream);
        if (pending.size === 0) settle(true);
      };
      stream.once("end", onEnd);
      stream.once("close", onEnd);
      return [stream, onEnd] as const;
    });
    timer = setTimeout(() => settle(false), BACKGROUND_OUTPUT_DRAIN_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function unrefChildOutput(child: ChildProcess): void {
  (child.stdout as (import("node:stream").Readable & { unref?: () => void }) | null)?.unref?.();
  (child.stderr as (import("node:stream").Readable & { unref?: () => void }) | null)?.unref?.();
}

function waitForBackgroundStart(child: ChildProcess, waitMs: number, signal?: AbortSignal): Promise<
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
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle({ status: "exited", code, signal });
    const onAbort = () => {
      const error = new Error("Background command startup was cancelled.");
      error.name = "AbortError";
      onError(error);
    };
    timer = setTimeout(() => settle({ status: "running" }), waitMs);
    child.once("error", onError);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function observeBackgroundExit(
  child: ChildProcess,
  processFacts: CommandProcessFacts | undefined,
  processId: string | undefined,
  logPath: string,
  finalizeLog: () => Promise<boolean>,
): void {
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    void finalizeLog()
      .catch(() => false)
      .then((drained) => {
        releaseCommandLogPath(logPath);
        if (!drained) {
          markCommandProcessStopPending(processFacts, processId);
          return;
        }
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
