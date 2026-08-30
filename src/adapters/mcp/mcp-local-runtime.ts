import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PRODUCT_MCP_BIN_ENVIRONMENT_VARIABLE } from "../../platform/product-identity.js";
import { resolveProductPaths } from "../../platform/storage/index.js";

export type McpExecutableResolutionSource = "product" | "common" | "path" | "absolute";
export type McpExecutableManagementAction = "none" | "copied" | "wrapped";
export type McpExecutableInstallStatus =
  | "ready"
  | "installed"
  | "not_found"
  | "unsupported"
  | "install_failed";

export type McpExecutableResolution = {
  readonly command: string;
  readonly executable?: string;
  readonly source?: McpExecutableResolutionSource;
  readonly managedAction?: McpExecutableManagementAction;
  readonly managedDirectories: readonly string[];
  readonly commonDirectories: readonly string[];
  readonly recommendedInstallPath?: string;
};

export type McpExecutableInstallResult = McpExecutableResolution & {
  readonly status: McpExecutableInstallStatus;
  readonly installable: boolean;
  readonly installer?: McpExecutableInstallerKind;
  readonly errorSummary?: string;
};

type McpExecutableInstallerKind = "uv" | "node" | "pnpm" | "bun";

export type McpLocalRuntimeOptions = {
  /** Host-resolved canonical directory. Explicit SYNECH_MCP_BIN still overrides it. */
  readonly managedBinDirectory?: string;
};

export function resolveMcpExecutable(
  command: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: McpLocalRuntimeOptions = {},
): McpExecutableResolution {
  const normalized = command.trim();
  const managedDirectories = mcpManagedRuntimeDirectories(env, options);
  const commonDirectories = mcpCommonRuntimeDirectories(env);
  const recommendedInstallPath = recommendedMcpInstallPath(normalized, managedDirectories);
  if (normalized.length === 0) {
    return { command: normalized, managedDirectories, commonDirectories, recommendedInstallPath };
  }

  if (isExplicitCommandPath(normalized)) {
    const executable = executableCandidates(normalized, env).find((candidate) => existsSync(candidate));
    return {
      command: normalized,
      executable,
      source: executable === undefined ? undefined : "absolute",
      managedDirectories,
      commonDirectories,
      recommendedInstallPath,
    };
  }

  const managed = findCommandInDirectories(normalized, managedDirectories, env);
  if (managed !== undefined) {
    return {
      command: normalized,
      executable: managed,
      source: "product",
      managedDirectories,
      commonDirectories,
      recommendedInstallPath,
    };
  }

  const common = findCommandInDirectories(normalized, commonDirectories, env);
  if (common !== undefined) {
    return {
      command: normalized,
      executable: common,
      source: "common",
      managedDirectories,
      commonDirectories,
      recommendedInstallPath,
    };
  }

  const pathResolved = findCommandInDirectories(normalized, pathEnvironmentEntries(env), env);
  return {
    command: normalized,
    executable: pathResolved,
    source: pathResolved === undefined ? undefined : "path",
    managedDirectories,
    commonDirectories,
    recommendedInstallPath,
  };
}

export async function ensureManagedMcpExecutable(
  command: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: McpLocalRuntimeOptions = {},
): Promise<McpExecutableResolution> {
  const resolution = resolveMcpExecutable(command, env, options);
  if (
    resolution.executable === undefined ||
    resolution.source === "product" ||
    (isExplicitCommandPath(resolution.command) && installerForMcpCommand(resolution.command) === undefined)
  ) {
    return { ...resolution, managedAction: "none" };
  }

  const managedDirectory = resolution.managedDirectories[0];
  if (managedDirectory === undefined) {
    return { ...resolution, managedAction: "none" };
  }

  const managed = await createManagedExecutableEntry({
    command: resolution.command,
    sourceExecutable: resolution.executable,
    managedDirectory,
    env,
  });
  return {
    ...resolution,
    executable: managed.executable,
    source: "product",
    managedAction: managed.action,
  };
}

export async function installMcpExecutable(
  command: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: McpLocalRuntimeOptions = {},
): Promise<McpExecutableInstallResult> {
  const ensured = await ensureManagedMcpExecutable(command, env, options);
  const installer = installerForMcpCommand(ensured.command);
  if (ensured.executable !== undefined) {
    return {
      ...ensured,
      status: "ready",
      installable: installer !== undefined,
      installer,
    };
  }
  if (installer === undefined) {
    return {
      ...ensured,
      status: "unsupported",
      installable: false,
      errorSummary: "该运行文件暂不支持自动安装。",
    };
  }

  const install = installPlanForMcpExecutable(installer, env, options);
  if (install === undefined) {
    return {
      ...ensured,
      status: "unsupported",
      installable: false,
      installer,
      errorSummary: "当前系统不支持自动安装该运行文件。",
    };
  }

  const installed = await runInstallCommand(install, env, options);
  if (!installed.ok) {
    return {
      ...ensured,
      status: "install_failed",
      installable: true,
      installer,
      errorSummary: installed.errorSummary,
    };
  }

  const afterInstall = await ensureManagedMcpExecutable(command, env, options);
  return {
    ...afterInstall,
    status: afterInstall.executable === undefined ? "not_found" : "installed",
    installable: true,
    installer,
    errorSummary: afterInstall.executable === undefined ? "安装完成后仍未找到运行文件。" : undefined,
  };
}

