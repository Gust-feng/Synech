import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, promises as fs } from "node:fs";
import path from "node:path";

import type { SanitizedCommandShellConfig } from "../../../domain/config/index.js";
import type { ToolExecutionContext, ToolExecutionProgress } from "../../../domain/tools/index.js";
import type {
  LocalPortOccupancyFact,
  ProcessFact,
  ProcessLifetime,
  ProcessPortFact,
  ProcessRecord,
  ProcessRecordUpdate,
  ProcessRegistration,
  ProcessStopResult,
  ProcessTerminator,
} from "../../runtime-guard/index.js";
import {
  createCommandLogTarget,
  releaseCommandLogPath,
  removeCommandLog,
  writeCommandLogChunk,
  writeCommandLogHeader,
  writeCommandLogText,
} from "./command-log.js";
import { asRecord, type AuthorizedLocalWorkspacePath } from "./local-workspace-common.js";

export const MAX_COMMAND_STDOUT_CHARS = 12_000;
export const MAX_COMMAND_STDERR_CHARS = 4_000;
export const COMMAND_CANCELLED_EXIT_CODE = 130;

const COMMAND_TIMEOUT_EXIT_CODE = 124;
const COMMAND_TERMINATION_GRACE_MS = 5_000;
const COMMAND_PROGRESS_TAIL_CHARS = 4_000;
const COMMAND_PROGRESS_INTERVAL_MS = 120;

export type CommandExecutionResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly cwd: string;
  readonly notStarted?: boolean;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly signal?: string;
  readonly background?: boolean;
  readonly processState?: ProcessRecord["status"];
  readonly lifetime?: ProcessLifetime;
  readonly pid?: number;
  readonly logRef?: string;
  readonly logPath?: string;
  readonly stopCommand?: string;
  readonly durationMs?: number;
  readonly waitForPort?: number;
  readonly portReady?: boolean;
  readonly preStartPortOccupancy?: LocalPortOccupancyFact;
  readonly portWaitCancelled?: boolean;
  readonly truncated?: boolean;
  readonly stdoutChars?: number;
  readonly stderrChars?: number;
  readonly stdoutOmittedChars?: number;
  readonly stderrOmittedChars?: number;
};

export type CommandExecutionOutcome = {
  readonly result: CommandExecutionResult;
  readonly processId?: string;
};

export type LocalCommandProcessRegistry = {
  readonly register: (input: ProcessRegistration) => unknown;
  readonly listAll?: () => readonly ProcessRecord[];
  readonly get?: (processId: string) => ProcessRecord | undefined;
  readonly stopOwned?: (processId: string, terminator: ProcessTerminator) => Promise<ProcessStopResult>;
  readonly update?: (processId: string, patch: ProcessRecordUpdate) => unknown;
  readonly markExited?: (
    processId: string,
    input?: { readonly exitCode?: number; readonly signal?: string; readonly exitedAt?: string },
  ) => unknown;
  readonly appendPortFact?: (processId: string, fact: ProcessPortFact) => unknown;
  readonly appendFact?: (processId: string, fact: ProcessFact) => unknown;
};

export type CommandProcessFacts = {
  readonly registry: LocalCommandProcessRegistry;
  readonly runId?: string;
  readonly toolCallId?: string;
  readonly conversationId?: string;
  readonly spaceId?: string;
  readonly referenceId?: string;
  readonly authorizationMode: "confirm_each" | "full_access";
};

export type NormalizedShellCommandInput = {
  readonly command: string;
  readonly commandLine: string;
  readonly directProgram?: string;
  readonly directArgs: readonly string[];
};

type CommandProgressReporter = {
  readonly append: (stream: "stdout" | "stderr", chunk: Buffer | string) => void;
  readonly flush: () => void;
};

