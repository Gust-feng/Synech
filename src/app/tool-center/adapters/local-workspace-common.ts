import { asRecord } from "../../../kernel/values/index.js";
export { asRecord };
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { ToolExecutionContext, ToolExecutionResourceScope } from "../../../domain/tools/index.js";
import { utf16SafePrefixLength } from "../text-window.js";

export const DEFAULT_LOCAL_WORKSPACE_ROOT = process.cwd();
export const MAX_LOCAL_WORKSPACE_FILE_BYTES = 512_000;

export type LocalWorkspaceToolOptions = {
  readonly sandboxPolicy?: import("../../../domain/tools/index.js").SandboxPolicy;
  readonly commandShell?: import("../../../domain/config/index.js").SanitizedCommandShellConfig;
  readonly mutationCoordinator?: import("./local-workspace-mutation-coordinator.js").LocalWorkspaceMutationCoordinator;
  readonly pathAuthorization?: LocalWorkspacePathAuthorization;
};

export type LocalWorkspacePathOperation = "read" | "search" | "write" | "edit" | "execute";

export type AuthorizedLocalWorkspacePath = {
  readonly absolutePath: string;
  readonly relativePath: string;
  /** Actual root used by the mature local tool after authorization resolves. */
  readonly rootDirectory: string;
  /** Product owner and resource identities retained for process/audit facts. */
  readonly resourceScope?: ToolExecutionResourceScope;
  readonly resourceId?: string;
};

/** Run-scoped Host authority. Local tools stay neutral and never read Space state. */
export type LocalWorkspacePathAuthorization = {
  readonly resourceScope?: ToolExecutionResourceScope;
  resolve(input: {
    readonly requestedPath: string;
    readonly operation: LocalWorkspacePathOperation;
    readonly workspaceRoot: string;
    readonly context: ToolExecutionContext;
  }): Promise<AuthorizedLocalWorkspacePath>;
};

export async function resolveAuthorizedWorkspacePath(
  rootDirectory: string,
  requestedPath: string,
  operation: LocalWorkspacePathOperation,
  context: ToolExecutionContext,
  authorization?: LocalWorkspacePathAuthorization,
): Promise<AuthorizedLocalWorkspacePath> {
  if (authorization !== undefined) {
    return authorization.resolve({
      requestedPath,
      operation,
      workspaceRoot: path.resolve(rootDirectory),
      context,
    });
  }
  const target = resolveWorkspacePath(rootDirectory, requestedPath);
  return {
    ...target,
    rootDirectory: path.resolve(rootDirectory),
  };
}

/** Adds identities only for an explicitly authorized multi-root path. */
export function authorizedPathFacts(target: AuthorizedLocalWorkspacePath): Readonly<Record<string, string>> {
  return target.resourceScope === undefined && target.resourceId === undefined
    ? {}
    : {
        absolutePath: target.absolutePath,
        ...(target.resourceScope === undefined ? {} : { resourceOwnerId: target.resourceScope.ownerId }),
        ...(target.resourceId === undefined ? {} : { referenceId: target.resourceId }),
      };
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const error = new Error("Tool execution cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

export function resolveWorkspacePath(rootDirectory: string, requestedPath: string): { readonly absolutePath: string; readonly relativePath: string } {
  const root = path.resolve(rootDirectory);
  const absolutePath = path.resolve(root, requestedPath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the workspace boundary.");
  }
  assertRealPathInsideWorkspace(root, absolutePath);
  return {
    absolutePath,
    relativePath: relative.length === 0 ? "." : normalizePath(relative),
  };
}

/**
 * A lexical prefix check alone lets a symlink or Windows junction inside the
 * workspace point anywhere on disk. Resolving the deepest existing ancestor to
 * its real path keeps the workspace boundary true for the actual file system
 * target, including files that do not exist yet (e.g. a new Write target).
 */
function assertRealPathInsideWorkspace(root: string, absolutePath: string): void {
  const realRoot = realPathOrUndefined(root) ?? root;
  const pendingSegments: string[] = [];
  let probe = absolutePath;
  let realProbe = realPathOrUndefined(probe);
  while (realProbe === undefined) {
    const parent = path.dirname(probe);
    if (parent === probe) {
      realProbe = probe;
      break;
    }
    pendingSegments.unshift(path.basename(probe));
    probe = parent;
    realProbe = realPathOrUndefined(probe);
  }
  const realTarget = path.resolve(realProbe, ...pendingSegments);
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the workspace boundary.");
  }
}

function realPathOrUndefined(value: string): string | undefined {
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}

export function toWorkspaceRelative(rootDirectory: string, absolutePath: string): string {
  const relative = path.relative(path.resolve(rootDirectory), absolutePath);
  return relative.length === 0 ? "." : normalizePath(relative);
}

export function safeRefToken(value: string): string {
  const token = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return token.length === 0 ? "query" : token;
}

export function shouldSkipEntry(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === "dist" || name === "coverage";
}

export function isLikelyBinaryPath(value: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|exe|dll|bin|lock)$/i.test(value);
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const prefixLength = utf16SafePrefixLength(value, Math.max(0, maxLength - 1));
  return `${value.slice(0, prefixLength)}…`;
}



export function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function optionalSafeIntegerAtLeast(
  value: unknown,
  fieldName: string,
  minimum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${fieldName} must be at least ${minimum} and a safe integer.`);
  }
  return value as number;
}

export function requireText(value: unknown, fieldName: string, options: { readonly allowEmpty: boolean }): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function decodeUtf8Text(value: Uint8Array): string | undefined {
  try {
    // Keeping the BOM as U+FEFF ensures a read/edit/write cycle preserves the
    // original bytes instead of silently changing the file encoding marker.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    return undefined;
  }
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}