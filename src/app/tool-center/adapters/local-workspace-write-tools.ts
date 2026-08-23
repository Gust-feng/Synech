import { promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ToolExecutor } from "../../../domain/tools/index.js";
import {
  asRecord,
  authorizedPathFacts,
  decodeUtf8Text,
  DEFAULT_LOCAL_WORKSPACE_ROOT,
  MAX_LOCAL_WORKSPACE_FILE_BYTES,
  requireText,
  resolveAuthorizedWorkspacePath,
  sha256Hex,
  stringOrFallback,
  throwIfAborted,
  type LocalWorkspaceToolOptions,
} from "./local-workspace-common.js";
import {
  assertSandboxAllowed,
  createLocalWorkspaceSandboxPolicy,
  sandboxRequest,
} from "./local-workspace-sandbox.js";
import { InMemoryLocalWorkspaceMutationCoordinator } from "./local-workspace-mutation-coordinator.js";

export const EDIT_FILE_DIFF_MAX_INPUT_CHARS = 256_000;

const EDIT_FILE_DIFF_TIMEOUT_MS = 100;

export type EditFileDiffFact =
  | Readonly<{ status: "available"; unifiedDiff: string }>
  | Readonly<{ status: "unchanged" }>
  | Readonly<{
      status: "unavailable";
      reason: "input_limit_exceeded" | "timeout" | "generation_failed";
      beforeChars: number;
      afterChars: number;
      maxInputChars: number;
      timeoutMs: number;
      errorName?: string;
      errorMessage?: string;
    }>;

export function createLocalWriteFileTool(
  rootDirectory = DEFAULT_LOCAL_WORKSPACE_ROOT,
  options: LocalWorkspaceToolOptions = {},
): ToolExecutor {
  const sandboxPolicy = options.sandboxPolicy ?? createLocalWorkspaceSandboxPolicy();
  const mutationCoordinator = options.mutationCoordinator ?? new InMemoryLocalWorkspaceMutationCoordinator();
  return {
    definition: {
      name: "Write",
      description: "Create or completely rewrite one UTF-8 text file; returns the resulting path, hashes, size, and diff.",
      metadata: {
        category: "filesystem",
        riskLevel: "medium",
        operationType: "read-write",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "Absolute or run-root-relative file path." },
          content: { type: "string", description: "Complete UTF-8 text content." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      throwIfAborted(context.abortSignal);
      const record = asRecord(input);
      const content = requireText(record.content, "content", { allowEmpty: true });
      const target = await resolveAuthorizedWorkspacePath(
        rootDirectory,
        stringOrFallback(record.path, ""),
        "write",
        context,
        options.pathAuthorization,
      );
      const pathFacts = authorizedPathFacts(target);
      return mutationCoordinator.run(target.absolutePath, async () => {
        let original: string | undefined;
        try {
          const existing = await fs.stat(target.absolutePath);
          if (!existing.isFile()) throw new Error(`Write expects a file path: ${target.relativePath}`);
          if (existing.size > MAX_LOCAL_WORKSPACE_FILE_BYTES) {
            throw new Error(`File is too large to rewrite safely: ${target.relativePath}`);
          }
          const current = await readEditableUtf8TextFile(target.absolutePath, target.relativePath);
          if (current.bytes.length > MAX_LOCAL_WORKSPACE_FILE_BYTES) {
            throw new Error(`File is too large to rewrite safely: ${target.relativePath}`);
          }
          original = current.text;
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        }

        const changed = original === undefined || original !== content;
        assertSandboxAllowed(sandboxPolicy, sandboxRequest("write", target.rootDirectory, target.relativePath, {
          bytes: Buffer.byteLength(content, "utf8"),
        }));
        if (changed) {
          await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
          await fs.writeFile(target.absolutePath, content, "utf8");
        }
        const written = Buffer.from(content, "utf8");
        return {
          refId: `workspace:file:${target.relativePath}`,
          path: target.relativePath,
          ...pathFacts,
          operation: original === undefined ? "create" : "write",
          changed,
          beforeHash: original === undefined ? undefined : sha256Hex(original),
          afterHash: sha256Hex(content),
          bytes: written.length,
          diff: editFileDiffFact(target.relativePath, original ?? "", content),
        };
      });
    },
  };
}

export function createLocalEditFileTool(
  rootDirectory = DEFAULT_LOCAL_WORKSPACE_ROOT,
  options: LocalWorkspaceToolOptions = {},
): ToolExecutor {
  const sandboxPolicy = options.sandboxPolicy ?? createLocalWorkspaceSandboxPolicy();
  const mutationCoordinator = options.mutationCoordinator ?? new InMemoryLocalWorkspaceMutationCoordinator();
  return {
    definition: {
      name: "Edit",
      description: "Replace exact text in one UTF-8 file. Every oldText must match exactly once; returns the resulting path, hashes, size, and diff.",
      metadata: {
        category: "filesystem",
        riskLevel: "medium",
        operationType: "read-write",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "Absolute or run-root-relative file path." },
          edits: {
            type: "array",
            minItems: 1,
            description: "Exact replacements validated together before the file is changed.",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", minLength: 1, description: "Exact existing text; it must occur once." },
                newText: { type: "string", description: "Replacement text." },
              },
              required: ["oldText", "newText"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "edits"],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      throwIfAborted(context.abortSignal);
      const record = asRecord(input);
      const edits = parseExactEdits(record.edits);
      const target = await resolveAuthorizedWorkspacePath(
        rootDirectory,
        stringOrFallback(record.path, ""),
        "edit",
        context,
        options.pathAuthorization,
      );
      const pathFacts = authorizedPathFacts(target);
      return mutationCoordinator.run(target.absolutePath, async () => {
        assertSandboxAllowed(sandboxPolicy, sandboxRequest("edit", target.rootDirectory, target.relativePath));
        const stat = await fs.stat(target.absolutePath);
        if (!stat.isFile()) throw new Error(`Edit expects a file path: ${target.relativePath}`);
        if (stat.size > MAX_LOCAL_WORKSPACE_FILE_BYTES) {
          throw new Error(`File is too large to edit safely: ${target.relativePath}`);
        }

        const current = await readEditableUtf8TextFile(target.absolutePath, target.relativePath);
        if (current.bytes.length > MAX_LOCAL_WORKSPACE_FILE_BYTES) {
          throw new Error(`File is too large to edit safely: ${target.relativePath}`);
        }
        const original = current.text;
        const located = locateExactEdits(original, edits, target.relativePath);
        assertNoOverlappingEdits(located, target.relativePath);
        let updated = original;
        for (const edit of [...located].sort((left, right) => right.start - left.start)) {
          updated = `${updated.slice(0, edit.start)}${edit.newText}${updated.slice(edit.end)}`;
        }
        const changed = updated !== original;
        throwIfAborted(context.abortSignal);
        if (changed) {
          assertSandboxAllowed(sandboxPolicy, sandboxRequest("edit", target.rootDirectory, target.relativePath, {
            bytes: Buffer.byteLength(updated, "utf8"),
          }));
          await fs.writeFile(target.absolutePath, updated, "utf8");
        }
        const written = Buffer.from(updated, "utf8");
        return {
          refId: `workspace:file:${target.relativePath}`,
          path: target.relativePath,
          ...pathFacts,
          operation: "edit",
          changed,
          replacements: changed ? located.length : 0,
          beforeHash: sha256Hex(original),
          afterHash: sha256Hex(updated),
          bytes: written.length,
          diff: editFileDiffFact(target.relativePath, original, updated),
        };
      });
    },
  };
}

type ExactEditInput = {
  readonly oldText: string;
  readonly newText: string;
};

type LocatedExactEdit = ExactEditInput & {
  readonly editIndex: number;
  readonly start: number;
  readonly end: number;
};

function parseExactEdits(value: unknown): readonly ExactEditInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("edits must be a non-empty array.");
  }
  return value.map((item, index) => {
    const record = asRecord(item);
    return {
      oldText: requireText(record.oldText, `edits[${index}].oldText`, { allowEmpty: false }),
      newText: requireText(record.newText, `edits[${index}].newText`, { allowEmpty: true }),
    };
  });
}