export function normalizeShellCommandInput(
  record: Readonly<Record<string, unknown>>,
  shellSyntax: SanitizedCommandShellConfig["syntax"],
): NormalizedShellCommandInput {
  const directCommand = stringField(record.command);
  const directArgs = toStringArray(record.args);
  const commandLine = stringField(record.commandLine);
  if (directCommand !== undefined && directArgs.length > 0) {
    return {
      command: directCommand,
      commandLine: commandLine ?? shellCommandLineFromArgv(directCommand, directArgs, shellSyntax),
      directProgram: directCommand,
      directArgs,
    };
  }
  if (commandLine !== undefined) return { command: commandLine, commandLine, directArgs: [] };
  const command = requireCommand(record.command);
  return {
    command,
    commandLine: directArgs.length === 0 ? command : [command, ...directArgs].join(" "),
    directProgram: directArgs.length === 0 ? undefined : command,
    directArgs,
  };
}

export async function shouldExecuteDirectly(input: {
  readonly command: string;
  readonly rootDirectory: string;
  readonly platform: NodeJS.Platform;
}): Promise<boolean> {
  if (input.platform !== "win32") return true;
  const resolved = await resolveWindowsCommandPath(input.command, input.rootDirectory);
  if (resolved === undefined) return false;
  const extension = path.extname(resolved).toLowerCase();
  return extension !== ".cmd" && extension !== ".bat";
}

export function commandProcessFacts(
  registry: LocalCommandProcessRegistry | undefined,
  context: ToolExecutionContext,
  cwd: AuthorizedLocalWorkspacePath,
): CommandProcessFacts | undefined {
  if (registry === undefined) return undefined;
  const record = asRecord(context);
  return {
    registry,
    runId: stringField(record.runId) ?? stringField(record.traceId),
    toolCallId: stringField(record.toolCallId) ?? stringField(record.callId),
    conversationId: context.conversationId,
    spaceId: context.resourceScope?.ownerKind === "space"
      ? context.resourceScope.ownerId
      : cwd.resourceScope?.ownerKind === "space"
        ? cwd.resourceScope.ownerId
        : undefined,
    referenceId: cwd.resourceId,
    authorizationMode: context.confirmationPolicy === "full_access" ? "full_access" : "confirm_each",
  };
}

export function registerCommandProcess(
  facts: CommandProcessFacts | undefined,
  input: Omit<ProcessRegistration, "processId" | "owned" | "runId" | "toolCallId" | "ports">,
): string | undefined {
  if (facts === undefined) return undefined;
  const processId = `process-${randomUUID()}`;
  facts.registry.register({
    ...input,
    processId,
    runId: facts.runId,
    toolCallId: facts.toolCallId,
    conversationId: facts.conversationId,
    spaceId: facts.spaceId,
    referenceId: facts.referenceId,
    authorizationMode: facts.authorizationMode,
    permissionState: "active",
    owned: true,
  });
  return processId;
}

export function markCommandProcessExited(
  facts: CommandProcessFacts | undefined,
  processId: string | undefined,
  input: { readonly exitCode?: number; readonly signal?: string },
): void {
  if (facts === undefined || processId === undefined) return;
  try {
    if (facts.registry.markExited !== undefined) {
      facts.registry.markExited(processId, {
        exitCode: input.exitCode,
        signal: input.signal,
        exitedAt: new Date().toISOString(),
      });
      return;
    }
    facts.registry.update?.(processId, {
      status: "exited",
      endedAt: new Date().toISOString(),
      exitCode: input.exitCode,
      signal: input.signal,
    });
  } catch {
    // Registry observation does not change command execution facts.
  }
}

export function appendCommandPortFact(
  registry: LocalCommandProcessRegistry | undefined,
  processId: string | undefined,
  fact: ProcessPortFact,
): void {
  if (registry === undefined || processId === undefined) return;
  try {
    if (registry.appendPortFact !== undefined) registry.appendPortFact(processId, fact);
    else registry.update?.(processId, { ports: [fact] });
  } catch {
    // Registry observation does not change command execution facts.
  }
}

export function appendCommandProcessFact(
  facts: CommandProcessFacts | undefined,
  processId: string | undefined,
  fact: ProcessFact,
): void {
  if (facts === undefined || processId === undefined) return;
  try {
    if (facts.registry.appendFact !== undefined) {
      facts.registry.appendFact(processId, fact);
      return;
    }
    const current = facts.registry.get?.(processId);
    if (current !== undefined) facts.registry.update?.(processId, { facts: [...current.facts, fact] });
  } catch {
    // Registry observation does not change command execution facts.
  }
}

