import { execFile } from "node:child_process";
import type { PortOccupantProbe, PortOccupantProbeInput, PortOccupantProbeResult } from "./port-probe.js";
import type { ProcessKillTreeResult, ProcessTerminator } from "./process-registry.js";

export type RuntimeGuardCommandRequest = {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
};

export type RuntimeGuardCommandResult = {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

export type RuntimeGuardCommandRunner = (
  request: RuntimeGuardCommandRequest
) => Promise<RuntimeGuardCommandResult> | RuntimeGuardCommandResult;

export type RuntimeGuardSignal = NodeJS.Signals | 0;

export type RuntimeGuardSignalSender = (pid: number, signal: RuntimeGuardSignal) => void;

export type KillProcessTreeOptions = {
  readonly platform?: NodeJS.Platform;
  readonly commandRunner?: RuntimeGuardCommandRunner;
  readonly signalSender?: RuntimeGuardSignalSender;
  readonly timeoutMs?: number;
};

export type PlatformPortOccupantProbeOptions = {
  readonly platform?: NodeJS.Platform;
  readonly commandRunner?: RuntimeGuardCommandRunner;
  readonly timeoutMs?: number;
};

const DEFAULT_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_PORT_PROBE_TIMEOUT_MS = 2_000;

export function createPlatformProcessTerminator(options: KillProcessTreeOptions = {}): ProcessTerminator {
  return {
    killTree(pid) {
      return killProcessTree(pid, options);
    },
  };
}

export async function killProcessTree(pid: number, options: KillProcessTreeOptions = {}): Promise<ProcessKillTreeResult> {
  if (!isPositivePid(pid)) {
    return {
      status: "failed",
      errorMessage: "Process pid must be a positive integer.",
    };
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return killWindowsProcessTree(pid, options);
  }

  return killPosixProcessTree(pid, options.signalSender ?? defaultSignalSender, normalizePositiveInteger(options.timeoutMs, DEFAULT_KILL_TIMEOUT_MS));
}

export function createPlatformPortOccupantProbe(options: PlatformPortOccupantProbeOptions = {}): PortOccupantProbe {
  return (input) => probePlatformPortOccupant(input, options);
}

export async function probePlatformPortOccupant(
  input: PortOccupantProbeInput,
  options: PlatformPortOccupantProbeOptions = {}
): Promise<PortOccupantProbeResult | undefined> {
  if (!isTcpPort(input.port) || input.abortSignal?.aborted === true) {
    return undefined;
  }

  const platform = options.platform ?? process.platform;
  const runner = options.commandRunner ?? runRuntimeGuardCommand;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_PORT_PROBE_TIMEOUT_MS);

  if (platform === "win32") {
    return probeWindowsNetstat(input, runner, timeoutMs);
  }

  if (platform === "linux") {
    const ssResult = await probePosixSs(input, runner, timeoutMs);
    if (ssResult !== undefined) {
      return ssResult;
    }
  }

  return probePosixLsof(input, runner, timeoutMs);
}

export function runRuntimeGuardCommand(request: RuntimeGuardCommandRequest): Promise<RuntimeGuardCommandResult> {
  return new Promise((resolve) => {
    execFile(
      request.file,
      [...request.args],
      {
        encoding: "utf8",
        maxBuffer: 512_000,
        signal: request.abortSignal,
        timeout: request.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const execError = error as NodeExecError | null;
        resolve({
          exitCode: execError === null ? 0 : typeof execError.code === "number" ? execError.code : null,
          signal: typeof execError?.signal === "string" ? execError.signal : undefined,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          errorCode: typeof execError?.code === "string" ? execError.code : undefined,
          errorMessage: execError?.message,
        });
      }
    );
  });
}

async function killWindowsProcessTree(pid: number, options: KillProcessTreeOptions): Promise<ProcessKillTreeResult> {
  const runner = options.commandRunner ?? runRuntimeGuardCommand;
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, DEFAULT_KILL_TIMEOUT_MS);
  const startedAt = Date.now();
  let result: RuntimeGuardCommandResult;
  try {
    result = await runner({
      file: "taskkill",
      args: ["/PID", String(pid), "/T", "/F"],
      timeoutMs,
    });
  } catch (error) {
    return {
      status: "failed",
      errorMessage: errorMessage(error),
    };
  }

  if (result.exitCode === 0) {
    const message = compactCommandText(result) || `taskkill completed for pid ${pid}.`;
    const exitState = await waitForProcessExit(
      pid,
      options.signalSender ?? defaultSignalSender,
      Math.max(0, timeoutMs - (Date.now() - startedAt))
    );
    if (exitState === "gone") {
      return {
        status: "killed",
        message,
      };
    }

    return {
      status: "unknown",
      message: `${message} Process exit could not be confirmed.`,
    };
  }

  const commandText = compactCommandText(result);
  if (isProcessMissingText(commandText)) {
    return {
      status: "exited",
      message: commandText || `Process ${pid} was not running.`,
    };
  }

  if (isCommandUnavailable(result)) {
    return {
      status: "failed",
      errorMessage: result.errorMessage ?? "taskkill command is unavailable.",
    };
  }

  if (result.exitCode === null) {
    return {
      status: "unknown",
      signal: result.signal,
      message: commandText || result.errorMessage || "taskkill ended without an exit code.",
    };
  }

  return {
    status: "failed",
    errorMessage: commandText || result.errorMessage || `taskkill exited with code ${result.exitCode}.`,
  };
}

