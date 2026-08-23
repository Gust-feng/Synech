import { stringOrUndefined } from "../../../kernel/values/index.js";
/**
 * Resolves model-visible run-context attachments to authorized local targets.
 *
 * Attachment tools use these facts rather than accepting raw local paths. The
 * module deliberately owns the authorization, root resolution, and format
 * classification rules shared by text, image, table, archive, and file tools.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { OrdinaryRunContext, OrdinaryRunContextReference } from "../../../domain/ordinary/index.js";
import { managedUploadAttachmentId } from "../../context/attachments.js";
import { isConversationOwnerContextRef } from "../../context/reference-origin.js";

export type ContextAttachmentToolOptions = {
  readonly runContext?: ContextAttachmentRunContext;
  readonly workspaceRoot?: string;
  readonly supportsVisionInput?: boolean;
  readonly resolveManagedAttachmentPath?: (attachmentId: string) => Promise<string | undefined>;
  readonly readAuthorization?: ContextAttachmentReadAuthorization;
};

/** The attachment tools need only the frozen reference and permission facts. */
export type ContextAttachmentRunContext = Pick<OrdinaryRunContext, "goalId" | "contextRefs" | "permissionBoundaryRefs">;

/** Optional run-scoped live deny layered over the frozen run-context grant. */
export type ContextAttachmentReadAuthorization = {
  assertReadAllowed(attachmentId: string): void | Promise<void>;
};

export type AttachmentEntry = {
  readonly attachmentId: string;
  readonly index: number;
  readonly ref: OrdinaryRunContextReference;
  readonly authorized: boolean;
};

export type AttachmentTarget = {
  readonly entry: AttachmentEntry;
  readonly rootAbsolutePath: string;
  readonly targetAbsolutePath: string;
  readonly targetPath: string;
  readonly rootKind: "file" | "project";
};

export type AttachmentFormat =
  | "image"
  | "pdf"
  | "table"
  | "spreadsheet"
  | "archive"
  | "text"
  | "project"
  | "web"
  | "unknown";

export function attachmentEntries(runContext: ContextAttachmentRunContext | undefined): readonly AttachmentEntry[] {
  if (runContext === undefined) {
    return [];
  }
  return runContext.contextRefs
    .map((ref, index): AttachmentEntry | undefined => {
      if (!isUserVisibleAttachmentRef(ref, runContext)) {
        return undefined;
      }
      return {
        attachmentId: attachmentEntryId(ref, index),
        index,
        ref,
        authorized: isAttachmentReadAuthorized(ref, runContext.permissionBoundaryRefs),
      };
    })
    .filter((entry): entry is AttachmentEntry => entry !== undefined);
}

export function attachmentSummary(entry: AttachmentEntry): Readonly<Record<string, unknown>> {
  const capabilities = attachmentCapabilities(entry.ref);
  const format = attachmentFormat(entry.ref);
  return {
    attachmentId: entry.attachmentId,
    origin: isConversationOwnerContextRef(entry.ref) ? "conversation_owner" : "user_input",
    kind: entry.ref.kind,
    format,
    title: entry.ref.title,
    summary: entry.ref.summary,
    mimeType: entry.ref.metadata?.mimeType,
    byteLength: entry.ref.metadata?.byteLength,
    available: entry.ref.metadata?.available,
    previewTruncated: entry.ref.metadata?.truncated === true || entry.ref.readonlyPreview?.truncated === true,
    authorized: entry.authorized,
    ref: modelSafeRef(entry.ref.ref, entry.authorized && entry.ref.pathGranted === true),
    canReadText: capabilities.canReadText,
    canReadPdfText: capabilities.canReadPdfText,
    canReadImage: capabilities.canReadImage,
    canReadTable: capabilities.canReadTable,
    canInspectArchive: capabilities.canInspectArchive,
    canListFiles: capabilities.canListFiles,
    canSearchFiles: capabilities.canSearchFiles,
    canUseVisionInput: format === "image",
  };
}

