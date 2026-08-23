import { existsSync } from "node:fs";
import path from "node:path";
import type {
  ConfiguredCommandShellKind,
  SanitizedCommandShellConfig,
  SanitizedCommandShellOption,
  SanitizedRuntimeEnvironmentTool,
} from "../../domain/config/index.js";
import { optionalString } from "./settings-utils.js";

export type ResolvedCommandShellKind = Exclude<ConfiguredCommandShellKind, "auto">;

export function detectCommandShellOptions(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>
): readonly SanitizedCommandShellOption[] {
  const cmd = platform === "win32"
    ? firstExistingPath(optionalString(env.ComSpec), optionalString(env.COMSPEC), knownWindowsSystemPath("cmd.exe", env)) ?? "cmd.exe"
    : undefined;
  const powershell = platform === "win32"
    ? firstExistingPath(findExecutableInPath("powershell.exe", platform, env), knownWindowsPowerShellPath(env)) ?? "powershell.exe"
    : findExecutableInPath("powershell", platform, env);
  const pwsh = firstExistingPath(
    optionalString(env.SYNECH_PWSH_PATH),
    findExecutableInPath(platform === "win32" ? "pwsh.exe" : "pwsh", platform, env)
  );
  const gitBash = platform === "win32" ? windowsGitBashExecutable(env) : undefined;
  const bash = platform === "win32"
    ? gitBash
    : firstExistingPath(
        optionalString(env.SHELL)?.endsWith("/bash") === true ? optionalString(env.SHELL) : undefined,
        findExecutableInPath("bash", platform, env)
      );
  const sh = platform === "win32"
    ? undefined
    : firstExistingPath(
        optionalString(env.SHELL),
        findExecutableInPath("sh", platform, env)
      );
  return [
    commandShellOption("cmd", "Windows Command Prompt", "cmd", cmd, platform === "win32" ? undefined : "cmd.exe is only available on Windows."),
    commandShellOption("powershell", "Windows PowerShell", "powershell", powershell, powershell === undefined ? "PowerShell was not found on PATH." : undefined),
    commandShellOption("pwsh", "PowerShell", "powershell", pwsh, pwsh === undefined ? "PowerShell 7 (pwsh) was not found on PATH." : undefined),
    commandShellOption("bash", platform === "win32" ? "Git Bash" : "Bash", "posix", bash, platform === "win32"
      ? "Git Bash was not found. WSL bash is intentionally not treated as Git Bash."
      : "bash was not found on PATH."),
    commandShellOption("sh", "POSIX sh", "posix", sh, sh === undefined ? "sh was not found on PATH." : undefined),
  ];
}

export function detectRuntimeEnvironmentTools(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>
): readonly SanitizedRuntimeEnvironmentTool[] {
  const node = firstExistingPath(
    optionalString(env.SYNECH_NODE_PATH),
    optionalString(env.CLAUDE_CODE_NODE_PATH),
    nodeExecutableFromCurrentProcess(),
    findExecutableInPath(platform === "win32" ? "node.exe" : "node", platform, env)
  );
  const python = firstExistingPath(
    optionalString(env.SYNECH_PYTHON_PATH),
    optionalString(env.CLAUDE_CODE_PYTHON_PATH),
    findExecutableInPath(platform === "win32" ? "python.exe" : "python3", platform, env),
    findExecutableInPath(platform === "win32" ? "py.exe" : "python", platform, env)
  );
  const gitBash = platform === "win32" ? windowsGitBashExecutable(env) : undefined;
  return [
    runtimeTool("node", "Node.js", "JavaScript runtime for package managers, scripts, and local servers.", node, "Node.js was not found on PATH."),
    runtimeTool("python", "Python", "Python runtime for scripts, automation, and data processing.", python, "Python was not found on PATH."),
    runtimeTool("git-bash", "Git Bash", "Git-provided Bash shell for POSIX command lines on Windows.", gitBash, platform === "win32"
      ? "Git Bash was not found in configured or standard Git install locations."
      : "Git Bash is only relevant on Windows."),
  ];
}