export async function runForegroundShellCommand(input: {
  readonly shell: SanitizedCommandShellConfig;
  readonly commandLine: string;
  readonly workingDirectory: string;
  readonly relativeCwd: string;
  readonly timeoutMs: number;
  readonly context: ToolExecutionContext;
  readonly processFacts?: CommandProcessFacts;
}): Promise<CommandExecutionOutcome> {
  return runSpawnedCommand({
    file: input.shell.executable,
    args: shellArgs(input.shell, input.commandLine),
    commandLine: input.commandLine,
    workingDirectory: input.workingDirectory,
    relativeCwd: input.relativeCwd,
    timeoutMs: input.timeoutMs,
    abortSignal: input.context.abortSignal,
    windowsVerbatimArguments: input.shell.syntax === "cmd",
    processFacts: input.processFacts,
    progress: createCommandProgressReporter(input.context),
  });
}

export async function runForegroundProgramCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly commandLine: string;
  readonly workingDirectory: string;
  readonly relativeCwd: string;
  readonly timeoutMs: number;
  readonly context: ToolExecutionContext;
  readonly processFacts?: CommandProcessFacts;
}): Promise<CommandExecutionOutcome> {
  return runSpawnedCommand({
    file: input.command,
    args: input.args,
    commandLine: input.commandLine,
    workingDirectory: input.workingDirectory,
    relativeCwd: input.relativeCwd,
    timeoutMs: input.timeoutMs,
    abortSignal: input.context.abortSignal,
    processFacts: input.processFacts,
    progress: createCommandProgressReporter(input.context),
  });
}