export function requireAttachmentEntry(
  runContext: ContextAttachmentRunContext | undefined,
  record: Readonly<Record<string, unknown>>,
): AttachmentEntry {
  const attachmentId = stringOrUndefined(record.attachmentId);
  const ref = stringOrUndefined(record.ref);
  if (attachmentId === undefined && ref === undefined) {
    throw new Error("Provide attachmentId from attachment_list or a non-local context ref.");
  }
  const found = attachmentEntries(runContext).find((entry) =>
    (attachmentId !== undefined && entry.attachmentId === attachmentId) ||
    (ref !== undefined && entry.ref.ref === ref)
  );
  if (found === undefined) {
    throw new Error("No current context attachment matched the provided selector.");
  }
  return found;
}

export function assertAttachmentAuthorized(entry: AttachmentEntry): void {
  if (!entry.authorized) {
    throw new Error("The selected context attachment is not authorized for reading in this run.");
  }
}

export async function resolveAttachmentTarget(input: {
  readonly entry: AttachmentEntry;
  readonly workspaceRoot: string;
  readonly requestedPath?: string;
  readonly requireFile: boolean;
  readonly projectPathRequired: boolean;
  readonly resolveManagedAttachmentPath?: (attachmentId: string) => Promise<string | undefined>;
  readonly readAuthorization?: ContextAttachmentReadAuthorization;
}): Promise<AttachmentTarget> {
  await input.readAuthorization?.assertReadAllowed(input.entry.attachmentId);
  const root = await resolveAttachmentRoot(
    input.entry.ref,
    input.workspaceRoot,
    input.resolveManagedAttachmentPath,
  );
  if (root === undefined) {
    throw new Error("This context attachment cannot be inspected by local attachment tools.");
  }
  if (root.kind === "file") {
    if (input.requestedPath !== undefined && input.requestedPath !== ".") {
      throw new Error("File attachments do not accept a nested path.");
    }
    return {
      entry: input.entry,
      rootAbsolutePath: root.absolutePath,
      targetAbsolutePath: root.absolutePath,
      targetPath: ".",
      rootKind: "file",
    };
  }
  const requestedPath = input.requestedPath ?? ".";
  if (input.requireFile && input.projectPathRequired && requestedPath === ".") {
    throw new Error("Project attachments require an attachment-relative file path.");
  }
  const target = resolveInsideRoot(root.absolutePath, requestedPath);
  return {
    entry: input.entry,
    rootAbsolutePath: root.absolutePath,
    targetAbsolutePath: target.absolutePath,
    targetPath: target.relativePath,
    rootKind: "project",
  };
}

export function attachmentTitle(entry: AttachmentEntry): string {
  return entry.ref.title ?? entry.attachmentId;
}

export async function statAttachmentTarget(
  filePath: string,
  message: string,
): Promise<import("node:fs").Stats> {
  return fs.stat(filePath).catch(() => {
    throw new Error(message);
  });
}

export function tableTargetFormat(ref: OrdinaryRunContextReference, targetPath: string): AttachmentFormat {
  const extension = tableTargetExtension(ref, targetPath);
  return formatFromMimeOrExtension(ref.metadata?.mimeType, extension, ref.kind);
}

export function tableTargetExtension(ref: OrdinaryRunContextReference, targetPath: string): string {
  const source = targetPath !== "." ? targetPath : ref.title ?? ref.ref;
  return path.extname(source).toLowerCase();
}

export function archiveTargetExtension(ref: OrdinaryRunContextReference, targetPath: string): string {
  return tableTargetExtension(ref, targetPath);
}

export function isSupportedSpreadsheetRef(ref: OrdinaryRunContextReference): boolean {
  return isSupportedSpreadsheetTarget(ref, ".");
}

