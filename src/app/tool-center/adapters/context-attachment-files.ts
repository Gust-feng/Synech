import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isLikelyBinaryPath,
  MAX_LOCAL_WORKSPACE_FILE_BYTES,
  shouldSkipEntry,
  truncateText,
} from "./local-workspace-common.js";

export const MAX_LIST_ENTRIES = 200;
export const MAX_LIST_OFFSET = 10_000;
export const DEFAULT_LIST_DEPTH = 1;
export const MAX_LIST_DEPTH = 3;
export const MAX_SEARCH_MATCHES = 80;
export const MAX_SEARCH_OFFSET = 10_000;

const MAX_SKIPPED_SAMPLES = 8;

export type DirectoryEntry = {
  readonly path: string;
  readonly name: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly bytes?: number;
  readonly depth: number;
};

export type SearchMatch = {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
};

export type SearchFacts = {
  searchedFiles: number;
  skippedFiles: number;
  skippedBinaryFiles: number;
  skippedTooLargeFiles: number;
  skippedUnreadableFiles: number;
  skippedDirectories: number;
  skippedOtherEntries: number;
  skippedSamples: {
    readonly path: string;
    readonly reason: string;
    readonly bytes?: number;
    readonly errorCode?: string;
  }[];
};

export async function listDirectoryTree(input: {
  readonly absolutePath: string;
  readonly rootAbsolutePath: string;
  readonly maxDepth: number;
  readonly limit: number;
  readonly offset: number;
}): Promise<{
  readonly entries: readonly DirectoryEntry[];
  readonly totalEntries: number;
  readonly unreadableDirectories: number;
  readonly unreadableSamples: readonly { readonly path: string; readonly errorCode?: string }[];
  readonly truncated: boolean;
  readonly hasMoreAfter: boolean;
  readonly nextOffset?: number;
}> {
  const entries: DirectoryEntry[] = [];
  const unreadableSamples: { path: string; errorCode?: string }[] = [];
  let totalEntries = 0;
  let unreadableDirectories = 0;

  async function visit(directory: string, currentDepth: number): Promise<void> {
    if (currentDepth >= input.maxDepth) {
      return;
    }
    const children = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      unreadableDirectories += 1;
      pushUnreadableDirectorySample(input.rootAbsolutePath, directory, error, unreadableSamples);
      return undefined;
    });
    if (children === undefined) {
      return;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absoluteChild = path.join(directory, child.name);
      const entryDepth = currentDepth + 1;
      const stat = await fs.stat(absoluteChild).catch(() => undefined);
      const entryIndex = totalEntries;
      totalEntries += 1;
      if (entryIndex >= input.offset && entries.length < input.limit) {
        entries.push({
          path: toAttachmentRelative(input.rootAbsolutePath, absoluteChild),
          name: child.name,
          kind: directoryEntryKind(child),
          bytes: stat?.size,
          depth: entryDepth,
        });
      }
      if (child.isDirectory()) {
        await visit(absoluteChild, entryDepth);
      }
    }
  }

  await visit(input.absolutePath, 0);
  const hasMoreAfter = totalEntries > input.offset + entries.length;
  return {
    entries,
    totalEntries,
    unreadableDirectories,
    unreadableSamples,
    truncated: hasMoreAfter,
    hasMoreAfter,
    nextOffset: hasMoreAfter ? input.offset + entries.length : undefined,
  };
}

export function boundedContinuationOffset(input: {
  readonly hasMoreAfter: boolean;
  readonly nextOffset?: number;
  readonly maxOffset: number;
}): {
  readonly hasMoreAfter: boolean;
  readonly nextOffset?: number;
  readonly reachedOffsetCeiling: boolean;
} {
  const nextOffset = input.hasMoreAfter && input.nextOffset !== undefined && input.nextOffset <= input.maxOffset
    ? input.nextOffset
    : undefined;
  return {
    hasMoreAfter: input.hasMoreAfter,
    nextOffset,
    reachedOffsetCeiling: input.hasMoreAfter && nextOffset === undefined,
  };
}

