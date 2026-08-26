import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import type { DocumentCaptionUpdateInput, DocumentTextUpdateInput } from "../../panel-api/workbench.js";
import { normalizeRelativePath } from "../../local-filesystem/index.js";
import type { SpaceDirectReference, SpaceFeature, SpaceFeatureError, SpaceReferenceItem, SpaceTarget } from "../../spaces/index.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import type {
  SpaceConversationDeletionCoordinator,
  WorkbenchCoordination,
} from "../../workbench-coordination/index.js";
import type { ManagedAssetsFeature } from "../../managed-assets/index.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";
import type { PanelExternalResourceTarget } from "../types.js";
import { attachSpaceReferenceMetadata, createPanelDocumentPreview, writePanelSpaceReferenceContent } from "./space-reference-preview.js";
import { getManagedAssetPreview } from "../storage/managed-asset-routes.js";
import { resolveSpaceFilesystemReference, type ResolvedSpaceFilesystemReference } from "./space-workspace-reference.js";
import type { ManagedSpaceFolderApplication } from "../../../domain/managed-space-folder.js";
import type { SpaceReferenceContentApplication } from "../../application/space-reference-content-application.js";
import type { SpaceReferenceLifecycleApplication } from "../../application/space-reference-lifecycle-application.js";

const titleSchema = z.string().trim().min(1).max(160);
const referenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local_file"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("web_page"), url: z.string().url() }).strict(),
  z.object({ kind: z.literal("generated_artifact"), artifactRef: z.string().min(1) }).strict(),
]);

const createFolderSchema = z.object({ title: titleSchema }).strict();
const attachWorkspaceSchema = z.object({ rootPath: z.string().trim().min(1).max(4_096), title: titleSchema.optional() }).strict();
const addReferenceSchema = z.object({ title: titleSchema, reference: referenceSchema }).strict();
const renameSchema = z.object({ title: titleSchema }).strict();
const moveSchema = z.object({
  target: z.object({ kind: z.literal("reference"), id: z.string().min(1) }).strict(),
  destinationSpaceId: z.string().min(1),
}).strict();
const updateTextSchema: z.ZodType<DocumentTextUpdateInput> = z.object({
  relativePath: z.string().max(4_096).optional(),
  expectedFingerprint: z.string().min(1).max(512),
  text: z.string().max(512 * 1024),
}).strict();
const updateCaptionSchema: z.ZodType<DocumentCaptionUpdateInput> = z.object({
  relativePath: z.string().max(4_096).optional(),
  expectedFingerprint: z.string().min(1).max(512),
  caption: z.string().max(16 * 1024),
}).strict();
const referenceEntrySchema = z.object({ relativePath: z.string().min(1).max(4_096) }).strict();
const renameReferenceEntrySchema = referenceEntrySchema.extend({ name: z.string().trim().min(1).max(255) }).strict();
const createReferenceEntrySchema = z.object({
  parentRelativePath: z.string().max(4_096),
  name: z.string().trim().min(1).max(255),
  kind: z.enum(["file", "directory"]),
}).strict();
const DOCUMENT_TEXT_REQUEST_MAX_CHARS = (512 * 1024 + 4_096 + 512) * 6 + 4_096;

export type SpaceReferenceRouteDependencies = {
  readonly spaceFeature: {
    readonly queries: Pick<SpaceFeature["queries"], "getTree" | "getReference">;
  };
  readonly workspaceFeature: {
    readonly commands: Pick<WorkspaceFeature["commands"], "invalidateMount">;
    readonly queries: Pick<WorkspaceFeature["queries"], "get">;
  };
  readonly workbenchCoordination: {
    readonly commands: Pick<WorkbenchCoordination["commands"], "attachWorkspaceToSpace">;
  };
  readonly managedSpaceFolderApplication: ManagedSpaceFolderApplication<SpaceReferenceItem>;
  readonly spaceReferenceContentApplication: SpaceReferenceContentApplication;
  readonly spaceReferenceLifecycleApplication: SpaceReferenceLifecycleApplication;
  readonly spaceConversationDeletion: Pick<SpaceConversationDeletionCoordinator, "assertAvailable">;
  readonly flushSpaceKnowledgeSync: () => Promise<void>;
  readonly externalResourceOpener?: (target: PanelExternalResourceTarget) => Promise<void>;
  readonly managedAssets: {
    readonly queries: Pick<ManagedAssetsFeature["queries"], "get">;
  };
};

