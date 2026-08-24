import { promises as fs } from "node:fs";
import path from "node:path";
import type { SanitizedCommandShellConfig } from "../../../domain/config/index.js";
import type {
  ToolContinuation,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutor,
} from "../../../domain/tools/index.js";
import {
  createPlatformPortOccupantProbe,
  probeLocalPort,
  processPortFactFromLocalPortFact,
  waitForLocalPort,
  type LocalPortHost,
  type LocalPortOccupancyFact,
  type LocalPortProbeFact,
  type PortOccupantProbe,
  type ProcessLifetime,
  type ProcessRecord,
} from "../../runtime-guard/index.js";
import { toSanitizedCommandShellConfig } from "../../config-center/command-shell-settings.js";
import {
  asRecord,
  type AuthorizedLocalWorkspacePath,
  DEFAULT_LOCAL_WORKSPACE_ROOT,
  positiveInteger,
  resolveAuthorizedWorkspacePath,
  safeRefToken,
  throwIfAborted,
  type LocalWorkspaceToolOptions,
} from "./local-workspace-common.js";
import {
  assertSandboxAllowed,
  createLocalWorkspaceSandboxPolicy,
} from "./local-workspace-sandbox.js";
import {
  appendCommandPortFact,
  commandProcessFacts,
  MAX_COMMAND_STDERR_CHARS,
  MAX_COMMAND_STDOUT_CHARS,
  normalizeShellCommandInput,
  runForegroundProgramCommand,
  runForegroundShellCommand,
  shouldExecuteDirectly,
  type CommandExecutionResult,
  type LocalCommandProcessRegistry,
} from "./command-execution.js";
import {
  runBackgroundProgramCommand,
  runBackgroundShellCommand,
} from "./background-process.js";

export { pruneLocalCommandLogs, readLocalCommandLogRef } from "./command-log.js";
export type { LocalCommandLogReadEntry } from "./command-log.js";
export type { LocalCommandProcessRegistry } from "./command-execution.js";

const MAX_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
// Keep the normal command fact below the 6K full-envelope guard; complete logs remain readable through logRef.
const DEFAULT_BACKGROUND_WAIT_MS = 500;
const MAX_BACKGROUND_WAIT_MS = 5_000;
const DEFAULT_WAIT_FOR_PORT_TIMEOUT_MS = 10_000;
const MAX_WAIT_FOR_PORT_TIMEOUT_MS = 60_000;
const DEFAULT_BACKGROUND_LOG_MAX_BYTES = 512 * 1024 * 1024;

export type LocalWorkspaceCommandToolOptions = LocalWorkspaceToolOptions & {
  readonly processRegistry?: LocalCommandProcessRegistry;
  readonly portOccupantProbe?: PortOccupantProbe;
  readonly maxBackgroundLogBytes?: number;
};

type TextPreview = {
  readonly text: string;
  readonly chars: number;
  readonly omittedChars: number;
  readonly truncated: boolean;
};


type RegistryPortOwner = {
  readonly processId: string;
  readonly pid?: number;
  readonly match: "pid" | "port_fact";
};

export function createDefaultCommandShellConfig(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env
): SanitizedCommandShellConfig {
  return toSanitizedCommandShellConfig(undefined, { platform, env, now: "runtime-default" });
}