export function defaultShellKind(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  availableShells: readonly SanitizedCommandShellOption[]
): ResolvedCommandShellKind {
  if (platform === "win32") {
    if (usePowerShellOnWindows(env)) {
      return "powershell";
    }
    if (isShellAvailable(availableShells, "bash")) return "bash";
    if (isShellAvailable(availableShells, "pwsh")) return "pwsh";
    if (isShellAvailable(availableShells, "powershell")) return "powershell";
    return "cmd";
  }
  const shell = optionalString(env.SHELL);
  return shell?.endsWith("/bash") === true || shell === "bash" ? "bash" : "sh";
}

export function defaultExecutable(
  kind: ResolvedCommandShellKind,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  availableShells: readonly SanitizedCommandShellOption[]
): string {
  const detected = availableShells.find((option) => option.kind === kind && option.availability === "available")?.executable;
  if (detected !== undefined) {
    return detected;
  }
  if (kind === "cmd") {
    return optionalString(env.ComSpec) ?? optionalString(env.COMSPEC) ?? "cmd.exe";
  }
  if (kind === "powershell") {
    return "powershell.exe";
  }
  if (kind === "pwsh") {
    return "pwsh";
  }
  if (kind === "bash") {
    return platform === "win32"
      ? windowsGitBashExecutable(env) ?? "bash.exe"
      : (optionalString(env.SHELL)?.endsWith("/bash") === true ? env.SHELL! : "bash");
  }
  return platform === "win32" ? "sh.exe" : optionalString(env.SHELL) ?? "/bin/sh";
}

function commandShellOption(
  kind: ResolvedCommandShellKind,
  label: string,
  syntax: SanitizedCommandShellConfig["syntax"],
  executable: string | undefined,
  missingReason: string | undefined
): SanitizedCommandShellOption {
  return {
    kind,
    label,
    executable,
    syntax,
    availability: executable === undefined ? "missing" : "available",
    reason: executable === undefined ? missingReason : undefined,
  };
}

function runtimeTool(
  id: SanitizedRuntimeEnvironmentTool["id"],
  label: string,
  description: string,
  executable: string | undefined,
  missingReason: string
): SanitizedRuntimeEnvironmentTool {
  return {
    id,
    label,
    description,
    executable,
    availability: executable === undefined ? "missing" : "available",
    reason: executable === undefined ? missingReason : undefined,
  };
}

function usePowerShellOnWindows(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.SYNECH_USE_POWERSHELL_TOOL === "1";
}

function isShellAvailable(
  shells: readonly SanitizedCommandShellOption[],
  kind: ResolvedCommandShellKind
): boolean {
  return shells.some((shell) => shell.kind === kind && shell.availability === "available");
}

function windowsGitBashExecutable(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const configured = optionalString(env.SYNECH_GIT_BASH_PATH) ?? optionalString(env.CLAUDE_CODE_GIT_BASH_PATH) ?? optionalString(env.GIT_BASH_PATH);
  if (configured !== undefined) {
    return existsSync(configured) ? configured : undefined;
  }
  return [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].find((candidate) => existsSync(candidate));
}

function nodeExecutableFromCurrentProcess(): string | undefined {
  const executable = optionalString(process.execPath);
  if (executable === undefined || !path.basename(executable).toLowerCase().startsWith("node")) {
    return undefined;
  }
  return executable;
}

function firstExistingPath(...candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findExecutableInPath(
  executableName: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  const pathValue = optionalString(env.Path) ?? optionalString(env.PATH);
  if (pathValue === undefined) {
    return undefined;
  }
  const hasExtension = path.extname(executableName).length > 0;
  const pathExt = platform === "win32"
    ? (optionalString(env.PATHEXT)?.split(";").filter((item) => item.trim().length > 0) ?? [".COM", ".EXE", ".BAT", ".CMD"])
    : [""];
  const names = platform === "win32" && !hasExtension
    ? pathExt.map((extension) => `${executableName}${extension.toLowerCase()}`)
    : [executableName];
  const pathApi = platform === "win32" ? path.win32 : path;
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const directory of pathValue.split(delimiter).filter((item) => item.trim().length > 0)) {
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function knownWindowsSystemPath(executable: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const systemRoot = optionalString(env.SystemRoot) ?? "C:\\Windows";
  return path.win32.join(systemRoot, "System32", executable);
}

function knownWindowsPowerShellPath(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const systemRoot = optionalString(env.SystemRoot) ?? "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
