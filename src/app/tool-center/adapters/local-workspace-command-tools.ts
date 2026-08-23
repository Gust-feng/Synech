import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, promises as fs, writeSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SanitizedCommandShellConfig } from "../../../domain/config/index.js";
import type {
  ToolContinuation,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionProgress,
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
  type ProcessPortFact,
  type ProcessFact,
  type ProcessLifetime,
  type ProcessRecord,
  type ProcessRecordUpdate,
  type ProcessRegistration,
  type ProcessStopResult,
  type ProcessTerminator,
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

const MAX_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
// Keep the normal command fact below the 6K full-envelope guard; complete logs remain readable through logRef.
const MAX_COMMAND_STDOUT_CHARS = 12_000;
const MAX_COMMAND_STDERR_CHARS = 4_000;
const COMMAND_TIMEOUT_EXIT_CODE = 124;
const COMMAND_CANCELLED_EXIT_CODE = 130;
const COMMAND_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_BACKGROUND_WAIT_MS = 500;
const MAX_BACKGROUND_WAIT_MS = 5_000;
const BACKGROUND_LOG_PREVIEW_CHARS = 2_000;
const DEFAULT_WAIT_FOR_PORT_TIMEOUT_MS = 10_000;
const MAX_WAIT_FOR_PORT_TIMEOUT_MS = 60_000;
const COMMAND_LOG_REF_SCHEME = "command-log";
const COMMAND_LOG_REF_PREFIX = `${COMMAND_LOG_REF_SCHEME}://`;
const COMMAND_LOG_DIRECTORY_NAME = "synech-command-logs";
const COMMAND_LOG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u;
const COMMAND_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const COMMAND_LOG_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_BACKGROUND_LOG_MAX_BYTES = 512 * 1024 * 1024;
const activeCommandLogPaths = new Set<string>();
const COMMAND_PROGRESS_TAIL_CHARS = 4_000;
const COMMAND_PROGRESS_INTERVAL_MS = 120;

type CommandExecutionResult = {
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

type CommandExecutionOutcome = {
  readonly result: CommandExecutionResult;
  readonly processId?: string;
};

type CommandLogTarget = {
  readonly id: string;
  readonly ref: string;
  readonly path: string;
};

export type LocalCommandProcessRegistry = {
  readonly register: (input: ProcessRegistration) => unknown;
  readonly listAll?: () => readonly ProcessRecord[];
  readonly get?: (processId: string) => ProcessRecord | undefined;
  readonly stopOwned?: (processId: string, terminator: ProcessTerminator) => Promise<ProcessStopResult>;
  readonly update?: (processId: string, patch: ProcessRecordUpdate) => unknown;
  readonly markExited?: (
    processId: string,
    input?: { readonly exitCode?: number; readonly signal?: string; readonly exitedAt?: string }
  ) => unknown;
  readonly appendPortFact?: (processId: string, fact: ProcessPortFact) => unknown;
  readonly appendFact?: (processId: string, fact: ProcessFact) => unknown;
};

export type LocalWorkspaceCommandToolOptions = LocalWorkspaceToolOptions & {
  readonly processRegistry?: LocalCommandProcessRegistry;
  readonly portOccupantProbe?: PortOccupantProbe;
  readonly maxBackgroundLogBytes?: number;
};

export type LocalCommandLogReadEntry = {
  readonly refId: string;
  readonly title: string;
  readonly uri: string;
  readonly content: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
};

type TextPreview = {
  readonly text: string;
  readonly chars: number;
  readonly omittedChars: number;
  readonly truncated: boolean;
};

type CommandProcessFacts = {
  readonly registry: LocalCommandProcessRegistry;
  readonly runId?: string;
  readonly toolCallId?: string;
  readonly conversationId?: string;
  readonly spaceId?: string;
  readonly referenceId?: string;
  readonly authorizationMode: "confirm_each" | "full_access";
};

type CommandProgressReporter = {
  readonly append: (stream: "stdout" | "stderr", chunk: Buffer | string) => void;
  readonly flush: () => void;
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
      const progress = createCommandProgressReporter(context);
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
          ? await runBackgroundShellCommand(commandShell, normalized.commandLine, cwd.absolutePath, displayedCwd, backgroundWaitMs, lifetime, maxBackgroundLogBytes, processFacts)
          : await runBackgroundProgramCommand(commandShell, normalized.directProgram, normalized.directArgs, normalized.commandLine, cwd.absolutePath, displayedCwd, backgroundWaitMs, lifetime, maxBackgroundLogBytes, processFacts)
        : normalized.directProgram === undefined || !executeDirectly
          ? await runShellCommand(commandShell, normalized.commandLine, cwd.absolutePath, displayedCwd, timeoutMs, context.abortSignal, processFacts, progress)
          : await runProgramCommand(normalized.directProgram, normalized.directArgs, normalized.commandLine, cwd.absolutePath, displayedCwd, timeoutMs, context.abortSignal, processFacts, progress);
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

export async function readLocalCommandLogRef(
  ref: string,
  request: { readonly maxLength: number; readonly abortSignal?: AbortSignal }
): Promise<LocalCommandLogReadEntry | undefined> {
  throwIfAborted(request.abortSignal);
  const target = commandLogTargetFromRef(ref);
  if (target === undefined) {
    return undefined;
  }
  let content: string;
  try {
    content = await fs.readFile(target.path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
  throwIfAborted(request.abortSignal);
  return {
    refId: ref,
    title: `Command log ${target.id}`,
    uri: ref,
    content,
    metadata: {
      id: target.id,
    },
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

function normalizeShellCommandInput(
  record: Readonly<Record<string, unknown>>,
  shellSyntax: SanitizedCommandShellConfig["syntax"]
): {
  readonly command: string;
  readonly commandLine: string;
  readonly directProgram?: string;
  readonly directArgs: readonly string[];
} {
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
  if (commandLine !== undefined) {
    return {
      command: commandLine,
      commandLine,
      directArgs: [],
    };
  }
  const command = requireCommand(record.command);
  return {
    command,
    commandLine: directArgs.length === 0 ? command : [command, ...directArgs].join(" "),
    directProgram: directArgs.length === 0 ? undefined : command,
    directArgs,
  };
}

function shellCommandLineFromArgv(
  command: string,
  args: readonly string[],
  shellSyntax: SanitizedCommandShellConfig["syntax"]
): string {
  return [command, ...args].map((value) => quoteShellArg(value, shellSyntax)).join(" ");
}

function quoteShellArg(value: string, shellSyntax: SanitizedCommandShellConfig["syntax"]): string {
  if (shellSyntax === "cmd") {
    return quoteCmdArg(value);
  }
  if (shellSyntax === "powershell") {
    return quotePowerShellArg(value);
  }
  return quotePosixArg(value);
}

function quotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) && value.length > 0) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:\\@%+=,-]+$/u.test(value) && value.length > 0) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:\\@+=,-]+$/u.test(value) && value.length > 0) {
    return value;
  }
  const escaped = value
    .replace(/\^/g, "^^")
    .replace(/"/g, '\\"')
    .replace(/[&|<>()]/g, (character) => `^${character}`)
    .replace(/%/g, "^%")
    .replace(/!/g, "^!");
  return `"${escaped}"`;
}

function commandProcessFacts(
  registry: LocalCommandProcessRegistry | undefined,
  context: ToolExecutionContext,
  cwd: AuthorizedLocalWorkspacePath,
): CommandProcessFacts | undefined {
  if (registry === undefined) {
    return undefined;
  }
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

function registerCommandProcess(
  facts: CommandProcessFacts | undefined,
  input: Omit<ProcessRegistration, "processId" | "owned" | "runId" | "toolCallId" | "ports">
): string | undefined {
  if (facts === undefined) {
    return undefined;
  }
  const processId = `process-${randomUUID()}`;
  const registration: ProcessRegistration = {
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
  };
  facts.registry.register(registration);
  return processId;
}

function markCommandProcessExited(
  facts: CommandProcessFacts | undefined,
  processId: string | undefined,
  input: { readonly exitCode?: number; readonly signal?: string }
): void {
  if (facts === undefined || processId === undefined) {
    return;
  }
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
    // Process facts are observational and must not change command execution results.
  }
}

function appendCommandPortFact(
  registry: LocalCommandProcessRegistry | undefined,
  processId: string | undefined,
  fact: ProcessPortFact
): void {
  if (registry === undefined || processId === undefined) {
    return;
  }
  try {
    if (registry.appendPortFact !== undefined) {
      registry.appendPortFact(processId, fact);
      return;
    }
    registry.update?.(processId, { ports: [fact] });
  } catch {
    // Process facts are observational and must not change command execution results.
  }
}

function appendCommandProcessFact(
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
    if (current !== undefined) {
      facts.registry.update?.(processId, { facts: [...current.facts, fact] });
    }
  } catch {
    // Process facts are observational and must not change command execution results.
  }
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

async function runShellCommand(
  shell: SanitizedCommandShellConfig,
  commandLine: string,
  workingDirectory: string,
  relativeCwd: string,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
  processFacts: CommandProcessFacts | undefined,
  progress: CommandProgressReporter,
): Promise<CommandExecutionOutcome> {
  const args = shellArgs(shell, commandLine);
  return runSpawnedCommand(shell.executable, args, workingDirectory, relativeCwd, timeoutMs, abortSignal, {
    commandLine,
    windowsVerbatimArguments: shell.syntax === "cmd",
  }, processFacts, progress);
}

async function runProgramCommand(
  command: string,
  args: readonly string[],
  commandLine: string,
  workingDirectory: string,
  relativeCwd: string,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
  processFacts: CommandProcessFacts | undefined,
  progress: CommandProgressReporter,
): Promise<CommandExecutionOutcome> {
  return runSpawnedCommand(command, [...args], workingDirectory, relativeCwd, timeoutMs, abortSignal, { commandLine }, processFacts, progress);
}

async function runBackgroundShellCommand(
  shell: SanitizedCommandShellConfig,
  commandLine: string,
  workingDirectory: string,
  relativeCwd: string,
  waitMs: number,
  lifetime: ProcessLifetime,
  maxLogBytes: number,
  processFacts: CommandProcessFacts | undefined
): Promise<CommandExecutionOutcome> {
  return runBackgroundCommand({
    file: shell.executable,
    args: shellArgs(shell, commandLine),
    commandLine,
    workingDirectory,
    relativeCwd,
    waitMs,
    stopShellSyntax: shell.syntax,
    platform: shell.platform,
    lifetime,
    maxLogBytes,
    windowsVerbatimArguments: shell.syntax === "cmd",
    processFacts,
  });
}

async function runBackgroundProgramCommand(
  shell: SanitizedCommandShellConfig,
  command: string,
  args: readonly string[],
  commandLine: string,
  workingDirectory: string,
  relativeCwd: string,
  waitMs: number,
  lifetime: ProcessLifetime,
  maxLogBytes: number,
  processFacts: CommandProcessFacts | undefined
): Promise<CommandExecutionOutcome> {
  return runBackgroundCommand({
    file: command,
    args: [...args],
    commandLine,
    workingDirectory,
    relativeCwd,
    waitMs,
    stopShellSyntax: shell.syntax,
    platform: shell.platform,
    lifetime,
    maxLogBytes,
    processFacts,
  });
}

async function runSpawnedCommand(
  file: string,
  args: readonly string[],
  workingDirectory: string,
  relativeCwd: string,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
  options: { readonly commandLine: string; readonly windowsVerbatimArguments?: boolean },
  processFacts: CommandProcessFacts | undefined,
  progress: CommandProgressReporter,
): Promise<CommandExecutionOutcome> {
  const logTarget = await createCommandLogTarget(options.commandLine);
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
    writeCommandLogHeader(logFd, options.commandLine, relativeCwd);
    const appendStdout = (chunk: Buffer) => {
      stdout.append(chunk);
      writeCommandLogChunk(logFd, "stdout", chunk);
      progress.append("stdout", chunk);
    };
    const appendStderr = (chunk: Buffer) => {
      stderr.append(chunk);
      writeCommandLogChunk(logFd, "stderr", chunk);
      progress.append("stderr", chunk);
    };
    const appendStderrText = (text: string) => {
      stderr.appendText(text);
      writeCommandLogText(logFd, "stderr", text);
      progress.append("stderr", text);
    };
    const closeLog = () => {
      if (logFd === undefined) {
        return;
      }
      closeSync(logFd);
      logFd = undefined;
      activeCommandLogPaths.delete(logTarget.path);
    };
    const removeLog = () => {
      void fs.unlink(logTarget.path).catch(() => {
        // Best-effort cleanup for non-truncated foreground commands.
      });
    };
    const appendTerminationDiagnostic = () => {
      const timeoutMessage = timedOut ? `Command timed out after ${timeoutMs}ms and was terminated.` : undefined;
      const cancelMessage = cancelled ? "Command execution cancelled." : undefined;
      if (timeoutMessage !== undefined) appendStderrText(timeoutMessage);
      if (cancelMessage !== undefined) appendStderrText(cancelMessage);
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
      cwd: relativeCwd,
      timedOut,
      cancelled,
      signal: signal ?? undefined,
      truncated: stdout.truncated() || stderr.truncated(),
    });
    const finish = (value: CommandExecutionResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (terminationTimer !== undefined) {
        clearTimeout(terminationTimer);
      }
      if (abortHandler !== undefined) {
        abortSignal?.removeEventListener("abort", abortHandler);
      }
      closeLog();
      progress.flush();
      markCommandProcessExited(processFacts, processId, {
        exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
        signal: value.signal,
      });
      if (value.truncated === true) {
        resolve({
          result: {
            ...value,
            logRef: logTarget.ref,
            logPath: logTarget.path,
          },
          processId,
        });
        return;
      }
      removeLog();
      resolve({ result: value, processId });
    };
    const requestTermination = () => {
      terminateProcessTree(child);
      if (terminationTimer === undefined) {
        terminationTimer = setTimeout(() => {
          appendTerminationDiagnostic();
          appendStderrText(
            `Command process did not close within ${COMMAND_TERMINATION_GRACE_MS}ms after termination was requested.`
          );
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(resultFromClose(null, undefined));
        }, COMMAND_TERMINATION_GRACE_MS);
        terminationTimer.unref?.();
      }
    };
    try {
      child = spawn(file, [...args], {
        cwd: workingDirectory,
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments === true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      closeLog();
      removeLog();
      reject(error);
      return;
    }
    try {
      processId = registerCommandProcess(processFacts, {
        kind: "foreground",
        lifetime: "run",
        pid: child.pid,
        commandLine: options.commandLine,
        cwd: workingDirectory,
        startedAt: new Date().toISOString(),
        status: "running",
      });
    } catch (error) {
      child.once("error", () => undefined);
      terminateProcessTree(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      closeLog();
      removeLog();
      reject(error);
      return;
    }
    if (child.stdout === null || child.stderr === null) {
      closeLog();
      removeLog();
      throw new Error("Command process did not expose stdout/stderr pipes.");
    }
    child.stdout.on("data", appendStdout);
    child.stderr.on("data", appendStderr);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (abortHandler !== undefined) {
        abortSignal?.removeEventListener("abort", abortHandler);
      }
      markCommandProcessExited(processFacts, processId, {});
      closeLog();
      progress.flush();
      removeLog();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      appendTerminationDiagnostic();
      finish(resultFromClose(code, signal));
    });
    timer = setTimeout(() => {
      if (cancelled) {
        return;
      }
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    abortHandler = () => {
      cancelled = true;
      requestTermination();
    };
    abortSignal?.addEventListener("abort", abortHandler, { once: true });
    if (abortSignal?.aborted === true) {
      abortHandler();
    }
  });
}

function createCommandProgressReporter(context: ToolExecutionContext): CommandProgressReporter {
  if (context.reportProgress === undefined) {
    return { append: () => undefined, flush: () => undefined };
  }
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
      // Progress is best-effort observation and cannot alter command execution.
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
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      report();
    },
  };
}