export function createLocalShellCommandTool(
  rootDirectory = DEFAULT_LOCAL_WORKSPACE_ROOT,
  options: LocalWorkspaceCommandToolOptions = {}
): ToolExecutor {
  const sandboxPolicy = options.sandboxPolicy ?? createLocalWorkspaceSandboxPolicy();
  const commandShell = normalizeCommandShellConfig(options.commandShell);
  const portOccupantProbe = options.portOccupantProbe ?? createPlatformPortOccupantProbe();
  const maxBackgroundLogBytes = positiveSafeIntegerOrFallback(
    options.maxBackgroundLogBytes,
    DEFAULT_BACKGROUND_LOG_MAX_BYTES,
  );
  return {
    definition: shellCommandDefinition(commandShell),
    execute: async (input, context) => {
      throwIfAborted(context.abortSignal);
      const record = asRecord(input);
      const normalized = normalizeShellCommandInput(record, commandShell.syntax);
      const timeoutMs = Math.min(MAX_COMMAND_TIMEOUT_MS, positiveInteger(record.timeoutMs) ?? DEFAULT_COMMAND_TIMEOUT_MS);
      const backgroundWaitMs = Math.min(MAX_BACKGROUND_WAIT_MS, positiveInteger(record.backgroundWaitMs) ?? DEFAULT_BACKGROUND_WAIT_MS);
      const waitForPort = optionalPort(record.waitForPort);
      const waitForPortTimeoutMs = Math.min(
        MAX_WAIT_FOR_PORT_TIMEOUT_MS,
        positiveInteger(record.waitForPortTimeoutMs) ?? DEFAULT_WAIT_FOR_PORT_TIMEOUT_MS
      );
      const background = record.background === true;
      const lifetime = background ? processLifetime(record.lifetime) : "run";
      const cwd = await resolveCommandCwd(
        rootDirectory,
        record.cwd,
        context,
        options.pathAuthorization,
      );
      const displayedCwd = options.pathAuthorization === undefined ? cwd.relativePath : cwd.absolutePath;
      const processFacts = commandProcessFacts(options.processRegistry, context, cwd);
      assertSandboxAllowed(sandboxPolicy, {
        operation: "execute",
        workspaceRoot: cwd.rootDirectory,
        relativePath: cwd.relativePath,
        command: normalized.command,
        commandLine: normalized.commandLine,
        args: normalized.directArgs,
        bytes: timeoutMs,
      });
      const executeDirectly = normalized.directProgram !== undefined &&
        await shouldExecuteDirectly({
          command: normalized.directProgram,
          rootDirectory: options.pathAuthorization === undefined ? rootDirectory : cwd.absolutePath,
          platform: commandShell.platform,
        });
      const startedAt = Date.now();
      const externalPortOccupantProbe = externalOnlyPortOccupantProbe(options.processRegistry, portOccupantProbe);
      const preStartPortFact = await probePreStartWaitPort({
        waitForPort,
        abortSignal: context.abortSignal,
        portOccupantProbe,
      });
      const preStartPortOccupancy = portOccupancyFromPreStartFact(preStartPortFact, options.processRegistry);
      throwIfAborted(context.abortSignal);
      if (background && preStartPortOccupancy !== undefined) {
        return commandToolOutput({
          command: normalized.command,
          commandLine: normalized.commandLine,
          directArgs: normalized.directArgs,
          shell: commandShell,
          result: commandNotStartedForOccupiedPort({
            cwd: cwd.relativePath,
            waitForPort,
            preStartPortOccupancy,
            startedAt,
          }),
          lifetime,
          truncated: false,
        });
      }
      const rawOutcome = background
        ? normalized.directProgram === undefined || !executeDirectly
          ? await runBackgroundShellCommand({
              shell: commandShell,
              commandLine: normalized.commandLine,
              workingDirectory: cwd.absolutePath,
              relativeCwd: displayedCwd,
              waitMs: backgroundWaitMs,
              lifetime,
              maxLogBytes: maxBackgroundLogBytes,
              processFacts,
            })
          : await runBackgroundProgramCommand({
              shell: commandShell,
              command: normalized.directProgram,
              args: normalized.directArgs,
              commandLine: normalized.commandLine,
              workingDirectory: cwd.absolutePath,
              relativeCwd: displayedCwd,
              waitMs: backgroundWaitMs,
              lifetime,
              maxLogBytes: maxBackgroundLogBytes,
              processFacts,
            })
        : normalized.directProgram === undefined || !executeDirectly
          ? await runForegroundShellCommand({
              shell: commandShell,
              commandLine: normalized.commandLine,
              workingDirectory: cwd.absolutePath,
              relativeCwd: displayedCwd,
              timeoutMs,
              context,
              processFacts,
            })
          : await runForegroundProgramCommand({
              command: normalized.directProgram,
              args: normalized.directArgs,
              commandLine: normalized.commandLine,
              workingDirectory: cwd.absolutePath,
              relativeCwd: displayedCwd,
              timeoutMs,
              context,
              processFacts,
            });
      const result = await enrichCommandResult({
        result: rawOutcome.result,
        waitForPort,
        waitForPortTimeoutMs,
        preStartPortFact,
        startedAt,
        abortSignal: context.abortSignal,
        processRegistry: options.processRegistry,
        processId: rawOutcome.processId,
        portOccupantProbe: externalPortOccupantProbe,
      });
      return commandToolOutput({
        command: normalized.command,
        commandLine: normalized.commandLine,
        directArgs: normalized.directArgs,
        shell: commandShell,
        result,
        processId: rawOutcome.processId,
        lifetime,
        truncated: false,
      });
    },
  };
}