export function mcpRuntimePathEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: McpLocalRuntimeOptions = {},
): Record<string, string> {
  const pathEntries = uniqueStrings([
    ...mcpManagedRuntimeDirectories(env, options),
    ...mcpCommonRuntimeDirectories(env).filter((directory) => existsSync(directory)),
    ...pathEnvironmentEntries(env),
  ]);
  if (pathEntries.length === 0) {
    return {};
  }
  const joined = pathEntries.join(path.delimiter);
  return process.platform === "win32" ? { PATH: joined, Path: joined } : { PATH: joined };
}

export function mcpManagedRuntimeDirectories(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: McpLocalRuntimeOptions = {},
): readonly string[] {
  const configured = splitPathList(env[PRODUCT_MCP_BIN_ENVIRONMENT_VARIABLE]);
  if (configured.length > 0) return uniqueStrings(configured);
  return [path.resolve(
    options.managedBinDirectory ?? resolveProductPaths({ env }).state.runtimeTools.mcp.bin,
  )];
}

async function createManagedExecutableEntry(input: {
  readonly command: string;
  readonly sourceExecutable: string;
  readonly managedDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<{ readonly executable: string; readonly action: McpExecutableManagementAction }> {
  await mkdir(input.managedDirectory, { recursive: true });
  const target = managedExecutablePath(input.command, input.sourceExecutable, input.managedDirectory, input.env);
  if (existsSync(target)) {
    return { executable: target, action: "none" };
  }

  if (canCopyExecutable(input.sourceExecutable)) {
    await copyFile(input.sourceExecutable, target);
    if (process.platform !== "win32") {
      await chmod(target, 0o755);
    }
    return { executable: target, action: "copied" };
  }

  await writeFile(target, managedExecutableWrapperSource(input.sourceExecutable), "utf8");
  if (process.platform !== "win32") {
    await chmod(target, 0o755);
  }
  return { executable: target, action: "wrapped" };
}

function managedExecutablePath(
  command: string,
  sourceExecutable: string,
  managedDirectory: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  const commandName = path.basename(command);
  const commandExtension = path.extname(commandName);
  const commandBaseName = commandExtension.length === 0
    ? commandName
    : commandName.slice(0, -commandExtension.length);
  const sourceExtension = path.extname(sourceExecutable);
  if (process.platform === "win32") {
    const extension = scriptExecutableExtensions().has(sourceExtension.toLowerCase())
      ? ".cmd"
      : commandExtension || sourceExtension || ".exe";
    return path.join(managedDirectory, `${commandBaseName}${extension}`);
  }
  const targetName = commandExtension.length === 0 ? commandName : `${commandBaseName}${commandExtension}`;
  return executableCandidates(path.join(managedDirectory, targetName), env)[0] ?? path.join(managedDirectory, targetName);
}

function canCopyExecutable(executable: string): boolean {
  const extension = path.extname(executable).toLowerCase();
  if (scriptExecutableExtensions().has(extension)) {
    return false;
  }
  return process.platform === "win32" ? extension === ".exe" || extension === ".com" : true;
}

function managedExecutableWrapperSource(sourceExecutable: string): string {
  if (process.platform === "win32") {
    const escapedExecutable = sourceExecutable.replace(/%/gu, "%%");
    const extension = path.extname(sourceExecutable).toLowerCase();
    const command = extension === ".ps1"
      ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${escapedExecutable}" %*`
      : `call "${escapedExecutable}" %*`;
    return [
      "@echo off",
      "setlocal",
      command,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `exec ${shellQuote(sourceExecutable)} "$@"`,
    "",
  ].join("\n");
}

function scriptExecutableExtensions(): ReadonlySet<string> {
  return new Set([".bat", ".cmd", ".ps1"]);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function installerForMcpCommand(command: string): McpExecutableInstallerKind | undefined {
  const normalized = path.basename(command).replace(/\.(exe|cmd|bat|ps1)$/iu, "").toLowerCase();
  if (normalized === "uv" || normalized === "uvx") return "uv";
  if (normalized === "node" || normalized === "npm" || normalized === "npx") return "node";
  if (normalized === "pnpm" || normalized === "pnpx") return "pnpm";
  if (normalized === "bun" || normalized === "bunx") return "bun";
  return undefined;
}

// Pinned installer versions verified against upstream releases; bump together
// with a re-check of the upstream install script contract.
const PINNED_UV_INSTALLER_VERSION = "0.12.7";
const PINNED_BUN_INSTALLER_VERSION = "1.4.0";

function installPlanForMcpExecutable(
  installer: McpExecutableInstallerKind,
  env: Readonly<Record<string, string | undefined>>,
  options: McpLocalRuntimeOptions,
): { readonly command: string; readonly args: readonly string[] } | undefined {
  if (installer === "node") {
    if (process.platform !== "win32") return undefined;
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements"],
    };
  }
  if (installer === "uv") {
    if (process.platform === "win32") {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm https://astral.sh/uv/${PINNED_UV_INSTALLER_VERSION}/install.ps1 | iex`],
      };
    }
    return {
      command: "sh",
      args: ["-c", `curl -LsSf https://astral.sh/uv/${PINNED_UV_INSTALLER_VERSION}/install.sh | sh`],
    };
  }
  if (installer === "pnpm") {
    const npm = resolveMcpExecutable("npm", env, options).executable;
    return npm === undefined ? undefined : { command: npm, args: ["install", "-g", "pnpm"] };
  }
  if (installer === "bun") {
    if (process.platform === "win32") {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `& ([scriptblock]::Create((irm https://bun.sh/install.ps1))) -Version ${PINNED_BUN_INSTALLER_VERSION}`],
      };
    }
    return {
      command: "sh",
      args: ["-c", `curl -fsSL https://bun.sh/install | bash -s "bun-v${PINNED_BUN_INSTALLER_VERSION}"`],
    };
  }
  return undefined;
}

