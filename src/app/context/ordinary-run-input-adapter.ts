import { asRecord } from "../../kernel/values/index.js";
import path from "node:path";
import type {
  OrdinaryRunContextInput,
  OrdinaryRunContextReferenceInput,
} from "../../domain/ordinary/index.js";
import {
  createOrdinaryRunContext,
  parseContextReference,
  parsePermissionBoundaryRef,
  parseUserPermissionBoundaryRef,
  type OrdinaryRunContext,
  type OrdinaryRunContextReference,
} from "../../domain/ordinary/index.js";
import type { ModelRuntimeMode } from "../model-runtime/contracts.js";

// Host-selected local paths are authorization facts and may exceed display
// UI label lengths. Truncating them would silently break the exact permission.
const MAX_REF_LENGTH = 4_096;
const MAX_SUMMARY_LENGTH = 360;
const MAX_PREVIEW_LENGTH = 640;

/** Panel input adapter; the canonical value returned here belongs to Ordinary. */
export type OrdinaryRunContextInputAdapter = OrdinaryRunContextInput;
export type OrdinaryRunContextReferenceInputAdapter = OrdinaryRunContextReferenceInput;

export type OrdinaryRunContextInputIssueCode =
  | "invalid_context_refs"
  | "empty_context_ref"
  | "unauthorized_context_ref"
  | "invalid_permission_refs"
  | "unauthorized_permission_ref";

export class OrdinaryRunContextInputValidationError extends Error {
  constructor(
    readonly code: OrdinaryRunContextInputIssueCode,
    message: string
  ) {
    super(message);
    this.name = "OrdinaryRunContextInputValidationError";
  }
}

export function parseOrdinaryRunContextInput(raw: unknown): OrdinaryRunContextInputAdapter {
  const record = asRecord(raw);
  const contextRefsRaw = record.contextRefs;
  const permissionRefsRaw = record.permissionBoundaryRefs;
  return {
    contextRefs: contextRefsRaw === undefined ? undefined : parseContextRefs(contextRefsRaw),
    permissionBoundaryRefs: permissionRefsRaw === undefined ? undefined : parsePermissionRefs(permissionRefsRaw),
  };
}

/**
 * Builds the canonical Ordinary run context from Panel input.
 */
export function createOrdinaryRunContextFromInput(input: {
  readonly goal: string;
  readonly goalId: string;
  readonly traceId: string;
  readonly aiMode: ModelRuntimeMode;
  readonly contextInput?: OrdinaryRunContextInputAdapter;
  readonly createdAt?: string;
}): OrdinaryRunContext {
  return createOrdinaryRunContext({
    goal: input.goal,
    goalId: input.goalId,
    traceId: input.traceId,
    contextRefs: createRunContextReferences(input),
    permissionBoundaryRefs: createRunPermissionRefs(input.aiMode, input.contextInput?.permissionBoundaryRefs),
    createdAt: input.createdAt,
  });
}

function createRunContextReferences(input: {
  readonly goal: string;
  readonly goalId: string;
  readonly contextInput?: OrdinaryRunContextInputAdapter;
}): readonly OrdinaryRunContextReference[] {
  const supplied = input.contextInput?.contextRefs ?? [];
  const permissionRefs = input.contextInput?.permissionBoundaryRefs ?? [];
  return [
    {
      ref: `goal:${input.goalId}`,
      kind: "user_goal",
      summary: safeText(input.goal, MAX_SUMMARY_LENGTH),
    },
    {
      ref: `workspace:${input.goalId}`,
      kind: "workspace",
      summary: "The current task workspace is provided as a reference-only context.",
    },
    ...supplied.map((ref) => ({
      attachmentId: ref.attachmentId,
      ref: ref.ref,
      // System-selected local paths arrive with an exact read permission, but the
      // browser client is not allowed to set `pathGranted` itself. Derive the
      // model-visible path fact from the server-side permission boundary here.
      pathGranted: hasLocalPathPermission(ref, permissionRefs)
        ? true
        : undefined,
      ...(ref.automaticSpaceReference === true ? { automaticSpaceReference: true } : {}),
      sourceIdentity: hasLocalPathPermission(ref, permissionRefs)
        ? ref.sourceIdentity
        : undefined,
      kind: ref.kind,
      title: ref.title === undefined ? undefined : safeText(ref.title, 120),
      summary: ref.summary === undefined ? undefined : safeText(ref.summary, MAX_SUMMARY_LENGTH),
      metadata: cloneContextRefMetadata(ref.metadata),
      readonlyPreview:
        ref.readonlyPreview === undefined
          ? undefined
          : {
              title:
                ref.readonlyPreview.title === undefined
                  ? undefined
                  : safeText(ref.readonlyPreview.title, 120),
              ...previewText(ref.readonlyPreview.text),
            },
    })),
  ];
}

function hasLocalPathPermission(
  ref: OrdinaryRunContextReferenceInputAdapter,
  permissionRefs: readonly string[],
): boolean {
  const target = parseContextReference(ref.ref, ref.kind);
  if (target?.scheme !== "local_file" && target?.scheme !== "local_project") return false;
  const rawPath = target.path;
  if (!path.isAbsolute(rawPath)) return false;
  const canonicalPath = comparableAbsolutePath(rawPath);
  return permissionRefs.some((permission) => {
    const parsedPermission = parsePermissionBoundaryRef(permission);
    if (parsedPermission?.kind !== "access" || parsedPermission.mode !== "read") return false;
    const permissionTarget = parseContextReference(parsedPermission.target, ref.kind);
    return permissionTarget?.scheme === target.scheme && path.isAbsolute(permissionTarget.path) &&
      comparableAbsolutePath(permissionTarget.path) === canonicalPath;
  });
}

function comparableAbsolutePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function createRunPermissionRefs(
  aiMode: ModelRuntimeMode,
  inputPermissionRefs: readonly string[] | undefined
): readonly string[] {
  return unique([
    "read:workspace:current-task",
    "write:memory://artifacts",
    aiMode === "openai-compatible" || aiMode === "openai-responses"
      ? "execute:responses-ai"
      : "execute:none",
    ...(inputPermissionRefs ?? []),
  ]);
}

function parseContextRefs(value: unknown): readonly OrdinaryRunContextReferenceInputAdapter[] {
  if (!Array.isArray(value)) {
    throw new OrdinaryRunContextInputValidationError("invalid_context_refs", "contextRefs 必须是数组。");
  }
  return value.map(parseContextRef);
}

function parseContextRef(value: unknown): OrdinaryRunContextReferenceInputAdapter {
  const record = asRecord(value);
  const ref = optionalString(record.ref);
  const kind = parseContextKind(record.kind);
  if (ref === undefined || kind === undefined) {
    throw new OrdinaryRunContextInputValidationError("empty_context_ref", "contextRefs 需要 ref 和合法 kind。");
  }
  if (!isAuthorizedContextRef(ref, kind)) {
    throw new OrdinaryRunContextInputValidationError(
      "unauthorized_context_ref",
      "contextRefs 只允许 workspace/file/project/web 的只读引用，不能传入 runtime、store、secret 或未授权正文。"
    );
  }
  return {
    attachmentId: safeOptionalText(record.attachmentId, MAX_REF_LENGTH),
    ref: safeText(ref, MAX_REF_LENGTH),
    kind,
    title: safeOptionalText(record.title, 120),
    summary: safeOptionalText(record.summary, MAX_SUMMARY_LENGTH),
    metadata: parseContextRefMetadata(record.metadata),
    readonlyPreview: parseReadonlyPreview(record.readonlyPreview),
  };
}

function parsePermissionRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new OrdinaryRunContextInputValidationError("invalid_permission_refs", "permissionBoundaryRefs 必须是数组。");
  }
  return unique(
    value.map((item) => {
      const ref = optionalString(item);
      if (ref === undefined) {
        throw new OrdinaryRunContextInputValidationError("invalid_permission_refs", "permissionBoundaryRefs 不能包含空值。");
      }
      if (!isAuthorizedPermissionRef(ref)) {
        throw new OrdinaryRunContextInputValidationError(
          "unauthorized_permission_ref",
          "任务输入只能声明 read/execute/deny/ask 权限引用；真实写入仍由 ToolCenter 和本地授权边界守卫。"
        );
      }
      return safeText(ref, MAX_REF_LENGTH);
    })
  );
}

function parseReadonlyPreview(value: unknown): OrdinaryRunContextReferenceInputAdapter["readonlyPreview"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = asRecord(value);
  if (typeof record.text !== "string" || record.text.length === 0) {
    return undefined;
  }
  return {
    title: safeOptionalText(record.title, 120),
    text: record.text,
  };
}

function parseContextRefMetadata(value: unknown): OrdinaryRunContextReferenceInputAdapter["metadata"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = asRecord(value);
  const byteLength = positiveIntegerOrUndefined(record.byteLength);
  const mimeType = safeOptionalText(record.mimeType, 120);
  const available = booleanOrUndefined(record.available);
  const truncated = booleanOrUndefined(record.truncated);
  if (byteLength === undefined && mimeType === undefined && available === undefined && truncated === undefined) {
    return undefined;
  }
  return {
    byteLength,
    mimeType,
    available,
    truncated,
  };
}

function parseContextKind(value: unknown): OrdinaryRunContextReferenceInputAdapter["kind"] | undefined {
  if (value === "workspace" || value === "file" || value === "project" || value === "web") {
    return value;
  }
  return undefined;
}

function isAuthorizedContextRef(ref: string, kind: OrdinaryRunContextReferenceInputAdapter["kind"]): boolean {
  return parseContextReference(ref, kind) !== undefined;
}

function isAuthorizedPermissionRef(ref: string): boolean {
  return parseUserPermissionBoundaryRef(ref) !== undefined;
}

function previewText(text: string): { readonly text: string; readonly truncated: boolean } {
  const safe = safeText(text, MAX_PREVIEW_LENGTH);
  return {
    text: safe,
    truncated: safe.length < text.length,
  };
}

function safeOptionalText(value: unknown, maxLength: number): string | undefined {
  return optionalString(value) === undefined ? undefined : safeText(String(value), maxLength);
}

function safeText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}


function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function cloneContextRefMetadata(
  metadata: OrdinaryRunContextReferenceInputAdapter["metadata"]
): OrdinaryRunContextReferenceInputAdapter["metadata"] {
  return metadata === undefined ? undefined : { ...metadata };
}
