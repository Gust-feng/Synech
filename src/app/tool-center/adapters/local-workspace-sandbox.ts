import path from "node:path";
import type { SandboxPolicy, SandboxPolicyRequest } from "../../../domain/tools/index.js";

const MAX_FILE_BYTES = 512_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const BLOCKED_PATH_SEGMENTS = new Set<string>();

export type LocalWorkspaceSandboxPolicyOptions = {
  readonly allowWrite?: boolean;
  readonly allowExecute?: boolean;
  readonly blockedPathSegments?: readonly string[];
  readonly maxWriteBytes?: number;
  readonly maxCommandTimeoutMs?: number;
};

export class LocalSandboxPolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalSandboxPolicyViolationError";
  }
}

export function createLocalWorkspaceSandboxPolicy(options: LocalWorkspaceSandboxPolicyOptions = {}): SandboxPolicy {
  const allowWrite = options.allowWrite ?? true;
  const allowExecute = options.allowExecute ?? true;
  const blockedPathSegments = new Set((options.blockedPathSegments ?? [...BLOCKED_PATH_SEGMENTS]).map((segment) => segment.toLowerCase()));
  const maxWriteBytes = options.maxWriteBytes ?? MAX_FILE_BYTES;
  const maxCommandTimeoutMs = options.maxCommandTimeoutMs ?? MAX_COMMAND_TIMEOUT_MS;

  return {
    check(request: SandboxPolicyRequest) {
      const pathDecision = checkSandboxPath(request, blockedPathSegments);
      if (!pathDecision.allowed) {
        return pathDecision;
      }
      if ((request.operation === "write" || request.operation === "edit" || request.operation === "delete") && !allowWrite) {
        return deny("write_disabled", "Sandbox policy does not allow local file writes.");
      }
      if ((request.operation === "write" || request.operation === "edit") && (request.bytes ?? 0) > maxWriteBytes) {
        return deny("write_too_large", "Sandbox policy rejected a large local file write.");
      }
      if (request.operation === "execute") {
        if (!allowExecute) {
          return deny("execute_disabled", "Sandbox policy does not allow local command execution.");
        }
        const rawCommand = request.command ?? "";
        if (rawCommand.trim().length === 0 || rawCommand.includes("\u0000")) {
          return deny("command_invalid", "Sandbox policy rejected an invalid command.");
        }
        if ((request.bytes ?? 0) > maxCommandTimeoutMs) {
          return deny("command_timeout_rejected", "Sandbox policy rejected command timeout.");
        }
      }
      return { allowed: true };
    },
  };
}

export function sandboxRequest(
  operation: SandboxPolicyRequest["operation"],
  workspaceRoot: string,
  relativePath: string,
  extras: Partial<SandboxPolicyRequest> = {}
): SandboxPolicyRequest {
  return {
    operation,
    workspaceRoot: path.resolve(workspaceRoot),
    relativePath,
    ...extras,
  };
}

export function assertSandboxAllowed(policy: SandboxPolicy, request: SandboxPolicyRequest): void {
  const decision = policy.check(request);
  if (!decision.allowed) {
    throw new LocalSandboxPolicyViolationError(decision.reason);
  }
}

function checkSandboxPath(
  request: SandboxPolicyRequest,
  blockedPathSegments: ReadonlySet<string>
): ReturnType<SandboxPolicy["check"]> {
  const relativePath = request.relativePath;
  if (relativePath === undefined || relativePath === ".") {
    return { allowed: true };
  }
  if (relativePath.includes("\u0000")) {
    return deny("invalid_path", "Sandbox policy rejected an invalid path.");
  }
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.some((segment) => blockedPathSegments.has(segment.toLowerCase()))) {
    return deny("blocked_path", `Sandbox policy rejected blocked workspace path: ${relativePath}.`);
  }
  return { allowed: true };
}

function deny(code: string, reason: string): ReturnType<SandboxPolicy["check"]> {
  return { allowed: false, code, reason };
}