function locateExactEdits(
  source: string,
  edits: readonly ExactEditInput[],
  relativePath: string,
): readonly LocatedExactEdit[] {
  return edits.map((edit, index) => {
    const matches = findAllOccurrences(source, edit.oldText);
    if (matches.length !== 1) {
      throw new Error(
        `Edit replacement ${index + 1} must match exactly once in ${relativePath}; matches=${matches.length}.`,
      );
    }
    const start = matches[0]!;
    return { ...edit, editIndex: index + 1, start, end: start + edit.oldText.length };
  });
}

function assertNoOverlappingEdits(edits: readonly LocatedExactEdit[], relativePath: string): void {
  const sorted = [...edits].sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (previous.end > current.start) {
      throw new Error(
        `Edit replacements overlap in ${relativePath}; previous=${previous.editIndex}, current=${current.editIndex}.`,
      );
    }
  }
}

function editFileDiffFact(relativePath: string, before: string, after: string): EditFileDiffFact {
  const unavailable = (
    reason: Extract<EditFileDiffFact, { readonly status: "unavailable" }>["reason"],
  ): Extract<EditFileDiffFact, { readonly status: "unavailable" }> => ({
    status: "unavailable",
    reason,
    beforeChars: before.length,
    afterChars: after.length,
    maxInputChars: EDIT_FILE_DIFF_MAX_INPUT_CHARS,
    timeoutMs: EDIT_FILE_DIFF_TIMEOUT_MS,
  });
  if (before === after) return { status: "unchanged" };
  if (before.length + after.length > EDIT_FILE_DIFF_MAX_INPUT_CHARS) {
    return unavailable("input_limit_exceeded");
  }
  try {
    const unifiedDiff = createTwoFilesPatch(
      relativePath,
      relativePath,
      before,
      after,
      undefined,
      undefined,
      { context: 3, timeout: EDIT_FILE_DIFF_TIMEOUT_MS },
    );
    return unifiedDiff === undefined
      ? unavailable("timeout")
      : { status: "available", unifiedDiff };
  } catch (error) {
    return {
      ...unavailable("generation_failed"),
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

function findAllOccurrences(source: string, search: string): readonly number[] {
  const matches: number[] = [];
  let position = 0;
  while (position <= source.length - search.length) {
    const index = source.indexOf(search, position);
    if (index === -1) break;
    matches.push(index);
    position = index + search.length;
  }
  return matches;
}

async function readEditableUtf8TextFile(
  absolutePath: string,
  relativePath: string,
): Promise<{ readonly text: string; readonly bytes: Buffer }> {
  const content = await fs.readFile(absolutePath);
  if (content.includes(0)) {
    throw new Error(`File is binary or non-text: ${relativePath}; bytes=${content.length}`);
  }
  const decoded = decodeUtf8Text(content);
  if (decoded === undefined) {
    throw new Error(`File is binary or non-text: ${relativePath}; bytes=${content.length}`);
  }
  return { text: decoded, bytes: content };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}