export function isSupportedSpreadsheetTarget(ref: OrdinaryRunContextReference, targetPath: string): boolean {
  const extension = tableTargetExtension(ref, targetPath);
  const mimeType = ref.metadata?.mimeType?.toLowerCase();
  return extension === ".xlsx" ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

function attachmentCapabilities(ref: OrdinaryRunContextReference): {
  readonly canReadText: boolean;
  readonly canReadPdfText: boolean;
  readonly canReadImage: boolean;
  readonly canReadTable: boolean;
  readonly canInspectArchive: boolean;
  readonly canListFiles: boolean;
  readonly canSearchFiles: boolean;
} {
  const format = attachmentFormat(ref);
  if (ref.kind === "file") {
    return {
      canReadText: true,
      canReadPdfText: format === "pdf",
      canReadImage: format === "image",
      canReadTable: format === "table" || isSupportedSpreadsheetRef(ref),
      canInspectArchive: format === "archive" && contextRefExtension(ref) === ".zip",
      canListFiles: false,
      canSearchFiles: true,
    };
  }
  if (ref.kind === "project" || ref.kind === "workspace") {
    return {
      canReadText: ref.kind === "project",
      canReadPdfText: true,
      canReadImage: true,
      canReadTable: true,
      canInspectArchive: true,
      canListFiles: true,
      canSearchFiles: true,
    };
  }
  return {
    canReadText: false,
    canReadPdfText: false,
    canReadImage: false,
    canReadTable: false,
    canInspectArchive: false,
    canListFiles: false,
    canSearchFiles: false,
  };
}

async function resolveAttachmentRoot(
  ref: OrdinaryRunContextReference,
  workspaceRoot: string,
  resolveManagedAttachmentPath: ((attachmentId: string) => Promise<string | undefined>) | undefined,
): Promise<{ readonly kind: "file" | "project"; readonly absolutePath: string } | undefined> {
  const normalized = ref.ref.toLowerCase();
  const managedAttachmentId = managedUploadAttachmentId(ref.ref);
  if (ref.kind === "file" && managedAttachmentId !== undefined) {
    const absolutePath = await resolveManagedAttachmentPath?.(managedAttachmentId);
    return absolutePath !== undefined && path.isAbsolute(absolutePath)
      ? { kind: "file", absolutePath: path.resolve(absolutePath) }
      : undefined;
  }
  if (ref.kind === "file" && normalized.startsWith("local-file:")) {
    const absolutePath = ref.ref.slice("local-file:".length);
    return path.isAbsolute(absolutePath) ? { kind: "file", absolutePath: path.resolve(absolutePath) } : undefined;
  }
  if (ref.kind === "project" && normalized.startsWith("local-project:")) {
    const absolutePath = ref.ref.slice("local-project:".length);
    return path.isAbsolute(absolutePath) ? { kind: "project", absolutePath: path.resolve(absolutePath) } : undefined;
  }
  if (ref.kind === "file" && normalized.startsWith("file:")) {
    return { kind: "file", absolutePath: resolveInsideRoot(workspaceRoot, ref.ref.slice("file:".length)).absolutePath };
  }
  if (ref.kind === "project" && normalized.startsWith("project:")) {
    return { kind: "project", absolutePath: resolveInsideRoot(workspaceRoot, ref.ref.slice("project:".length) || ".").absolutePath };
  }
  if (ref.kind === "workspace") {
    return { kind: "project", absolutePath: path.resolve(workspaceRoot) };
  }
  if ((ref.kind === "file" || ref.kind === "project") && normalized.startsWith("workspace:")) {
    const relative = ref.ref.slice("workspace:".length);
    return {
      kind: ref.kind === "file" ? "file" : "project",
      absolutePath: resolveInsideRoot(workspaceRoot, relative || ".").absolutePath,
    };
  }
  return undefined;
}

function resolveInsideRoot(rootAbsolutePath: string, requestedPath: string): { readonly absolutePath: string; readonly relativePath: string } {
  const root = path.resolve(rootAbsolutePath);
  const absolutePath = path.resolve(root, requestedPath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Attachment-relative path is outside the selected attachment boundary.");
  }
  return {
    absolutePath,
    relativePath: toPortableRelativePath(relative.length === 0 ? "." : relative),
  };
}

function isUserVisibleAttachmentRef(ref: OrdinaryRunContextReference, runContext: ContextAttachmentRunContext): boolean {
  if (ref.kind === "user_goal" || ref.kind === "runtime") {
    return false;
  }
  if (ref.kind === "workspace" && (ref.ref === `workspace:${runContext.goalId}` || ref.ref.startsWith("workspace:goal-"))) {
    return false;
  }
  return ref.kind === "workspace" || ref.kind === "file" || ref.kind === "project" || ref.kind === "web";
}

function isAttachmentReadAuthorized(ref: OrdinaryRunContextReference, permissionBoundaryRefs: readonly string[]): boolean {
  const permissions = new Set(permissionBoundaryRefs);
  const normalized = ref.ref.toLowerCase();
  if (ref.kind === "file" && normalized.startsWith("local-file:")) {
    return permissions.has(`read:local-file:${ref.ref.slice("local-file:".length)}`);
  }
  const managedAttachmentId = managedUploadAttachmentId(ref.ref);
  if (ref.kind === "file" && managedAttachmentId !== undefined) {
    return permissions.has(`read:uploaded-attachment:${managedAttachmentId}`);
  }
  if (ref.kind === "project" && normalized.startsWith("local-project:")) {
    return permissions.has(`read:local-project:${ref.ref.slice("local-project:".length)}`);
  }
  if (ref.kind === "file" && normalized.startsWith("file:")) {
    return permissions.has(`read:file:${ref.ref.slice("file:".length)}`) || permissions.has("read:workspace:current-task");
  }
  if (ref.kind === "project" && normalized.startsWith("project:")) {
    return permissions.has(`read:project:${ref.ref.slice("project:".length) || "."}`) || permissions.has("read:workspace:current-task");
  }
  if ((ref.kind === "file" || ref.kind === "project") && normalized.startsWith("workspace:")) {
    return permissions.has("read:workspace:current-task");
  }
  if (ref.kind === "workspace") {
    return permissions.has("read:workspace:current-task");
  }
  if (ref.kind === "web") {
    return permissions.has("read:web");
  }
  return false;
}

function attachmentEntryId(ref: OrdinaryRunContextReference, index: number): string {
  return ref.attachmentId ?? `context:run:${index}`;
}

function attachmentFormat(ref: OrdinaryRunContextReference): AttachmentFormat {
  return formatFromMimeOrExtension(ref.metadata?.mimeType, contextRefExtension(ref), ref.kind);
}

function contextRefExtension(ref: OrdinaryRunContextReference): string {
  const source = ref.title ?? ref.ref;
  return path.extname(source).toLowerCase();
}

function formatFromMimeOrExtension(
  mimeType: string | undefined,
  extension: string,
  kind: OrdinaryRunContextReference["kind"],
): AttachmentFormat {
  const mime = mimeType?.toLowerCase();
  if (kind === "project") return "project";
  if (kind === "web") return "web";
  if (mime?.startsWith("image/") === true || isImageExtension(extension)) return "image";
  if (mime === "application/pdf" || extension === ".pdf") return "pdf";
  if (mime === "text/csv" || mime === "text/tab-separated-values" || extension === ".csv" || extension === ".tsv") return "table";
  if (
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    extension === ".xls" ||
    extension === ".xlsx"
  ) {
    return "spreadsheet";
  }
  if (mime === "application/zip" || extension === ".zip" || extension === ".7z" || extension === ".gz" || extension === ".tar") {
    return "archive";
  }
  if (mime?.startsWith("text/") === true || isTextExtension(extension)) return "text";
  return "unknown";
}

function isImageExtension(extension: string): boolean {
  return extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".gif" || extension === ".webp";
}

function isTextExtension(extension: string): boolean {
  return (
    extension === ".txt" ||
    extension === ".md" ||
    extension === ".json" ||
    extension === ".jsonl" ||
    extension === ".html" ||
    extension === ".js" ||
    extension === ".jsx" ||
    extension === ".ts" ||
    extension === ".tsx"
  );
}

function modelSafeRef(ref: string, pathGranted: boolean): string | undefined {
  const normalized = ref.toLowerCase();
  if (normalized.startsWith("uploaded-attachment:")) return undefined;
  if (normalized.startsWith("local-file:") || normalized.startsWith("local-project:")) {
    return pathGranted ? ref : undefined;
  }
  return ref;
}


function toPortableRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}
