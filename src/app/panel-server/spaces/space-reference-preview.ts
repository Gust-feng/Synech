/**
 * Space 引用预览的业务分派层。
 *
 * 本模块只负责 `reference.kind` 业务分派：
 * - web_page / 非本地类型直接返回对应预览或 unsupported
 * - local_file / Workspace / managed_folder 委托给
 *   local-document-preview.ts 的共享本地文件系统预览逻辑
 *
 * 纯机械性文件系统操作（路径安全、MIME 识别、文本解码、指纹计算等）
 * 已提取到 local-filesystem 中性模块。本文件不再导出这些函数。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { DocumentPreview } from "../../panel-api/workbench.js";
import type { SpaceReferenceItem } from "../../spaces/index.js";
import { PanelHttpError } from "../http-utils.js";
import {
  buildLocalDocumentPreview,
  streamLocalDocumentContent,
  type LocalDocumentMeta,
} from "../storage/local-document-preview.js";
import { normalizeRelativePath } from "../../local-filesystem/index.js";
import { documentPresentation } from "../storage/document-preview-presentation.js";
import type { ResolvedSpaceFilesystemReference } from "./space-workspace-reference.js";

export type PanelDocumentPreview = DocumentPreview;

/**
 * Space 引用预览：来源事实与 Agent 整理内容分离投影。
 * annotation 是额外展示字段，永远不映射进 `content`（来源正文）。
 */
export async function createPanelDocumentPreview(
  item: SpaceReferenceItem,
  relativePath = "",
  contentBaseUrl?: string,
  contentTypeHintPath?: string,
  resolved?: ResolvedSpaceFilesystemReference,
): Promise<PanelDocumentPreview> {
  const normalizedRelativePath = item.reference.kind === "local_file"
    || item.reference.kind === "workspace"
    || item.reference.kind === "managed_folder"
    ? safeNormalizeRelativePath(relativePath)
    : relativePath;
  const preview = await buildPanelDocumentPreview(item, normalizedRelativePath, contentBaseUrl, contentTypeHintPath, resolved);
  return attachSpaceReferenceMetadata(preview, item, normalizedRelativePath);
}

/** 把 Space 自己的 annotation / 图片说明附加到投影，不改变来源文件。 */
export function attachSpaceReferenceMetadata(
  preview: PanelDocumentPreview,
  item: SpaceReferenceItem,
  relativePath = "",
): PanelDocumentPreview {
  const annotated = item.annotation === undefined ? preview : { ...preview, annotation: item.annotation };
  if (item.reference.kind === "managed_asset" || annotated.content.kind !== "media" || annotated.content.mediaKind !== "image") {
    return annotated;
  }
  const caption = item.imageCaptions?.[relativePath];
  return {
    ...annotated,
    content: {
      ...annotated.content,
      ...(caption?.text ? { caption: caption.text } : {}),
      captionEditable: true,
      captionFingerprint: `space-image-caption:${caption?.revision ?? 0}`,
    },
  };
}

async function buildPanelDocumentPreview(
  item: SpaceReferenceItem,
  relativePath: string,
  contentBaseUrl?: string,
  contentTypeHintPath?: string,
  resolved?: ResolvedSpaceFilesystemReference,
): Promise<DocumentPreview> {
  if (item.reference.kind === "web_page") {
    const content = { kind: "web" as const, url: item.reference.url };
    return {
      itemId: item.id,
      title: item.title,
      sourceKind: item.reference.kind,
      source: item.reference.url,
      status: "ready",
      presentation: documentPresentation(content),
      content,
    };
  }
  if (item.reference.kind !== "local_file" && item.reference.kind !== "workspace" && item.reference.kind !== "managed_folder") {
    const content = { kind: "unavailable" as const, message: "这个引用需要由它的来源功能提供预览。" };
    return {
      itemId: item.id,
      title: item.title,
      sourceKind: item.reference.kind,
      source: referenceSource(item),
      status: "unsupported",
      presentation: documentPresentation(content),
      content,
    };
  }

  const meta: LocalDocumentMeta = { itemId: item.id, title: item.title, sourceKind: item.reference.kind };
  const rootPath = resolved?.path ?? (item.reference.kind === "workspace" ? undefined : item.reference.path);
  if (rootPath === undefined) throw new PanelHttpError(409, "workspace_not_available", "工作区当前不可用。");
  if (item.reference.kind === "local_file" && relativePath.length > 0) {
    throw new PanelHttpError(400, "invalid_space_reference_path", "文件引用不接受子路径。");
  }
  return buildLocalDocumentPreview(rootPath, relativePath, meta, { contentBaseUrl, contentTypeHintPath });
}

export async function writePanelSpaceReferenceContent(
  item: SpaceReferenceItem,
  request: IncomingMessage,
  response: ServerResponse,
  relativePath = "",
  contentTypeHintPath?: string,
  resolved?: ResolvedSpaceFilesystemReference,
): Promise<void> {
  if (item.reference.kind !== "local_file" && item.reference.kind !== "workspace" && item.reference.kind !== "managed_folder") {
    throw new PanelHttpError(409, "space_reference_content_unavailable", "这个引用没有可读取的文件内容。");
  }
  const normalized = safeNormalizeRelativePath(relativePath);
  if (item.reference.kind === "local_file" && normalized.length > 0) {
    throw new PanelHttpError(400, "invalid_space_reference_path", "文件引用不接受子路径。");
  }
  const rootPath = resolved?.path ?? (item.reference.kind === "workspace" ? undefined : item.reference.path);
  if (rootPath === undefined) throw new PanelHttpError(409, "workspace_not_available", "工作区当前不可用。");
  await streamLocalDocumentContent(rootPath, normalized, request, response, contentTypeHintPath);
}

function referenceSource(item: SpaceReferenceItem): string {
  switch (item.reference.kind) {
    case "local_file":
    case "managed_folder": return item.reference.path;
    case "workspace": return item.reference.workspaceId;
    case "asset_folder": return item.title;
    case "managed_asset": return item.reference.assetId;
    case "web_page": return item.reference.url;
    case "generated_artifact": return item.reference.artifactRef;
  }
}

function safeNormalizeRelativePath(value: string): string {
  try {
    return normalizeRelativePath(value);
  } catch {
    throw new PanelHttpError(400, "invalid_space_reference_path", "引用子路径无效。");
  }
}