async function runSpawnedCommand(input: {
  readonly file: string;
  readonly args: readonly string[];
  readonly commandLine: string;
  readonly workingDirectory: string;
  readonly relativeCwd: string;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly windowsVerbatimArguments?: boolean;
  readonly processFacts?: CommandProcessFacts;
  readonly progress: CommandProgressReporter;
}): Promise<CommandExecutionOutcome> {
  const logTarget = await createCommandLogTarget(input.commandLine);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    let child: ChildProcess;
    let processId: string | undefined;
    let logFd: number | undefined = openSync(logTarget.path, "a");
    const stdout = createBoundedOutputCollector(MAX_COMMAND_STDOUT_CHARS);
    const stderr = createBoundedOutputCollector(MAX_COMMAND_STDERR_CHARS);
    writeCommandLogHeader(logFd, input.commandLine, input.relativeCwd);
    const appendStdout = (chunk: Buffer) => {
      stdout.append(chunk);
      writeCommandLogChunk(logFd, "stdout", chunk);
      input.progress.append("stdout", chunk);
    };
    const appendStderr = (chunk: Buffer) => {
      stderr.append(chunk);
      writeCommandLogChunk(logFd, "stderr", chunk);
      input.progress.append("stderr", chunk);
    };
    const appendStderrText = (text: string) => {
      stderr.appendText(text);
      writeCommandLogText(logFd, "stderr", text);
      input.progress.append("stderr", text);
    };
    const closeLog = () => {
      if (logFd === undefined) return;
      closeSync(logFd);
      logFd = undefined;
      releaseCommandLogPath(logTarget.path);
    };
    const appendTerminationDiagnostic = () => {
      if (timedOut) appendStderrText(`Command timed out after ${input.timeoutMs}ms and was terminated.`);
      if (cancelled) appendStderrText("Command execution cancelled.");
    };
    const resultFromClose = (code: number | null, signal: NodeJS.Signals | null | undefined): CommandExecutionResult => ({
      stdout: stdout.text(),
      stderr: stderr.text(),
      stdoutChars: stdout.chars(),
      stderrChars: stderr.chars(),
      stdoutOmittedChars: stdout.omittedChars(),
      stderrOmittedChars: stderr.omittedChars(),
      exitCode: timedOut
        ? COMMAND_TIMEOUT_EXIT_CODE
        : cancelled
          ? COMMAND_CANCELLED_EXIT_CODE
          : typeof code === "number"
            ? code
            : signal === undefined || signal === null
              ? 0
              : COMMAND_CANCELLED_EXIT_CODE,
      cwd: input.relativeCwd,
      timedOut,
      cancelled,
      signal: signal ?? undefined,
      truncated: stdout.truncated() || stderr.truncated(),
    });
    const finish = (value: CommandExecutionResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      if (abortHandler !== undefined) input.abortSignal?.removeEventListener("abort", abortHandler);
      closeLog();
      input.progress.flush();
      markCommandProcessExited(input.processFacts, processId, {
        exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
        signal: value.signal,
      });
      if (value.truncated === true) {
        resolve({ result: { ...value, logRef: logTarget.ref, logPath: logTarget.path }, processId });
        return;
      }
      void removeCommandLog(logTarget);
      resolve({ result: value, processId });
    };
    const requestTermination = () => {
      terminateProcessTree(child);
      if (terminationTimer !== undefined) return;
      terminationTimer = setTimeout(() => {
        appendTerminationDiagnostic();
        appendStderrText(
          `Command process did not close within ${COMMAND_TERMINATION_GRACE_MS}ms after termination was requested.`,
        );
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(resultFromClose(null, undefined));
      }, COMMAND_TERMINATION_GRACE_MS);
      terminationTimer.unref?.();
    };
    try {
      child = spawn(input.file, [...input.args], {
        cwd: input.workingDirectory,
        windowsHide: true,
        windowsVerbatimArguments: input.windowsVerbatimArguments === true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      closeLog();
      void removeCommandLog(logTarget);
      reject(error);
      return;
    }
    try {
      processId = registerCommandProcess(input.processFacts, {
        kind: "foreground",
        lifetime: "run",
        pid: child.pid,
        commandLine: input.commandLine,
        cwd: input.workingDirectory,
        startedAt: new Date().toISOString(),
        status: "running",
      });
    } catch (error) {
      child.once("error", () => undefined);
      terminateProcessTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      closeLog();
      void removeCommandLog(logTarget);
      reject(error);
      return;
    }
    if (child.stdout === null || child.stderr === null) {
      closeLog();
      void removeCommandLog(logTarget);
      throw new Error("Command process did not expose stdout/stderr pipes.");
    }
    child.stdout.on("data", appendStdout);
    child.stderr.on("data", appendStderr);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (abortHandler !== undefined) input.abortSignal?.removeEventListener("abort", abortHandler);
      markCommandProcessExited(input.processFacts, processId, {});
      closeLog();
      input.progress.flush();
      void removeCommandLog(logTarget);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      appendTerminationDiagnostic();
      finish(resultFromClose(code, signal));
    });
    timer = setTimeout(() => {
      if (cancelled) return;
      timedOut = true;
      requestTermination();
    }, input.timeoutMs);
    abortHandler = () => {
      cancelled = true;
      requestTermination();
    };
    input.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    if (input.abortSignal?.aborted === true) abortHandler();
  });
}

export function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
    const forceTimer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Process tree already exited.
      }
    }, 1_500);
    forceTimer.unref?.();
  } catch {
    child.kill("SIGTERM");
  }
}

export function shellArgs(shell: SanitizedCommandShellConfig, commandLine: string): readonly string[] {
  if (shell.syntax === "cmd") return ["/d", "/s", "/c", commandLine];
  if (shell.syntax === "powershell") {
    return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", commandLine];
  }
  return ["-lc", commandLine];
}

function createCommandProgressReporter(context: ToolExecutionContext): CommandProgressReporter {
  if (context.reportProgress === undefined) return { append: () => undefined, flush: () => undefined };
  let stdoutTail = "";
  let stderrTail = "";
  let stdoutChars = 0;
  let stderrChars = 0;
  let dirty = false;
  let lastReportedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const snapshot = (): ToolExecutionProgress => ({
    kind: "command_output",
    ...(stdoutTail.length === 0 ? {} : { stdoutTail }),
    ...(stderrTail.length === 0 ? {} : { stderrTail }),
    stdoutChars,
    stderrChars,
  });
  const report = (): void => {
    if (!dirty) return;
    dirty = false;
    lastReportedAt = Date.now();
    try {
      context.reportProgress?.(snapshot());
    } catch {
      // Progress observation does not change command execution facts.
    }
  };
  const schedule = (): void => {
    const remaining = COMMAND_PROGRESS_INTERVAL_MS - (Date.now() - lastReportedAt);
    if (remaining <= 0) {
      report();
      return;
    }
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      report();
    }, remaining);
    timer.unref?.();
  };
  return {
    append(stream, chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (text.length === 0) return;
      if (stream === "stdout") {
        stdoutChars += text.length;
        stdoutTail = boundedTail(stdoutTail, text, COMMAND_PROGRESS_TAIL_CHARS);
      } else {
        stderrChars += text.length;
        stderrTail = boundedTail(stderrTail, text, COMMAND_PROGRESS_TAIL_CHARS);
      }
      dirty = true;
      schedule();
    },
    flush() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      report();
    },
  };
}