function shellCommandDefinition(commandShell: SanitizedCommandShellConfig): ToolDefinition {
  return {
    name: "Shell",
    description: "Run a workspace command in the foreground or start it as an owned background process. Use ProcessRead and ProcessStop for background processes.",
    metadata: {
      category: "terminal",
      riskLevel: "medium",
      operationType: "execute",
      requiresConfirmation: true,
      runtimeHints: [{
        kind: "command_shell",
        shellId: commandShell.kind,
        label: commandShell.label,
        executable: commandShell.executable,
        syntax: commandShell.syntax,
        platform: commandShell.platform,
        invocation: commandShell.invocation,
        commandLineParameter: "command",
        notes: commandShell.notes,
      }],
    },
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
          description: `Complete ${commandShell.syntax} command for ${commandShell.label}. Runs from the current run root unless cwd is set.`,
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: MAX_COMMAND_TIMEOUT_MS,
          description: `Optional timeout in milliseconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_MS}; maximum ${MAX_COMMAND_TIMEOUT_MS}.`,
        },
        cwd: {
          type: "string",
          description: "Optional absolute or run-root-relative working directory. Defaults to the current run root.",
        },
        background: {
          type: "boolean",
          description: "Start an owned background process and return its processId without waiting for exit.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };
}

function commandToolOutput(input: {
  readonly command: string;
  readonly commandLine: string;
  readonly directArgs: readonly string[];
  readonly shell: SanitizedCommandShellConfig;
  readonly result: CommandExecutionResult;
  readonly processId?: string;
  readonly lifetime: ProcessLifetime;
  readonly truncated: boolean;
}): {
  readonly refId: string;
  readonly command: string;
  readonly commandLine: string;
  readonly args?: readonly string[];
  readonly shell: {
    readonly kind: SanitizedCommandShellConfig["kind"];
    readonly label: string;
    readonly executable: string;
    readonly syntax: SanitizedCommandShellConfig["syntax"];
    readonly invocation: readonly string[];
  };
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly notStarted?: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutChars: number;
  readonly stderrChars: number;
  readonly stdoutOmittedChars: number;
  readonly stderrOmittedChars: number;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly signal?: string;
  readonly background?: boolean;
  readonly processId?: string;
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
  readonly truncated: boolean;
  readonly continuation?: ToolContinuation;
} {
  const stdout = commandOutputPreview({
    text: input.result.stdout,
    chars: input.result.stdoutChars,
    omittedChars: input.result.stdoutOmittedChars,
    maxChars: MAX_COMMAND_STDOUT_CHARS,
  });
  const stderr = commandOutputPreview({
    text: input.result.stderr,
    chars: input.result.stderrChars,
    omittedChars: input.result.stderrOmittedChars,
    maxChars: MAX_COMMAND_STDERR_CHARS,
  });
  const truncated = input.truncated || input.result.truncated === true || stdout.truncated || stderr.truncated;
  const continuation = input.result.logRef !== undefined && (truncated || input.result.background === true)
    ? {
        ref: input.result.logRef,
        nextInput: { ref: input.result.logRef, maxLength: 30_000 },
      }
    : undefined;
  return {
    refId: `workspace:shell:${safeRefToken(input.commandLine)}`,
    command: input.command,
    commandLine: input.commandLine,
    args: input.directArgs.length === 0 ? undefined : [...input.directArgs],
    shell: {
      kind: input.shell.kind,
      label: input.shell.label,
      executable: input.shell.executable,
      syntax: input.shell.syntax,
      invocation: [...input.shell.invocation],
    },
    cwd: input.result.cwd,
    exitCode: input.result.exitCode,
    notStarted: input.result.notStarted === true ? true : undefined,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutChars: stdout.chars,
    stderrChars: stderr.chars,
    stdoutOmittedChars: stdout.omittedChars,
    stderrOmittedChars: stderr.omittedChars,
    timedOut: input.result.timedOut === true ? true : undefined,
    cancelled: input.result.cancelled === true ? true : undefined,
    signal: input.result.signal,
    background: input.result.background === true ? true : undefined,
    ...(input.result.background === true && input.processId !== undefined
      ? { processId: input.processId }
      : {}),
    processState: input.result.processState,
    lifetime: input.result.background === true || input.result.notStarted === true ? input.lifetime : undefined,
    pid: input.result.pid,
    logRef: input.result.logRef,
    logPath: input.result.logPath,
    stopCommand: input.result.stopCommand,
    durationMs: input.result.durationMs,
    waitForPort: input.result.waitForPort,
    portReady: input.result.portReady,
    preStartPortOccupancy: input.result.preStartPortOccupancy,
    portWaitCancelled: input.result.portWaitCancelled === true ? true : undefined,
    truncated,
    continuation,
  };
}

function commandOutputPreview(input: {
  readonly text: string;
  readonly chars: number | undefined;
  readonly omittedChars?: number;
  readonly maxChars: number;
}): TextPreview {
  const chars = Math.max(input.chars ?? input.text.length + (input.omittedChars ?? 0), input.text.length);
  const text = input.text.length <= input.maxChars
    ? input.text
    : input.text.slice(0, input.maxChars);
  return {
    text,
    chars,
    omittedChars: Math.max(0, chars - text.length),
    truncated: text.length < chars,
  };
}

function externalOnlyPortOccupantProbe(
  registry: LocalCommandProcessRegistry | undefined,
  probe: PortOccupantProbe
): PortOccupantProbe {
  return async (input) => {
    const observed = await probe(input);
    if (observed === undefined) {
      return undefined;
    }
    if (findActiveRegistryPortOwner(registry, input.port, input.host, observed.pid) !== undefined) {
      return undefined;
    }
    return observed;
  };
}

function findActiveRegistryPortOwner(
  registry: LocalCommandProcessRegistry | undefined,
  port: number,
  host: LocalPortHost,
  observedPid: number | undefined
): RegistryPortOwner | undefined {
  const records = registry?.listAll?.() ?? [];
  for (const record of records) {
    if (record.owned !== true || !isActiveProcessStatus(record.status)) {
      continue;
    }
    if (observedPid !== undefined) {
      if (record.pid !== observedPid) {
        continue;
      }
      return {
        processId: record.processId,
        pid: record.pid,
        match: "pid",
      };
    }
    if (record.ports.some((fact) => fact.port === port && fact.host === host && fact.ready === true)) {
      return {
        processId: record.processId,
        pid: record.pid,
        match: "port_fact",
      };
    }
  }
  return undefined;
}

function isActiveProcessStatus(status: ProcessRecord["status"]): boolean {
  return status === "starting" || status === "running" || status === "killing";
}

async function probePreStartWaitPort(input: {
  readonly waitForPort: number | undefined;
  readonly abortSignal: AbortSignal | undefined;
  readonly portOccupantProbe: PortOccupantProbe;
}): Promise<LocalPortProbeFact | undefined> {
  if (input.waitForPort === undefined) {
    return undefined;
  }
  const fact = await probeLocalPort({
    port: input.waitForPort,
    host: "127.0.0.1",
    timeoutMs: 250,
    abortSignal: input.abortSignal,
    portOccupantProbe: input.portOccupantProbe,
  });
  return fact.ready === true ? fact : undefined;
}

function portOccupancyFromPreStartFact(
  fact: LocalPortProbeFact | undefined,
  registry: LocalCommandProcessRegistry | undefined
): LocalPortOccupancyFact | undefined {
  if (fact === undefined || fact.ready !== true) {
    return undefined;
  }
  const observedPid = fact.externalOccupant?.pid;
  const registryOwner = findActiveRegistryPortOwner(registry, fact.port, fact.host, observedPid);
  const pid = observedPid;
  const source = fact.externalOccupant?.observedBy ?? "connect_probe";
  if (registryOwner?.match === "pid") {
    return {
      kind: "pre_start_port_occupancy",
      port: fact.port,
      host: fact.host,
      occupied: true,
      ...(pid === undefined ? {} : { pid }),
      pidKnown: pid !== undefined,
      owner: "synech",
      ownedByUs: true,
      source,
      ownershipSource: "process_registry",
      registryProcessId: registryOwner.processId,
      checkedAt: fact.checkedAt,
    };
  }
  return {
    kind: "pre_start_port_occupancy",
    port: fact.port,
    host: fact.host,
    occupied: true,
    ...(pid === undefined ? {} : { pid }),
    pidKnown: pid !== undefined,
    owner: "unknown",
    ownerUnknown: true,
    source,
    checkedAt: fact.checkedAt,
  };
}

function commandNotStartedForOccupiedPort(input: {
  readonly cwd: string;
  readonly waitForPort: number | undefined;
  readonly preStartPortOccupancy: LocalPortOccupancyFact;
  readonly startedAt: number;
}): CommandExecutionResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    cwd: input.cwd,
    notStarted: true,
    waitForPort: input.waitForPort,
    portReady: false,
    preStartPortOccupancy: input.preStartPortOccupancy,
    durationMs: Date.now() - input.startedAt,
    stdoutChars: 0,
    stderrChars: 0,
    stdoutOmittedChars: 0,
    stderrOmittedChars: 0,
    truncated: false,
  };
}

