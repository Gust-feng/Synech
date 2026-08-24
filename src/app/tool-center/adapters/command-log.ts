import { randomUUID } from "node:crypto";
import { promises as fs, writeSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeRefToken, throwIfAborted } from "./local-workspace-common.js";

const COMMAND_LOG_REF_PREFIX = "command-log://";
const COMMAND_LOG_DIRECTORY_NAME = "synech-command-logs";
const COMMAND_LOG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u;
const COMMAND_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const COMMAND_LOG_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const activeCommandLogPaths = new Set<string>();

export type CommandLogTarget = {
  readonly id: string;
  readonly ref: string;
  readonly path: string;
};

export type CommandLogPreview = {
  readonly text: string;
  readonly chars: number;
  readonly omittedChars: number;
  readonly truncated: boolean;
};

export type LocalCommandLogReadEntry = {
  readonly refId: string;
  readonly title: string;
  readonly uri: string;
  readonly content: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
};

export async function createCommandLogTarget(commandLine: string): Promise<CommandLogTarget> {
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

export function releaseCommandLogPath(logPath: string): void {
  activeCommandLogPaths.delete(logPath);
}

export async function removeCommandLog(target: CommandLogTarget): Promise<void> {
  releaseCommandLogPath(target.path);
  await fs.unlink(target.path).catch(() => undefined);
}

export async function readLocalCommandLogRef(
  ref: string,
  request: { readonly maxLength: number; readonly abortSignal?: AbortSignal },
): Promise<LocalCommandLogReadEntry | undefined> {
  throwIfAborted(request.abortSignal);
  const target = commandLogTargetFromRef(ref);
  if (target === undefined) return undefined;
  let content: string;
  try {
    content = await fs.readFile(target.path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  throwIfAborted(request.abortSignal);
  return {
    refId: ref,
    title: `Command log ${target.id}`,
    uri: ref,
    content,
    metadata: { id: target.id },
  };
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

export function commandLogHeader(commandLine: string, cwd: string): string {
  return [
    `command: ${commandLine}`,
    `cwd: ${cwd}`,
    `createdAt: ${new Date().toISOString()}`,
    "",
  ].join("\n");
}

export function writeCommandLogHeader(fd: number | undefined, commandLine: string, cwd: string): void {
  if (fd !== undefined) writeSync(fd, commandLogHeader(commandLine, cwd));
}

export function writeCommandLogChunk(
  fd: number | undefined,
  stream: "stdout" | "stderr",
  chunk: Buffer,
): void {
  if (fd === undefined || chunk.length === 0) return;
  writeSync(fd, `\n[${stream}]\n`);
  writeSync(fd, chunk);
}

export function writeCommandLogText(
  fd: number | undefined,
  stream: "stdout" | "stderr",
  text: string,
): void {
  if (fd !== undefined && text.length > 0) writeSync(fd, `\n[${stream}]\n${text}`);
}

export async function readCommandLogPreview(logPath: string, maxChars: number): Promise<CommandLogPreview> {
  try {
    const text = await fs.readFile(logPath, "utf8");
    const preview = text.length <= maxChars ? text : text.slice(0, maxChars);
    return {
      text: preview,
      chars: text.length,
      omittedChars: Math.max(0, text.length - preview.length),
      truncated: preview.length < text.length,
    };
  } catch {
    return { text: "", chars: 0, omittedChars: 0, truncated: false };
  }
}

function commandLogTargetFromRef(ref: string): CommandLogTarget | undefined {
  if (!ref.startsWith(COMMAND_LOG_REF_PREFIX)) return undefined;
  const id = ref.slice(COMMAND_LOG_REF_PREFIX.length);
  if (!COMMAND_LOG_ID_PATTERN.test(id)) return undefined;
  return { id, ref, path: path.join(commandLogDirectory(), `${id}.log`) };
}

function commandLogDirectory(): string {
  return path.join(os.tmpdir(), COMMAND_LOG_DIRECTORY_NAME);
}

function positiveSafeIntegerOrFallback(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT";
}