async function killPosixProcessTree(
  pid: number,
  signalSender: RuntimeGuardSignalSender,
  timeoutMs: number
): Promise<ProcessKillTreeResult> {
  const groupResult = sendSignal(signalSender, -pid, "SIGTERM");
  if (groupResult.status === "sent") {
    const gone = await waitForProcessExit(pid, signalSender, timeoutMs);
    if (gone === "gone") {
      return {
        status: "killed",
        signal: "SIGTERM",
        message: `Sent SIGTERM to process group ${pid} and confirmed pid ${pid} exited.`,
      };
    }

    return {
      status: "unknown",
      signal: "SIGTERM",
      message: `Sent SIGTERM to process group ${pid}; process exit could not be confirmed.`,
    };
  }

  if (errorCode(groupResult.error) !== "ESRCH") {
    return {
      status: "failed",
      errorMessage: signalErrorMessage(groupResult.error),
    };
  }

  const pidProbe = sendSignal(signalSender, pid, 0);
  if (pidProbe.status !== "sent") {
    if (errorCode(pidProbe.error) === "ESRCH") {
      return {
        status: "exited",
        message: `Process ${pid} was not running.`,
      };
    }

    return {
      status: "failed",
      errorMessage: signalErrorMessage(pidProbe.error),
    };
  }

  const processResult = sendSignal(signalSender, pid, "SIGTERM");
  if (processResult.status === "sent") {
    const gone = await waitForProcessExit(pid, signalSender, timeoutMs);
    if (gone === "gone") {
      return {
        status: "killed",
        signal: "SIGTERM",
        message: `Sent SIGTERM to process ${pid} and confirmed it exited.`,
      };
    }

    return {
      status: "unknown",
      signal: "SIGTERM",
      message: `Sent SIGTERM to process ${pid}; process exit could not be confirmed.`,
    };
  }

  if (errorCode(processResult.error) === "ESRCH") {
    return {
      status: "exited",
      message: `Process ${pid} was not running.`,
    };
  }

  return {
    status: "failed",
    errorMessage: signalErrorMessage(processResult.error),
  };
}

async function waitForProcessExit(
  pid: number,
  signalSender: RuntimeGuardSignalSender,
  timeoutMs: number
): Promise<"gone" | "unknown"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = sendSignal(signalSender, pid, 0);
    if (probe.status !== "sent") {
      return errorCode(probe.error) === "ESRCH" ? "gone" : "unknown";
    }

    if (Date.now() >= deadline) {
      return "unknown";
    }

    await delay(Math.min(25, Math.max(0, deadline - Date.now())));
  }
}

async function probeWindowsNetstat(
  input: PortOccupantProbeInput,
  runner: RuntimeGuardCommandRunner,
  timeoutMs: number
): Promise<PortOccupantProbeResult | undefined> {
  const result = await runProbeCommand(runner, {
    file: "netstat",
    args: ["-ano", "-p", "tcp"],
    timeoutMs,
    abortSignal: input.abortSignal,
  });
  if (result === undefined || isCommandUnavailable(result)) {
    return undefined;
  }
  return parseNetstatOutput(result.stdout, input.port);
}

async function probePosixSs(
  input: PortOccupantProbeInput,
  runner: RuntimeGuardCommandRunner,
  timeoutMs: number
): Promise<PortOccupantProbeResult | undefined> {
  const result = await runProbeCommand(runner, {
    file: "ss",
    args: ["-H", "-ltnp", `sport = :${input.port}`],
    timeoutMs,
    abortSignal: input.abortSignal,
  });
  if (result === undefined || isCommandUnavailable(result)) {
    return undefined;
  }
  return parseSsOutput(result.stdout, input.port);
}