async function resolveCommandCwd(
  rootDirectory: string,
  value: unknown,
  context: ToolExecutionContext,
  authorization: LocalWorkspaceCommandToolOptions["pathAuthorization"],
): Promise<AuthorizedLocalWorkspacePath> {
  const target = await resolveAuthorizedWorkspacePath(
    rootDirectory,
    typeof value === "string" && value.trim().length > 0 ? value : ".",
    "execute",
    context,
    authorization,
  );
  const stat = await fs.stat(target.absolutePath);
  if (!stat.isDirectory()) {
    throw new Error(`shell cwd must be a directory: ${target.absolutePath}`);
  }
  return target;
}

async function enrichCommandResult(input: {
  readonly result: CommandExecutionResult;
  readonly waitForPort: number | undefined;
  readonly waitForPortTimeoutMs: number;
  readonly preStartPortFact: LocalPortProbeFact | undefined;
  readonly startedAt: number;
  readonly abortSignal: AbortSignal | undefined;
  readonly processRegistry: LocalCommandProcessRegistry | undefined;
  readonly processId?: string;
  readonly portOccupantProbe: PortOccupantProbe;
}): Promise<CommandExecutionResult> {
  if (input.waitForPort === undefined) {
    return {
      ...input.result,
      durationMs: Date.now() - input.startedAt,
    };
  }
  if (input.result.background !== true) {
    const portFact = input.preStartPortFact ?? await probeLocalPort({
      port: input.waitForPort,
      host: "127.0.0.1",
      timeoutMs: Math.min(250, input.waitForPortTimeoutMs),
      abortSignal: input.abortSignal,
      portOccupantProbe: input.portOccupantProbe,
    });
    const preStartPortOccupancy = portOccupancyFromPreStartFact(portFact, input.processRegistry);
    appendCommandPortFact(input.processRegistry, input.processId, processPortFactFromLocalPortFact(portFact));
    return {
      ...input.result,
      waitForPort: input.waitForPort,
      portReady: false,
      preStartPortOccupancy,
      durationMs: Date.now() - input.startedAt,
      stderr: appendCommandDiagnostic(
        input.result.stderr,
        "waitForPort was requested but the command is not running in the background."
      ),
    };
  }
  if (input.preStartPortFact !== undefined) {
    appendCommandPortFact(
      input.processRegistry,
      input.processId,
      processPortFactFromLocalPortFact(input.preStartPortFact)
    );
  }
  const portWait = await waitForLocalPort({
    port: input.waitForPort,
    host: "127.0.0.1",
    timeoutMs: input.waitForPortTimeoutMs,
    probeTimeoutMs: 250,
    pollIntervalMs: 100,
    abortSignal: input.abortSignal,
    portOccupantProbe: input.portOccupantProbe,
  });
  appendCommandPortFact(input.processRegistry, input.processId, processPortFactFromLocalPortFact(portWait));
  const portReady = portWait.ready;
  const durationMs = Date.now() - input.startedAt;
  return {
    ...input.result,
    waitForPort: input.waitForPort,
    portReady,
    portWaitCancelled: portWait.cancelled ? true : undefined,
    durationMs,
    stdout: portReady
      ? appendCommandDiagnostic(input.result.stdout, `Port ${input.waitForPort} is ready.`)
      : input.result.stdout,
    stderr: portWait.ready
      ? input.result.stderr
      : portWait.cancelled
        ? appendCommandDiagnostic(
            input.result.stderr,
            `Port wait for ${input.waitForPort} was cancelled before the port became ready.`
          )
      : appendCommandDiagnostic(
          input.result.stderr,
          `Port ${input.waitForPort} did not become ready within ${input.waitForPortTimeoutMs}ms.`
        ),
  };
}

function appendCommandDiagnostic(existing: string, message: string): string {
  return existing.trim().length === 0 ? message : `${existing.replace(/\s*$/u, "")}\n${message}`;
}

function positiveSafeIntegerOrFallback(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeCommandShellConfig(value: SanitizedCommandShellConfig | undefined): SanitizedCommandShellConfig {
  if (value === undefined) {
    return createDefaultCommandShellConfig();
  }
  return {
    ...value,
    invocation: [...value.invocation],
    notes: [...value.notes],
    commandLineParameter: "commandLine",
  };
}

function optionalPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const port = positiveInteger(value);
  if (port === undefined || port > 65_535) {
    throw new Error("waitForPort must be an integer TCP port between 1 and 65535.");
  }
  return port;
}

function processLifetime(value: unknown): ProcessLifetime {
  if (value === undefined) {
    return "workspace_session";
  }
  if (value === "run" || value === "workspace_session") {
    return value;
  }
  throw new Error("Background process lifetime must be run or workspace_session.");
}