function runInstallCommand(
  install: { readonly command: string; readonly args: readonly string[] },
  env: Readonly<Record<string, string | undefined>>,
  options: McpLocalRuntimeOptions,
): Promise<{ readonly ok: boolean; readonly errorSummary?: string }> {
  return new Promise((resolve) => {
    const child = spawn(install.command, [...install.args], {
      env: { ...process.env, ...env, ...mcpRuntimePathEnvironment(env, options) },
      windowsHide: true,
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ ok: false, errorSummary: "安装超时。" });
    }, 120_000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve({ ok: false, errorSummary: "安装进程启动失败。" });
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === 0
        ? { ok: true }
        : { ok: false, errorSummary: "安装未完成。" });
    });
  });
}

export function mcpCommonRuntimeDirectories(
  env: Readonly<Record<string, string | undefined>> = process.env
): readonly string[] {
  const homeDirectory = userHomeDirectory(env);
  const localAppData = env.LOCALAPPDATA;
  const appData = env.APPDATA;
  const programData = env.ProgramData ?? env.PROGRAMDATA;
  const programFiles = env.ProgramFiles;
  const programFilesX86 = env["ProgramFiles(x86)"];
  return uniqueStrings([
    path.join(homeDirectory, ".local", "bin"),
    path.join(homeDirectory, ".bun", "bin"),
    path.join(homeDirectory, ".cargo", "bin"),
    path.join(homeDirectory, "scoop", "shims"),
    appData === undefined ? undefined : path.join(appData, "npm"),
    localAppData === undefined ? undefined : path.join(localAppData, "pnpm"),
    localAppData === undefined ? undefined : path.join(localAppData, "Programs", "Python", "Launcher"),
    localAppData === undefined ? undefined : path.join(localAppData, "Programs", "nodejs"),
    programData === undefined ? undefined : path.join(programData, "chocolatey", "bin"),
    programFiles === undefined ? undefined : path.join(programFiles, "nodejs"),
    programFilesX86 === undefined ? undefined : path.join(programFilesX86, "nodejs"),
  ]);
}

function findCommandInDirectories(
  command: string,
  directories: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  return directories
    .flatMap((directory) => executableCandidates(path.join(directory, command), env))
    .find((candidate) => existsSync(candidate));
}

function recommendedMcpInstallPath(command: string, managedDirectories: readonly string[]): string | undefined {
  if (command.length === 0 || isExplicitCommandPath(command)) {
    return undefined;
  }
  const firstDirectory = managedDirectories[0];
  if (firstDirectory === undefined) {
    return undefined;
  }
  const extension = process.platform === "win32" && path.extname(command).length === 0 ? ".exe" : "";
  return path.join(firstDirectory, `${command}${extension}`);
}

function executableCandidates(
  commandPath: string,
  env: Readonly<Record<string, string | undefined>>
): readonly string[] {
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((item) => item.length > 0)
    : [""];
  return process.platform === "win32" && path.extname(commandPath).length > 0
    ? [commandPath]
    : extensions.map((extension) => `${commandPath}${extension}`);
}

function pathEnvironmentEntries(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return splitPathList(env.PATH ?? env.Path);
}

function userHomeDirectory(env: Readonly<Record<string, string | undefined>>): string {
  const userProfile = env.USERPROFILE?.trim();
  if (userProfile !== undefined && userProfile.length > 0) {
    return userProfile;
  }
  const home = env.HOME?.trim();
  if (home !== undefined && home.length > 0) {
    return home;
  }
  return os.homedir();
}

function splitPathList(value: string | undefined): readonly string[] {
  return value?.split(path.delimiter).map((item) => item.trim()).filter((item) => item.length > 0) ?? [];
}

function isExplicitCommandPath(value: string): boolean {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value.trim().length > 0))];
}