function createBoundedOutputCollector(maxChars: number) {
  let value = "";
  let totalChars = 0;
  let isTruncated = false;
  const appendText = (text: string) => {
    if (text.length === 0) return;
    totalChars += text.length;
    const remaining = maxChars - value.length;
    if (remaining <= 0) {
      isTruncated = true;
      return;
    }
    if (text.length > remaining) {
      value += text.slice(0, remaining);
      isTruncated = true;
      return;
    }
    value += text;
  };
  return {
    append: (chunk: Buffer) => appendText(chunk.toString("utf8")),
    appendText,
    text: () => value,
    truncated: () => isTruncated,
    chars: () => totalChars,
    omittedChars: () => Math.max(0, totalChars - value.length),
  };
}

function boundedTail(current: string, incoming: string, maxChars: number): string {
  const combined = `${current}${incoming}`;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

function shellCommandLineFromArgv(
  command: string,
  args: readonly string[],
  shellSyntax: SanitizedCommandShellConfig["syntax"],
): string {
  return [command, ...args].map((value) => quoteShellArg(value, shellSyntax)).join(" ");
}

function quoteShellArg(value: string, shellSyntax: SanitizedCommandShellConfig["syntax"]): string {
  if (shellSyntax === "cmd") return quoteCmdArg(value);
  if (shellSyntax === "powershell") return quotePowerShellArg(value);
  return quotePosixArg(value);
}

function quotePosixArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) && value.length > 0
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellArg(value: string): string {
  return /^[A-Za-z0-9_./:\\@%+=,-]+$/u.test(value) && value.length > 0
    ? value
    : `'${value.replace(/'/g, "''")}'`;
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:\\@+=,-]+$/u.test(value) && value.length > 0) return value;
  const escaped = value
    .replace(/\^/g, "^^")
    .replace(/"/g, '\\"')
    .replace(/[&|<>()]/g, (character) => `^${character}`)
    .replace(/%/g, "^%")
    .replace(/!/g, "^!");
  return `"${escaped}"`;
}

function requireCommand(value: unknown): string {
  const text = stringField(value);
  if (text === undefined) throw new Error("commandLine must be a non-empty string.");
  return text;
}

function stringField(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length === 0 ? undefined : text;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === "string" ? item : String(item ?? "")))
    : [];
}

async function resolveWindowsCommandPath(command: string, rootDirectory: string): Promise<string | undefined> {
  const hasSeparator = /[\\/]/u.test(command);
  const pathExts = windowsExecutableExtensions();
  if (path.isAbsolute(command) || hasSeparator) {
    const base = path.isAbsolute(command) ? command : path.resolve(rootDirectory, command);
    return firstExistingCommandCandidate(base, pathExts);
  }
  const searchPath = process.env.PATH ?? "";
  for (const directory of searchPath.split(path.delimiter).filter((entry) => entry.length > 0)) {
    const resolved = await firstExistingCommandCandidate(path.join(directory, command), pathExts);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

async function firstExistingCommandCandidate(base: string, extensions: readonly string[]): Promise<string | undefined> {
  const candidates = path.extname(base).length > 0
    ? [base]
    : [base, ...extensions.map((extension) => `${base}${extension}`)];
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => undefined);
    if (stat?.isFile() === true) return candidate;
  }
  return undefined;
}

function windowsExecutableExtensions(): readonly string[] {
  const configured = process.env.PATHEXT
    ?.split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return configured !== undefined && configured.length > 0
    ? configured
    : [".com", ".exe", ".bat", ".cmd"];
}