export async function searchPath(input: {
  readonly absolutePath: string;
  readonly rootAbsolutePath: string;
  readonly normalizedQuery: string;
  readonly limit: number;
  readonly matches: SearchMatch[];
  readonly facts: SearchFacts;
  readonly isRoot?: boolean;
}): Promise<void> {
  if (input.matches.length >= input.limit) {
    return;
  }
  const isRoot = input.isRoot ?? true;
  const stat = await fs.stat(input.absolutePath).catch((error: unknown) => {
    if (isRoot) {
      throw error;
    }
    recordSkipped(input, "unreadable", undefined, error);
    return undefined;
  });
  if (stat === undefined) {
    return;
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(input.absolutePath, { withFileTypes: true }).catch((error: unknown) => {
      if (isRoot) {
        throw error;
      }
      recordSkipped(input, "unreadable_directory", undefined, error);
      return undefined;
    });
    if (entries === undefined) {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (input.matches.length >= input.limit) {
        return;
      }
      const childPath = path.join(input.absolutePath, entry.name);
      if (shouldSkipEntry(entry.name)) {
        recordSkipped({
          ...input,
          absolutePath: childPath,
        }, entry.isDirectory() ? "skipped_directory" : "skipped_entry");
        continue;
      }
      await searchPath({
        ...input,
        absolutePath: childPath,
        isRoot: false,
      });
    }
    return;
  }
  if (!stat.isFile()) {
    recordSkipped(input, "not_file", stat.size);
    return;
  }
  if (stat.size > MAX_LOCAL_WORKSPACE_FILE_BYTES) {
    recordSkipped(input, "too_large", stat.size);
    return;
  }
  if (isLikelyBinaryPath(input.absolutePath) || await fileHasNulByte(input.absolutePath, stat.size)) {
    recordSkipped(input, "binary", stat.size);
    return;
  }
  const raw = await fs.readFile(input.absolutePath, "utf8").catch((error: unknown) => {
    recordSkipped(input, "unreadable", stat.size, error);
    return undefined;
  });
  if (raw === undefined) {
    return;
  }
  input.facts.searchedFiles += 1;
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length && input.matches.length < input.limit; index += 1) {
    const line = lines[index] ?? "";
    if (line.toLowerCase().includes(input.normalizedQuery)) {
      input.matches.push({
        path: toAttachmentRelative(input.rootAbsolutePath, input.absolutePath),
        line: index + 1,
        preview: truncateText(line.trim(), 500),
      });
    }
  }
}

export function createSearchFacts(): SearchFacts {
  return {
    searchedFiles: 0,
    skippedFiles: 0,
    skippedBinaryFiles: 0,
    skippedTooLargeFiles: 0,
    skippedUnreadableFiles: 0,
    skippedDirectories: 0,
    skippedOtherEntries: 0,
    skippedSamples: [],
  };
}

export async function fileHasNulByte(filePath: string, size: number): Promise<boolean> {
  const handle = await fs.open(filePath, "r").catch(() => undefined);
  if (handle === undefined) {
    return false;
  }
  try {
    const probe = Buffer.alloc(Math.min(size, 8192));
    await handle.read(probe, 0, probe.length, 0);
    return probe.includes(0);
  } finally {
    await handle.close();
  }
}

function recordSkipped(
  input: {
    readonly absolutePath: string;
    readonly rootAbsolutePath: string;
    readonly facts: SearchFacts;
  },
  reason: string,
  bytes?: number,
  error?: unknown
): void {
  if (reason === "binary") input.facts.skippedBinaryFiles += 1;
  if (reason === "too_large") input.facts.skippedTooLargeFiles += 1;
  if (reason === "unreadable") input.facts.skippedUnreadableFiles += 1;
  if (reason === "skipped_directory" || reason === "unreadable_directory") {
    input.facts.skippedDirectories += 1;
  } else if (reason === "not_file") {
    input.facts.skippedOtherEntries += 1;
  } else {
    input.facts.skippedFiles += 1;
  }
  if (input.facts.skippedSamples.length >= MAX_SKIPPED_SAMPLES) {
    return;
  }
  input.facts.skippedSamples.push({
    path: toAttachmentRelative(input.rootAbsolutePath, input.absolutePath),
    reason,
    bytes,
    errorCode: nodeErrorCode(error),
  });
}

function pushUnreadableDirectorySample(
  rootAbsolutePath: string,
  absolutePath: string,
  error: unknown,
  samples: { path: string; errorCode?: string }[]
): void {
  if (samples.length >= MAX_SKIPPED_SAMPLES) {
    return;
  }
  samples.push({
    path: toAttachmentRelative(rootAbsolutePath, absolutePath),
    errorCode: nodeErrorCode(error),
  });
}

function directoryEntryKind(entry: import("node:fs").Dirent): DirectoryEntry["kind"] {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function toAttachmentRelative(rootAbsolutePath: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(rootAbsolutePath), absolutePath);
  return toPortableRelativePath(relative.length === 0 ? "." : relative);
}

function toPortableRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}