/** HTTP adapter for SpaceFeature and explicitly authorized local reference operations. */
export async function handlePanelSpaceRoute(
  runtime: SpaceReferenceRouteDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const feature = runtime.spaceFeature;

  const managedFolderMatch = /^\/api\/spaces\/([^/]+)\/managed-folders$/u.exec(url.pathname);
  if (managedFolderMatch !== null && request.method === "POST") {
    const spaceId = decode(managedFolderMatch[1]);
    const input = parse(createFolderSchema, await readJsonBody(request), "空间文件夹信息无效。");
    const item = await runtime.managedSpaceFolderApplication.create({
      spaceId,
      title: input.title,
      actor: { kind: "user" },
    });
    writeJson(response, 201, { ok: true, item });
    return true;
  }

  const referenceMatch = /^\/api\/spaces\/([^/]+)\/references$/u.exec(url.pathname);
  if (referenceMatch !== null && request.method === "POST") {
    const spaceId = decode(referenceMatch[1]);
    const input = parse(addReferenceSchema, await readJsonBody(request), "空间引用信息无效。");
    const reference = absoluteLocalReference(input.reference);
    const item = await runtime.spaceReferenceLifecycleApplication.addReference({ spaceId, title: input.title, reference, actor: { kind: "user" } });
    writeJson(response, 201, {
      ok: true,
      item,
    });
    return true;
  }

  const workspaceReferenceMatch = /^\/api\/spaces\/([^/]+)\/workspaces$/u.exec(url.pathname);
  if (workspaceReferenceMatch !== null && request.method === "POST") {
    const spaceId = decode(workspaceReferenceMatch[1]);
    runtime.spaceConversationDeletion.assertAvailable(spaceId);
    const input = parse(attachWorkspaceSchema, await readJsonBody(request), "工作区目录无效。");
    const attached = await runtime.workbenchCoordination.commands.attachWorkspaceToSpace({
      spaceId,
      rootPath: path.resolve(input.rootPath),
      ...(input.title === undefined ? {} : { title: input.title }),
      actor: { kind: "user" },
    });
    writeJson(response, 201, { ok: true, item: attached.item, workspace: attached.workspace });
    return true;
  }

  const moveMatch = /^\/api\/spaces\/([^/]+)\/move$/u.exec(url.pathname);
  if (moveMatch !== null && request.method === "POST") {
    const sourceSpaceId = decode(moveMatch[1]);
    const input = parse(moveSchema, await readJsonBody(request), "空间移动信息无效。");
    const tree = await feature.queries.getTree(sourceSpaceId);
    if (tree === undefined || !tree.entries.some((entry) => entry.item.id === input.target.id)) {
      throw new PanelHttpError(409, "space_invalid_move", "移动目标不属于源空间。");
    }
    const movable = await feature.queries.getReference(input.target.id);
    if (movable === undefined || !isMovableSpaceMaterial(movable)) {
      throw new PanelHttpError(409, "space_invalid_move", "外部文件夹和外部文件不能移动；请在目标空间重新添加外部引用。");
    }
    await runtime.spaceReferenceLifecycleApplication.move({ sourceSpaceId, target: { kind: "reference", id: input.target.id }, destinationSpaceId: input.destinationSpaceId });
    writeJson(response, 200, { ok: true });
    return true;
  }

  const spaceRename = /^\/api\/spaces\/([^/]+)\/rename$/u.exec(url.pathname);
  if (spaceRename !== null && request.method === "POST") {
    const input = parse(renameSchema, await readJsonBody(request), "空间名称无效。");
    const spaceId = decode(spaceRename[1]);
    const target: SpaceTarget = { kind: "space", id: spaceId };
    const renamed = await runtime.spaceReferenceLifecycleApplication.rename({ target, title: input.title });
    writeJson(response, 200, { ok: true, target: renamed });
    return true;
  }

  const entryRename = /^\/api\/spaces\/references\/([^/]+)\/rename$/u.exec(url.pathname);
  if (entryRename !== null && request.method === "POST") {
    const item = await feature.queries.getReference(decode(entryRename[1]));
    if (item === undefined) throw new PanelHttpError(404, "space_reference_not_found", "未找到空间引用。");
    const input = parse(renameSchema, await readJsonBody(request), "空间名称无效。");
    const target: SpaceTarget = { kind: "reference", id: decode(entryRename[1]) };
    const renamed = await runtime.spaceReferenceLifecycleApplication.rename({ target, title: input.title });
    writeJson(response, 200, { ok: true, target: renamed });
    return true;
  }

  const removeReference = /^\/api\/spaces\/references\/([^/]+)$/u.exec(url.pathname);
  if (removeReference !== null && request.method === "DELETE") {
    const itemId = decode(removeReference[1]);
    const item = await feature.queries.getReference(itemId);
    if (item === undefined) throw new PanelHttpError(404, "space_reference_not_found", "未找到空间引用。");
    if (!isSpaceOwnedMaterial(item)) {
      throw new PanelHttpError(409, "space_reference_delete_unavailable", "外部文件夹和外部文件只能取消引用，不能由空间资产删除操作处理。");
    }
    await runtime.spaceReferenceLifecycleApplication.remove({ itemId });
    await runtime.flushSpaceKnowledgeSync();
    writeJson(response, 200, { ok: true });
    return true;
  }

  const unlinkReference = /^\/api\/spaces\/references\/([^/]+)\/unlink$/u.exec(url.pathname);
  if (unlinkReference !== null && request.method === "POST") {
    const itemId = decode(unlinkReference[1]);
    const item = await feature.queries.getReference(itemId);
    if (item === undefined) throw new PanelHttpError(404, "space_reference_not_found", "未找到空间引用。");
    if (!isExternalReference(item)) {
      throw new PanelHttpError(409, "space_reference_unlink_unavailable", "软件维护的空间材料不能通过外部引用操作取消。");
    }
    await runtime.spaceReferenceLifecycleApplication.unlink({ itemId: item.id });
    await runtime.flushSpaceKnowledgeSync();
    writeJson(response, 200, { ok: true });
    return true;
  }

  const openReference = /^\/api\/spaces\/references\/([^/]+)\/open$/u.exec(url.pathname);
  if (openReference !== null && request.method === "POST") {
    const item = await feature.queries.getReference(decode(openReference[1]));
    if (item === undefined) throw new PanelHttpError(404, "space_reference_not_found", "未找到空间引用。");
    runtime.spaceConversationDeletion.assertAvailable(item.spaceId);
    if (runtime.externalResourceOpener === undefined) {
      throw new PanelHttpError(501, "external_resource_open_unavailable", "当前运行方式不支持打开外部资源。");
    }
    if (item.reference.kind === "local_file" || item.reference.kind === "workspace") {
      const resolved = await resolveSpaceFilesystemReference(runtime, item);
      await runtime.externalResourceOpener({ kind: "path", value: resolved.path });
    } else if (item.reference.kind === "web_page") {
      await runtime.externalResourceOpener({ kind: "url", value: item.reference.url });
    } else {
      throw new PanelHttpError(409, "space_reference_not_openable", "这个引用需要由它的来源功能打开。");
    }
    writeJson(response, 200, { ok: true });
    return true;
  }

  const previewReference = /^\/api\/spaces\/references\/([^/]+)\/preview$/u.exec(url.pathname);
  if (previewReference !== null && request.method === "GET") {
    const item = await feature.queries.getReference(decode(previewReference[1]));
    if (item === undefined) throw new PanelHttpError(404, "space_reference_not_found", "未找到空间引用。");
    runtime.spaceConversationDeletion.assertAvailable(item.spaceId);
    const resolved = await resolveFilesystemReferenceIfNeeded(runtime, item);
    const preview = item.reference.kind === "managed_asset"
      ? attachSpaceReferenceMetadata(await getManagedAssetPreview(runtime.managedAssets.queries, item.reference.assetId, item.id), item)
      : await createPanelDocumentPreview(item, url.searchParams.get("path") ?? "", undefined, undefined, resolved);
    writeJson(response, 200, { ok: true, preview });
    return true;
  }

  const referenceContent = /^\/api\/spaces\/references\/([^/]+)\/content$/u.exec(url.pathname);
  if (referenceContent !== null && request.method === "GET") {
    const item = await feature.queries.getReference(decode(referenceContent[1]));
    if (item === undefined) throw new PanelHttpError(404, "space_reference_not_found", "未找到空间引用。");
    runtime.spaceConversationDeletion.assertAvailable(item.spaceId);
    const resolved = await resolveFilesystemReferenceIfNeeded(runtime, item);
    await writePanelSpaceReferenceContent(item, request, response, url.searchParams.get("path") ?? "", undefined, resolved);
    return true;
  }
  if (referenceContent !== null && request.method === "PUT") {
    const input = parse(
      updateTextSchema,
      await readJsonBody(request, { maxChars: DOCUMENT_TEXT_REQUEST_MAX_CHARS }),
      "引用文件内容无效。",
    );
    const preview = await runtime.spaceReferenceContentApplication.updateText({
      itemId: decode(referenceContent[1]),
      update: input,
    });
    writeJson(response, 200, { ok: true, preview });
    return true;
  }

  const referenceCaption = /^\/api\/spaces\/references\/([^/]+)\/caption$/u.exec(url.pathname);
  if (referenceCaption !== null && request.method === "PUT") {
    const input = parse(updateCaptionSchema, await readJsonBody(request), "图片说明编辑请求无效。");
    const preview = await runtime.spaceReferenceContentApplication.updateCaption({
      itemId: decode(referenceCaption[1]),
      update: input,
      actor: { kind: "user" },
    });
    writeJson(response, 200, { ok: true, preview });
    return true;
  }

  const referenceEntry = /^\/api\/spaces\/references\/([^/]+)\/entry$/u.exec(url.pathname);
  if (referenceEntry !== null && request.method === "POST") {
    const item = await feature.queries.getReference(decode(referenceEntry[1]));
    if (item === undefined) throw new PanelHttpError(404, "space_reference_not_found", "未找到空间引用。");
    const input = parse(createReferenceEntrySchema, await readJsonBody(request), "新建文件信息无效。");
    writeJson(response, 201, {
      ok: true,
      entry: await runtime.spaceReferenceContentApplication.createEntry({ itemId: item.id, ...input }),
    });
    return true;
  }
  if (referenceEntry !== null && request.method === "PATCH") {
    const item = await feature.queries.getReference(decode(referenceEntry[1]));
    if (item === undefined) throw new PanelHttpError(404, "space_reference_not_found", "未找到空间引用。");
    const input = parse(renameReferenceEntrySchema, await readJsonBody(request), "文件重命名信息无效。");
    writeJson(response, 200, {
      ok: true,
      entry: await runtime.spaceReferenceContentApplication.renameEntry({ itemId: item.id, ...input }),
    });
    return true;
  }
  if (referenceEntry !== null && request.method === "DELETE") {
    const item = await feature.queries.getReference(decode(referenceEntry[1]));
    if (item === undefined) throw new PanelHttpError(404, "space_reference_not_found", "未找到空间引用。");
    const input = parse(referenceEntrySchema, await readJsonBody(request), "文件删除信息无效。");
    await runtime.spaceReferenceContentApplication.deleteEntry({ itemId: item.id, relativePath: input.relativePath });
    writeJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

function isExternalReference(item: SpaceReferenceItem): boolean {
  return item.reference.kind === "local_file" ||
    item.reference.kind === "workspace" ||
    item.reference.kind === "web_page" ||
    item.reference.kind === "generated_artifact";
}

function isSpaceOwnedMaterial(item: SpaceReferenceItem): boolean {
  return !isExternalReference(item);
}

function isMovableSpaceMaterial(item: SpaceReferenceItem): boolean {
  return item.reference.kind !== "local_file" && item.reference.kind !== "workspace";
}

function absoluteLocalReference(
  reference: SpaceDirectReference,
): SpaceDirectReference {
  return reference.kind === "local_file"
    ? { ...reference, path: path.resolve(reference.path) }
    : reference;
}

async function resolveFilesystemReferenceIfNeeded(runtime: SpaceReferenceRouteDependencies, item: SpaceReferenceItem): Promise<ResolvedSpaceFilesystemReference | undefined> {
  return item.reference.kind === "local_file" || item.reference.kind === "workspace" || item.reference.kind === "managed_folder"
    ? await resolveSpaceFilesystemReference(runtime, item)
    : undefined;
}

function parse<T>(schema: z.ZodType<T>, raw: unknown, message: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new PanelHttpError(400, "invalid_space_input", message);
  return result.data;
}

function decode(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}

export function spaceFeatureHttpError(error: SpaceFeatureError): PanelHttpError {
  switch (error.code) {
    case "space_feature_released":
      return new PanelHttpError(503, "panel_runtime_quiescing", "面板正在关闭，不能接受新的请求。");
    case "space_not_found":
    case "space_reference_not_found":
      return new PanelHttpError(404, error.code, error.message);
    case "space_invalid_move":
    case "space_reference_membership_changed":
    case "space_id_collision":
    case "space_workspace_mount_conflict":
    case "space_asset_ownership_conflict":
    case "space_reference_image_caption_revision_conflict":
      return new PanelHttpError(409, error.code, error.message);
    case "space_invalid_input":
    case "space_reference_image_caption_invalid":
    case "space_reference_image_caption_too_large":
      return new PanelHttpError(400, error.code, error.message);
    case "space_snapshot_incompatible":
    case "space_deletion_journal_failure":
    case "space_deletion_recovery_failed":
    case "space_repository_failure":
      return new PanelHttpError(500, error.code, error.message);
  }
  // Keep this mapper total if a new domain error is added before its HTTP policy.
  return new PanelHttpError(500, "space_repository_failure", error.message);
}
