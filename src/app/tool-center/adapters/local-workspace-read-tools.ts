import type { ToolExecutor } from "../../../domain/tools/index.js";
import {
  DEFAULT_LOCAL_WORKSPACE_ROOT,
  type LocalWorkspaceToolOptions,
} from "./local-workspace-common.js";
import { createLocalWorkspaceSandboxPolicy } from "./local-workspace-sandbox.js";
import { readLocalFile } from "./file-read.js";
import {
  globLocalFiles,
  grepLocalFiles,
  MAX_GLOB_MATCHES,
  MAX_GLOB_OFFSET,
  MAX_GREP_MATCHES,
  MAX_GREP_OFFSET,
  type RipgrepSearchRunner,
} from "./file-search.js";
import {
  DEFAULT_READ_LINE_COUNT,
  DEFAULT_READ_MAX_CHARS,
  MAX_READ_LINE_COUNT,
  MIN_CHARACTER_WINDOW_CHARS,
} from "./text-window-read.js";
import type { ToolOutputTokenCounter } from "../tool-output-limits.js";

export type LocalWorkspaceReadToolOptions = LocalWorkspaceToolOptions & {
  readonly ripgrepSearch?: RipgrepSearchRunner | false;
  readonly outputTokenCounter?: ToolOutputTokenCounter;
};

export function createLocalReadFileTool(
  rootDirectory = DEFAULT_LOCAL_WORKSPACE_ROOT,
  options: LocalWorkspaceReadToolOptions = {},
): ToolExecutor {
  const sandboxPolicy = options.sandboxPolicy ?? createLocalWorkspaceSandboxPolicy();
  return {
    definition: {
      name: "Read",
      description: "Read an authorized local UTF-8 text file by absolute or run-root-relative path. Supports optional 1-based startLine/endLine windows for large or focused reads.",
      metadata: {
        category: "filesystem",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, description: "Absolute or run-root-relative file path." },
          maxLength: {
            type: "integer",
            minimum: MIN_CHARACTER_WINDOW_CHARS,
            maximum: DEFAULT_READ_MAX_CHARS,
            description: "Maximum characters to return; must be at least 3 so every truncated UTF-16 window can advance.",
          },
          startLine: { type: "integer", minimum: 1, description: "Optional 1-based first line to return." },
          endLine: {
            type: "integer",
            minimum: 1,
            description: `Optional 1-based last line to return. When omitted with startLine, returns ${DEFAULT_READ_LINE_COUNT} lines; maximum ${MAX_READ_LINE_COUNT}.`,
          },
          startChar: {
            type: "integer",
            minimum: 0,
            description: "Optional zero-based character offset for continuing a truncated text window.",
          },
        },
        required: ["path"],
        allOf: [
          { not: { required: ["startChar", "startLine"] } },
          { not: { required: ["startChar", "endLine"] } },
          { not: { required: ["maxLength", "startLine"] } },
          { not: { required: ["maxLength", "endLine"] } },
        ],
        additionalProperties: false,
      },
    },
    execute: (value, context) => readLocalFile({
      rootDirectory,
      value,
      context,
      sandboxPolicy,
      pathAuthorization: options.pathAuthorization,
      outputTokenCounter: options.outputTokenCounter,
    }),
  };
}

export function createLocalGlobTool(
  rootDirectory = DEFAULT_LOCAL_WORKSPACE_ROOT,
  options: LocalWorkspaceReadToolOptions = {},
): ToolExecutor {
  const sandboxPolicy = options.sandboxPolicy ?? createLocalWorkspaceSandboxPolicy();
  return {
    definition: {
      name: "Glob",
      description: "Find authorized local files recursively by glob pattern. Use patterns such as * or **/* to inspect directory contents, and Grep for file content.",
      metadata: {
        category: "filesystem",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", minLength: 1, description: "File glob such as **/*.ts or src/*.{js,ts}." },
          path: { type: "string", description: "Absolute or run-root-relative directory to search. Defaults to the run root." },
          limit: { type: "integer", minimum: 1, maximum: MAX_GLOB_MATCHES, description: "Maximum matching paths to return." },
          offset: { type: "integer", minimum: 0, maximum: MAX_GLOB_OFFSET, description: "Zero-based match offset for continuation." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    execute: (value, context) => globLocalFiles({
      rootDirectory,
      value,
      context,
      sandboxPolicy,
      pathAuthorization: options.pathAuthorization,
      outputTokenCounter: options.outputTokenCounter,
    }),
  };
}

export function createLocalGrepFilesTool(
  rootDirectory = DEFAULT_LOCAL_WORKSPACE_ROOT,
  options: LocalWorkspaceReadToolOptions = {},
): ToolExecutor {
  const sandboxPolicy = options.sandboxPolicy ?? createLocalWorkspaceSandboxPolicy();
  return {
    definition: {
      name: "Grep",
      description: "Search authorized local text files for a plain-text query. Uses ripgrep when available, with a JS recursive fallback.",
      metadata: {
        category: "filesystem",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "Plain-text query to search for, case-insensitive." },
          path: { type: "string", description: "Absolute or run-root-relative directory or file path. Defaults to the run root." },
          limit: { type: "integer", minimum: 1, maximum: MAX_GREP_MATCHES, description: "Maximum matches to return." },
          offset: {
            type: "integer",
            minimum: 0,
            maximum: MAX_GREP_OFFSET,
            description: "Zero-based match offset used to continue a truncated search.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    execute: (value, context) => grepLocalFiles({
      rootDirectory,
      value,
      context,
      sandboxPolicy,
      pathAuthorization: options.pathAuthorization,
      outputTokenCounter: options.outputTokenCounter,
      ripgrepSearch: options.ripgrepSearch,
    }),
  };
}
