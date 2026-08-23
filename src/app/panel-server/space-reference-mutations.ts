/**
 * 空间引用的文件系统变更操作。
 *
 * 本模块只包含会改变磁盘状态的操作：编辑文本、重命名、新建、删除。
 * 读取、预览和内容流式传输在 space-reference-preview.ts。
 *
 * 路径安全由 local-filesystem 提供；文件写入操作委托给该模块的
 * 中性函数（renameEntry / createFile / createDirectory / deleteEntry），
 * 文本编辑委托给 local-document-preview.ts 的 updateLocalDocumentText。
 * 业务错误映射在本模块完成。
 */
import path from "node:path";

import type { DocumentPreview } from "../panel-api-contracts.js";
import type { SpaceReferenceItem } from "../spaces/index.js";
import { PanelHttpError } from "./http-utils.js";
import type { LocalDocumentMeta } from "./local-document-preview.js";
import { updateLocalDocumentText } from "./local-document-preview.js";
import {
  normalizeRelativePath,
  joinRelativePath,
  resolveWithinRoot,
  resolveDestinationWithinRoot,
  renameEntry,
  createFile,
  createDirectory,
  deleteEntry,
} from "../local-filesystem/index.js";

export async function updatePanelSpaceReferenceText(
  item: SpaceReferenceItem,
  input: { readonly relativePath?: string; readonly expectedFingerprint: string; readonly text: string },
  previewOptions?: { readonly contentBaseUrl?: string; readonly contentTypeHintPath?: string },
): Promise<DocumentPreview> {
  if (item.reference.kind !== "local_file" && item.reference.kind !== "workspace_folder" && item.reference.kind !== "managed_folder") {
    throw new PanelHttpError(409, "space_reference_content_unavailable", "这个引用没有可读取的文件内容。");
  }
  const relativePath = input.relativePath ?? "";
  const meta: LocalDocumentMeta = { itemId: item.id, title: item.title, sourceKind: item.reference.kind };
  const normalized = safeNormalize(relativePath);
  if (item.reference.kind === "local_file" && normalized.length > 0) {
    throw new PanelHttpError(400, "invalid_space_reference_path", "文件引用不接受子路径。");
  }
  return updateLocalDocumentText(
    item.reference.path,
    normalized,
    { expectedFingerprint: input.expectedFingerprint, text: input.text },
    meta,
    previewOptions,
  );
}

export async function renamePanelSpaceReferenceEntry(
  item: SpaceReferenceItem,
  input: { readonly relativePath: string; readonly name: string },
): Promise<{ readonly relativePath: string }> {
  const relativePath = normalizeMutableEntryPath(item, input.relativePath);
  const name = normalizeEntryName(input.name);
  const source = await resolveMutableSource(item, relativePath);

  const parentRelativePath = path.posix.dirname(relativePath) === "." ? "" : path.posix.dirname(relativePath);
  const destinationRelativePath = safeJoinRelative(parentRelativePath, name);
  if (destinationRelativePath === relativePath) return { relativePath };

  const destination = await resolveMutableDestination(item, destinationRelativePath);
  const result = await renameEntry(source, destination);
  if (!result.ok) {
    const error = result.error;
    if (error.kind === "not_found") throw new PanelHttpError(404, "space_reference_source_missing", "来源文件已不存在。");
    if (error.kind === "already_exists") throw new PanelHttpError(409, "space_reference_entry_exists", "同一文件夹中已存在这个名字。");
    throw new PanelHttpError(500, "space_reference_mutation_failed", "无法重命名这个文件系统条目。");
  }
  return { relativePath: destinationRelativePath };
}

export async function deletePanelSpaceReferenceEntry(
  item: SpaceReferenceItem,
  relativePathValue: string,
): Promise<void> {
  const relativePath = normalizeMutableEntryPath(item, relativePathValue);
  const source = await resolveMutableSource(item, relativePath);
  const result = await deleteEntry(source);
  if (!result.ok) {
    if (result.error.kind === "not_found") {
      throw new PanelHttpError(404, "space_reference_source_missing", "来源文件已不存在。");
    }
    throw new PanelHttpError(500, "space_reference_mutation_failed", "无法删除这个文件系统条目。");
  }
}

