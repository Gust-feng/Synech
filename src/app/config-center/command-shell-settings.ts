import type {
  CommandShellSettings,
  ConfiguredCommandShellKind,
  SanitizedCommandShellConfig,
  UpdateCommandShellConfigInput,
} from "../../domain/config/index.js";
import {
  defaultExecutable,
  defaultShellKind,
  detectCommandShellOptions,
  detectRuntimeEnvironmentTools,
  type ResolvedCommandShellKind,
} from "./runtime-environment-detection.js";
import { ConfigSchemaValidationError, optionalString } from "./settings-utils.js";

export function normalizeCommandShellSettings(
  settings: CommandShellSettings | undefined,
  now: string
): CommandShellSettings {
  return {
    kind: normalizeCommandShellKind(settings?.kind) ?? "auto",
    executable: optionalString(settings?.executable),
    updatedAt: optionalString(settings?.updatedAt) ?? now,
  };
}

export function parseCommandShellSettings(raw: unknown, fallbackUpdatedAt: string): CommandShellSettings | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Readonly<Record<string, unknown>>;
  return normalizeCommandShellSettings({
    kind: normalizeCommandShellKind(record.kind) ?? "auto",
    executable: optionalString(record.executable),
    updatedAt: optionalString(record.updatedAt) ?? fallbackUpdatedAt,
  }, fallbackUpdatedAt);
}

export function normalizeCommandShellUpdate(
  input: UpdateCommandShellConfigInput,
  now: string
): CommandShellSettings {
  const kind = normalizeCommandShellKind(input.kind);
  if (kind === undefined) {
    throw new ConfigSchemaValidationError("commandShell.kind must be one of auto, cmd, powershell, pwsh, bash, or sh.");
  }
  return {
    kind,
    executable: optionalString(input.executable),
    updatedAt: now,
  };
}

export function toSanitizedCommandShellConfig(
  settings: CommandShellSettings | undefined,
  input: {
    readonly platform?: NodeJS.Platform;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly now?: string;
  } = {}
): SanitizedCommandShellConfig {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const normalized = normalizeCommandShellSettings(settings, input.now ?? new Date().toISOString());
  const availableShells = detectCommandShellOptions(platform, env);
  const runtimeTools = detectRuntimeEnvironmentTools(platform, env);
  const kind = normalized.kind === "auto" ? defaultShellKind(platform, env, availableShells) : normalized.kind;
  const executable = normalized.executable ?? defaultExecutable(kind, platform, env, availableShells);
  const syntax = shellSyntax(kind);
  return {
    configuredKind: normalized.kind,
    autoDetected: normalized.kind === "auto",
    kind,
    label: shellLabel(kind, platform),
    executable,
    syntax,
    platform,
    invocation: shellInvocation(executable, syntax),
    commandLineParameter: "commandLine",
    notes: shellNotes(syntax, normalized.kind),
    availableShells,
    runtimeTools,
    updatedAt: normalized.updatedAt,
  };
}

function normalizeCommandShellKind(value: unknown): ConfiguredCommandShellKind | undefined {
  return value === "auto" ||
    value === "cmd" ||
    value === "powershell" ||
    value === "pwsh" ||
    value === "bash" ||
    value === "sh"
    ? value
    : undefined;
}

function shellSyntax(kind: ResolvedCommandShellKind): SanitizedCommandShellConfig["syntax"] {
  if (kind === "cmd") return "cmd";
  if (kind === "powershell" || kind === "pwsh") return "powershell";
  return "posix";
}

function shellLabel(kind: ResolvedCommandShellKind, platform: NodeJS.Platform): string {
  if (kind === "cmd") return "Windows Command Prompt";
  if (kind === "powershell") return "Windows PowerShell";
  if (kind === "pwsh") return "PowerShell";
  if (kind === "bash") return platform === "win32" ? "Git Bash" : "Bash";
  return "POSIX shell";
}

function shellInvocation(executable: string, syntax: SanitizedCommandShellConfig["syntax"]): readonly string[] {
  if (syntax === "cmd") return [executable, "/d", "/s", "/c", "<commandLine>"];
  if (syntax === "powershell") return [executable, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "<commandLine>"];
  return [executable, "-lc", "<commandLine>"];
}

function shellNotes(
  syntax: SanitizedCommandShellConfig["syntax"],
  configuredKind: ConfiguredCommandShellKind
): readonly string[] {
  const autoNote = configuredKind === "auto"
    ? ["This shell was selected by automatic detection from the current local environment."]
    : [];
  if (syntax === "cmd") {
    return [
      ...autoNote,
      "Write one complete cmd.exe command line.",
      "Use cmd syntax for environment expansion, pipes, redirection, and command chaining.",
    ];
  }
  if (syntax === "powershell") {
    return [
      ...autoNote,
      "Write one complete PowerShell command line.",
      "Use PowerShell syntax for variables, pipelines, quoting, and command chaining.",
    ];
  }
  return [
    ...autoNote,
    "Write one complete POSIX shell command line.",
    "Use POSIX shell syntax for quoting, environment expansion, pipes, redirection, and command chaining.",
  ];
}