function boundedTail(current: string, incoming: string, maxChars: number): string {
  const combined = `${current}${incoming}`;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
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
  readonly windowsVerbatimArguments?: boolean;
  readonly processFacts?: CommandProcessFacts;
}): Promise<CommandExecutionOutcome> {
  const logTarget = await createCommandLogTarget(input.commandLine);
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
    appendCommandProcessFact(input.processFacts, processId, {
      kind: "command_log_limit",
      observedAt: new Date().toISOString(),
      limitBytes: input.maxLogBytes,
      observedBytes: logBytes,
      action: "terminate_process",
    });
  };
  const flushAndCloseLog = () => {
    if (logClosed) return;
    appendLogText("stdout", stdoutDecoder.end());
    appendLogText("stderr", stderrDecoder.end());
    logClosed = true;
    closeSync(logFd);
    activeCommandLogPaths.delete(logPath);
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
    if (start.status === "exited") {
      earlyExit = { code: start.code, signal: start.signal };
    }
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
    const logPreview = await readBackgroundLogPreview(logPath);
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
  const initialLogPreview = await readBackgroundLogPreview(logPath, BACKGROUND_LOG_PREVIEW_CHARS);
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

function createBoundedOutputCollector(maxChars: number): {
  readonly append: (chunk: Buffer) => void;
  readonly appendText: (text: string) => void;
  readonly text: () => string;
  readonly truncated: () => boolean;
  readonly chars: () => number;
  readonly omittedChars: () => number;
} {
  let value = "";
  let totalChars = 0;
  let isTruncated = false;
  const appendText = (text: string) => {
    if (text.length === 0) {
      return;
    }
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
    append(chunk: Buffer) {
      appendText(chunk.toString("utf8"));
    },
    appendText,
    text() {
      return value;
    },
    truncated() {
      return isTruncated;
    },
    chars() {
      return totalChars;
    },
    omittedChars() {
      return Math.max(0, totalChars - value.length);
    },
  };
}

async function createCommandLogTarget(commandLine: string): Promise<CommandLogTarget> {
  const directory = commandLogDirectory();
  await fs.mkdir(directory, { recursive: true });
  await pruneLocalCommandLogs({ directory, activeLogPaths: activeCommandLogPaths }).catch(() => undefined);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `${timestamp}-${randomUUID()}-${safeRefToken(commandLine)}`;
  const target = {
    id,
    ref: `${COMMAND_LOG_REF_PREFIX}${id}`,
    path: path.join(directory, `${id}.log`),
  };
  activeCommandLogPaths.add(target.path);
  return target;
}

export async function pruneLocalCommandLogs(options: {
  readonly directory?: string;
  readonly maxAgeMs?: number;
  readonly maxTotalBytes?: number;
  readonly now?: number;
  readonly activeLogPaths?: ReadonlySet<string>;
} = {}): Promise<{ readonly removed: number; readonly retainedBytes: number }> {
  const directory = path.resolve(options.directory ?? commandLogDirectory());
  const maxAgeMs = positiveSafeIntegerOrFallback(options.maxAgeMs, COMMAND_LOG_RETENTION_MS);
  const maxTotalBytes = positiveSafeIntegerOrFallback(options.maxTotalBytes, COMMAND_LOG_MAX_TOTAL_BYTES);
  const now = options.now ?? Date.now();
  const activePaths = options.activeLogPaths ?? activeCommandLogPaths;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return { removed: 0, retainedBytes: 0 };
    throw error;
  }
  const logs = (await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
    .map(async (entry) => {
      const logPath = path.join(directory, entry.name);
      const stat = await fs.stat(logPath).catch(() => undefined);
      return stat === undefined ? undefined : { path: logPath, size: stat.size, modifiedAtMs: stat.mtimeMs };
    })))
    .filter((entry): entry is { readonly path: string; readonly size: number; readonly modifiedAtMs: number } =>
      entry !== undefined);
  let retainedBytes = logs.reduce((total, entry) => total + entry.size, 0);
  let removed = 0;
  const removable = logs
    .filter((entry) => !activePaths.has(entry.path))
    .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
  for (const entry of removable) {
    const expired = now - entry.modifiedAtMs >= maxAgeMs;
    if (!expired && retainedBytes <= maxTotalBytes) break;
    try {
      await fs.unlink(entry.path);
      retainedBytes = Math.max(0, retainedBytes - entry.size);
      removed += 1;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return { removed, retainedBytes };
}

function positiveSafeIntegerOrFallback(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function commandLogTargetFromRef(ref: string): CommandLogTarget | undefined {
  if (!ref.startsWith(COMMAND_LOG_REF_PREFIX)) {
    return undefined;
  }
  const id = ref.slice(COMMAND_LOG_REF_PREFIX.length);
  if (!COMMAND_LOG_ID_PATTERN.test(id)) {
    return undefined;
  }
  return {
    id,
    ref,
    path: path.join(commandLogDirectory(), `${id}.log`),
  };
}

function commandLogDirectory(): string {
  return path.join(os.tmpdir(), COMMAND_LOG_DIRECTORY_NAME);
}

function commandLogHeader(commandLine: string, cwd: string): string {
  return [
    `command: ${commandLine}`,
    `cwd: ${cwd}`,
    `createdAt: ${new Date().toISOString()}`,
    "",
  ].join("\n");
}

function writeCommandLogHeader(fd: number | undefined, commandLine: string, cwd: string): void {
  if (fd === undefined) {
    return;
  }
  writeSync(fd, commandLogHeader(commandLine, cwd));
}

function writeCommandLogChunk(fd: number | undefined, stream: "stdout" | "stderr", chunk: Buffer): void {
  if (fd === undefined || chunk.length === 0) {
    return;
  }
  writeSync(fd, `\n[${stream}]\n`);
  writeSync(fd, chunk);
}

function writeCommandLogText(fd: number | undefined, stream: "stdout" | "stderr", text: string): void {
  if (fd === undefined || text.length === 0) {
    return;
  }
  writeSync(fd, `\n[${stream}]\n${text}`);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
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
  await Promise.all([
    waitForReadableEnd(child.stdout),
    waitForReadableEnd(child.stderr),
  ]);
}

function waitForReadableEnd(stream: import("node:stream").Readable | null): Promise<void> {
  if (stream === null || stream.readableEnded === true || stream.destroyed === true) {
    return Promise.resolve();
  }
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

async function waitForBackgroundStart(child: ChildProcess, waitMs: number): Promise<
  | { readonly status: "running" }
  | { readonly status: "exited"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const settle = (result: { readonly status: "running" } | { readonly status: "exited"; readonly code: number | null; readonly signal: NodeJS.Signals | null }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      resolve(result);
    };
    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      settle({ status: "exited", code, signal });
    };
    timer = setTimeout(() => {
      settle({ status: "running" });
    }, waitMs);
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
        activeCommandLogPaths.delete(logPath);
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

async function readBackgroundLogPreview(logPath: string, maxChars = MAX_COMMAND_STDOUT_CHARS): Promise<TextPreview> {
  try {
    const text = await fs.readFile(logPath, "utf8");
    return commandOutputPreview({ text, chars: text.length, maxChars });
  } catch {
    return {
      text: "",
      chars: 0,
      omittedChars: 0,
      truncated: false,
    };
  }
}

function terminateProcessTree(child: ChildProcess): void {
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
    killer.on("error", () => {
      child.kill();
    });
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

function stopCommandForPid(
  pid: number,
  platform: NodeJS.Platform,
  shellSyntax: SanitizedCommandShellConfig["syntax"]
): string {
  if (platform === "win32") {
    return shellSyntax === "posix"
      ? `taskkill.exe //pid ${pid} //T //F`
      : `taskkill /pid ${pid} /T /F`;
  }
  return `kill -TERM -${pid} || kill -TERM ${pid}`;
}

function shellArgs(shell: SanitizedCommandShellConfig, commandLine: string): readonly string[] {
  if (shell.syntax === "cmd") {
    return ["/d", "/s", "/c", commandLine];
  }
  if (shell.syntax === "powershell") {
    return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", commandLine];
  }
  return ["-lc", commandLine];
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

function requireCommand(value: unknown): string {
  const text = stringField(value);
  if (text === undefined) {
    throw new Error("commandLine must be a non-empty string.");
  }
  return text;
}

function stringField(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length === 0 ? undefined : text;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item : String(item ?? "")));
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

async function shouldExecuteDirectly(input: {
  readonly command: string;
  readonly rootDirectory: string;
  readonly platform: NodeJS.Platform;
}): Promise<boolean> {
  if (input.platform !== "win32") {
    return true;
  }
  const resolved = await resolveWindowsCommandPath(input.command, input.rootDirectory);
  if (resolved === undefined) {
    return false;
  }
  const extension = path.extname(resolved).toLowerCase();
  return extension !== ".cmd" && extension !== ".bat";
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
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

async function firstExistingCommandCandidate(base: string, extensions: readonly string[]): Promise<string | undefined> {
  const explicitExtension = path.extname(base).length > 0;
  const candidates = explicitExtension ? [base] : [base, ...extensions.map((extension) => `${base}${extension}`)];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
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