export async function createPanelSpaceReferenceEntry(
  item: SpaceReferenceItem,
  input: { readonly parentRelativePath: string; readonly name: string; readonly kind: "file" | "directory" },
): Promise<{ readonly relativePath: string }> {
  if (item.reference.kind !== "workspace_folder" && item.reference.kind !== "managed_folder") {
    throw new PanelHttpError(409, "space_reference_entry_mutation_unavailable", "只有工作区或软件受管文件夹中可以新建文件。");
  }
  const parentRelativePath = safeNormalize(input.parentRelativePath);
  const relativePath = safeJoinRelative(parentRelativePath, normalizeEntryName(input.name));
  const destination = await resolveMutableDestination(item, relativePath);
  const result = input.kind === "directory" ? await createDirectory(destination) : await createFile(destination);
  if (!result.ok) {
    if (result.error.kind === "already_exists") {
      throw new PanelHttpError(409, "space_reference_entry_exists", "同一文件夹中已存在这个名字。");
    }
    throw new PanelHttpError(500, "space_reference_mutation_failed", "无法创建这个文件系统条目。");
  }
  return { relativePath };
}

// ─── helpers ──────────────────────────────────────────────────────

function normalizeMutableEntryPath(item: SpaceReferenceItem, value: string): string {
  if (item.reference.kind !== "workspace_folder" && item.reference.kind !== "managed_folder") {
    throw new PanelHttpError(409, "space_reference_entry_mutation_unavailable", "只有工作区或软件受管文件夹中的条目可以执行此操作。");
  }
  const normalized = safeNormalize(value);
  if (normalized.length === 0) throw new PanelHttpError(400, "invalid_space_reference_path", "不能修改工作区根目录。");
  return normalized;
}

function normalizeEntryName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 255 || name === "." || name === ".." || /[\\/:*?"<>|]/u.test(name)) {
    throw new PanelHttpError(400, "invalid_space_reference_name", "文件名称无效。");
  }
  return name;
}

function safeNormalize(value: string): string {
  try {
    return normalizeRelativePath(value);
  } catch {
    throw new PanelHttpError(400, "invalid_space_reference_path", "引用子路径无效。");
  }
}

function safeJoinRelative(parent: string, child: string): string {
  try {
    return joinRelativePath(parent, child);
  } catch {
    throw new PanelHttpError(400, "invalid_space_reference_path", "引用子路径无效。");
  }
}

async function resolveMutableSource(item: SpaceReferenceItem, relativePath: string): Promise<string> {
  if (item.reference.kind !== "workspace_folder" && item.reference.kind !== "managed_folder") {
    throw new PanelHttpError(409, "space_reference_entry_mutation_unavailable", "只有工作区或软件受管文件夹中的条目可以执行此操作。");
  }
  try {
    return await resolveWithinRoot(item.reference.path, relativePath);
  } catch {
    throw new PanelHttpError(400, "invalid_space_reference_path", "引用子路径超出了文件夹范围。");
  }
}

async function resolveMutableDestination(item: SpaceReferenceItem, relativePath: string): Promise<string> {
  if (item.reference.kind !== "workspace_folder" && item.reference.kind !== "managed_folder") {
    throw new PanelHttpError(409, "space_reference_entry_mutation_unavailable", "只有工作区或软件受管文件夹中的条目可以执行此操作。");
  }
  try {
    return await resolveDestinationWithinRoot(item.reference.path, relativePath);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Root directory does not exist")) {
      throw new PanelHttpError(404, "space_reference_source_missing", "工作区文件夹已不存在。");
    }
    throw new PanelHttpError(400, "invalid_space_reference_path", "引用子路径超出了文件夹范围。");
  }
}