async function probePosixLsof(
  input: PortOccupantProbeInput,
  runner: RuntimeGuardCommandRunner,
  timeoutMs: number
): Promise<PortOccupantProbeResult | undefined> {
  const result = await runProbeCommand(runner, {
    file: "lsof",
    args: ["-nP", `-iTCP:${input.port}`, "-sTCP:LISTEN", "-Fp"],
    timeoutMs,
    abortSignal: input.abortSignal,
  });
  if (result === undefined || isCommandUnavailable(result)) {
    return undefined;
  }
  return parseLsofOutput(result.stdout, input.port);
}

async function runProbeCommand(
  runner: RuntimeGuardCommandRunner,
  request: RuntimeGuardCommandRequest
): Promise<RuntimeGuardCommandResult | undefined> {
  try {
    return await runner(request);
  } catch {
    return undefined;
  }
}

function parseNetstatOutput(stdout: string, port: number): PortOccupantProbeResult | undefined {
  for (const line of stdout.split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens.length < 5 || tokens[0]?.toUpperCase() !== "TCP") {
      continue;
    }

    const localAddress = tokens[1] ?? "";
    const state = tokens[tokens.length - 2]?.toUpperCase();
    const pid = parsePositiveInteger(tokens[tokens.length - 1]);
    if (state === "LISTENING" && pid !== undefined && addressHasPort(localAddress, port)) {
      return {
        pid,
        observedBy: "netstat",
      };
    }
  }

  return undefined;
}

function parseSsOutput(stdout: string, port: number): PortOccupantProbeResult | undefined {
  for (const line of stdout.split(/\r?\n/u)) {
    if (!lineHasPort(line, port)) {
      continue;
    }

    const pid = parsePositiveInteger(/pid=(\d+)/u.exec(line)?.[1]);
    return pid === undefined
      ? {
          observedBy: "ss",
        }
      : {
          pid,
          observedBy: "ss",
        };
  }

  return undefined;
}

function parseLsofOutput(stdout: string, port: number): PortOccupantProbeResult | undefined {
  for (const line of stdout.split(/\r?\n/u)) {
    const pid = parsePositiveInteger(/^p(\d+)$/u.exec(line.trim())?.[1]);
    if (pid !== undefined) {
      return {
        pid,
        observedBy: "lsof",
      };
    }
  }

  for (const line of stdout.split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    const pid = parsePositiveInteger(tokens[1]);
    if (pid !== undefined && lineHasPort(line, port)) {
      return {
        pid,
        observedBy: "lsof",
      };
    }
  }

  return undefined;
}

function defaultSignalSender(pid: number, signal: RuntimeGuardSignal): void {
  process.kill(pid, signal);
}

function sendSignal(
  signalSender: RuntimeGuardSignalSender,
  pid: number,
  signal: RuntimeGuardSignal
): { readonly status: "sent" } | { readonly status: "failed"; readonly error: unknown } {
  try {
    signalSender(pid, signal);
    return { status: "sent" };
  } catch (error) {
    return {
      status: "failed",
      error,
    };
  }
}

function isPositivePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function isTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function addressHasPort(address: string, port: number): boolean {
  const bracketMatch = /\]:(\d+)$/u.exec(address);
  if (bracketMatch !== null) {
    return Number(bracketMatch[1]) === port;
  }

  const colonMatch = /:(\d+)$/u.exec(address);
  if (colonMatch !== null) {
    return Number(colonMatch[1]) === port;
  }

  const dotMatch = /\.(\d+)$/u.exec(address);
  return dotMatch !== null && Number(dotMatch[1]) === port;
}

function lineHasPort(line: string, port: number): boolean {
  return new RegExp(`[:.]${escapeRegExp(String(port))}([^0-9]|$)`, "u").test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCommandUnavailable(result: RuntimeGuardCommandResult): boolean {
  return ["ENOENT", "ENOTDIR"].includes(result.errorCode ?? "");
}

function isProcessMissingText(text: string): boolean {
  return /not\s+found|no\s+running\s+instance|not\s+running|could\s+not\s+be\s+found|no\s+such\s+process/i.test(text);
}

function compactCommandText(result: RuntimeGuardCommandResult): string {
  return [result.stdout, result.stderr].map((text) => text.trim()).filter((text) => text.length > 0).join("\n");
}

function errorCode(error: unknown): string | undefined {
  return typeof (error as { readonly code?: unknown } | undefined)?.code === "string"
    ? String((error as { readonly code: string }).code)
    : undefined;
}

function signalErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

type NodeExecError = Error & {
  readonly code?: string | number;
  readonly signal?: string;
};
