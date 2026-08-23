import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { KnowledgeAssetReadResult, KnowledgePage } from "../personal-knowledge/index.js";
import type { SpaceReferenceItem } from "../spaces/index.js";
import { PanelHttpError } from "./http-utils.js";
import {
  MAX_TEXT_PREVIEW_BYTES,
  isKnownBinaryPath,
  joinRelativePath,
  mediaKindForMimeType,
  mimeTypeForPath,
  readFileText,
  resolveWithinRoot,
} from "../local-filesystem/index.js";
import type { LocalDocumentMeta } from "./local-document-preview.js";

const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const MAX_CAPTURE_ENTRIES = 5_000;

export async function captureKnowledgeAsset(
  root: string,
  assetId: string,
  item: SpaceReferenceItem,
  relativePath = "",
): Promise<NonNullable<KnowledgePage["asset"]>> {
  if (item.reference.kind !== "local_file" && item.reference.kind !== "workspace_folder" && item.reference.kind !== "managed_folder") {
    throw new PanelHttpError(409, "knowledge_asset_capture_unavailable", "当前来源暂不支持复制到知识库。");
  }
  let source: string;
  try {
    source = await resolveWithinRoot(item.reference.path, relativePath);
  } catch {
    throw new PanelHttpError(400, "invalid_space_reference_path", "引用子路径超出了文件夹范围。");
  }
  const stat = await fs.stat(source).catch(() => undefined);
  if (stat === undefined || (!stat.isFile() && !stat.isDirectory())) {
    throw new PanelHttpError(404, "knowledge_asset_source_missing", "来源文件已不存在。");
  }
  await validateCaptureSource(source);
  const assetDirectory = path.join(root, safeAssetId(assetId));
  const temporaryDirectory = `${assetDirectory}.pending-${randomUUID()}`;
  const content = path.join(temporaryDirectory, "content");
  await fs.mkdir(temporaryDirectory, { recursive: true });
  try {
    if (stat.isDirectory()) await fs.cp(source, content, {
      recursive: true,
      verbatimSymlinks: true,
      filter: async (candidate) => {
        const candidateStat = await fs.lstat(candidate);
        if (candidateStat.isSymbolicLink()) throw captureLimitError("知识库暂不复制符号链接。");
        return true;
      },
    });
    else await fs.copyFile(source, content);
    await fs.rename(temporaryDirectory, assetDirectory);
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    status: "managed",
    title: relativePath.length === 0 ? item.title : path.basename(source),
    sourceLabel: source,
    contentKind: stat.isDirectory() ? "directory" : "file",
    sourceReferenceId: item.id,
    sourceRelativePath: relativePath,
  };
}

export async function reconcileKnowledgeAssets(root: string, activeAssetIds: ReadonlySet<string>): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const activeDirectories = new Set([...activeAssetIds].map(safeAssetId));
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.name.includes(".pending-")) {
      await fs.rm(entryPath, { recursive: true, force: true });
      continue;
    }
    const deletingAt = entry.name.indexOf(".deleting-");
    if (deletingAt > 0) {
      const assetDirectoryName = entry.name.slice(0, deletingAt);
      if (!activeDirectories.has(assetDirectoryName)) {
        await fs.rm(entryPath, { recursive: true, force: true });
        continue;
      }
      const assetDirectory = path.join(root, assetDirectoryName);
      if (await exists(assetDirectory)) await fs.rm(entryPath, { recursive: true, force: true });
      else await fs.rename(entryPath, assetDirectory);
      continue;
    }
    if (!activeDirectories.has(entry.name)) {
      await fs.rm(entryPath, { recursive: true, force: true });
    }
  }
}

async function validateCaptureSource(source: string): Promise<void> {
  const queue = [source];
  let entries = 0;
  let bytes = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw captureLimitError("知识库暂不复制符号链接。");
    entries += 1;
    if (entries > MAX_CAPTURE_ENTRIES) throw captureLimitError(`收藏内容超过 ${MAX_CAPTURE_ENTRIES} 个条目，请选择更具体的文件或子文件夹。`);
    if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > MAX_CAPTURE_BYTES) throw captureLimitError("收藏内容超过 256 MiB，请选择更具体的文件或子文件夹。");
      continue;
    }
    if (!stat.isDirectory()) throw captureLimitError("知识库只支持普通文件和文件夹。");
    for (const child of await fs.readdir(current)) queue.push(path.join(current, child));
  }
}

function captureLimitError(message: string): PanelHttpError {
  return new PanelHttpError(409, "knowledge_asset_capture_limit", message);
}

export async function removeKnowledgeAsset(root: string, refId: string): Promise<void> {
  await fs.rm(path.join(root, safeAssetId(refId)), { recursive: true, force: true });
}

export async function stageKnowledgeAssetRemoval(
  root: string,
  refId: string,
): Promise<{ readonly commit: () => Promise<void>; readonly rollback: () => Promise<void> } | undefined> {
  const assetDirectory = path.join(root, safeAssetId(refId));
  const stat = await fs.lstat(assetDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat === undefined) return undefined;
  const stagedDirectory = `${assetDirectory}.deleting-${randomUUID()}`;
  await fs.rename(assetDirectory, stagedDirectory);
  return {
    commit: async () => {
      // The asset is already unreachable after the rename. Startup
      // reconciliation removes this directory if cleanup is interrupted.
      await fs.rm(stagedDirectory, { recursive: true, force: true }).catch(() => undefined);
    },
    rollback: async () => await fs.rename(stagedDirectory, assetDirectory),
  };
}

export function managedKnowledgeDocumentTarget(root: string, page: KnowledgePage): {
  readonly rootDir: string;
  readonly meta: LocalDocumentMeta;
  readonly mutationKey: string;
  readonly contentTypeHintPath: (relativePath: string) => string;
} {
  if (page.asset?.status !== "managed") throw new PanelHttpError(404, "knowledge_asset_not_found", "这条旧知识尚未生成托管副本。");
  const asset = page.asset;
  const content = path.join(root, safeAssetId(page.refId), "content");
  return {
    rootDir: content,
    meta: { itemId: page.refId, title: asset.title, sourceKind: "knowledge_asset" },
    mutationKey: content,
    contentTypeHintPath: (relativePath) => asset.contentKind === "directory" && relativePath.length > 0
      ? path.join(asset.sourceLabel, ...relativePath.split("/"))
      : asset.sourceLabel,
  };
}

const MAX_READ_PAGE_LENGTH = 30_000;
const MAX_READ_DIRECTORY_ENTRIES = 200;

/**
 * PersonalKnowledgeFeature 注入的托管资产机械读取端口：
 * 只做路径解析、目录扫描、MIME/文本分段，不参与知识业务判断。
 */
export async function readManagedKnowledgeAsset(
  root: string,
  page: KnowledgePage,
  input: { readonly relativePath: string; readonly maxLength?: number; readonly continuation?: string },
): Promise<KnowledgeAssetReadResult> {
  const target = managedKnowledgeDocumentTarget(root, page);
  const relativePath = normalizeReadPath(input.relativePath);
  let source: string;
  try {
    source = await resolveWithinRoot(target.rootDir, relativePath);
  } catch {
    return { status: "invalid", relativePath, message: "路径超出托管内容范围。" };
  }
  const stat = await fs.stat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat === undefined) return { status: "missing", relativePath, message: "托管内容已不存在。" };

  if (stat.isDirectory()) {
    const offset = readOffset(input.continuation);
    const pageLength = input.maxLength ?? MAX_READ_DIRECTORY_ENTRIES;
    const entries = await listManagedDirectory(source);
    const slice = entries.slice(offset, offset + pageLength).map((entry) => ({
      name: entry.name,
      relativePath: joinRelativePath(relativePath, entry.name),
      kind: entry.kind,
    }));
    const truncated = offset + slice.length < entries.length;
    return {
      status: "directory",
      relativePath,
      entries: slice,
      truncated,
      ...(truncated ? { continuation: String(offset + slice.length) } : {}),
    };
  }
  if (!stat.isFile()) {
    return { status: "unsupported", relativePath, message: "来源不再是普通文件。" };
  }

  const typePath = target.contentTypeHintPath(relativePath);
  const mediaKind = mediaKindForMimeType(mimeTypeForPath(typePath));
  if (mediaKind !== undefined) {
    return {
      status: "media",
      relativePath,
      mediaKind,
      mimeType: mimeTypeForPath(typePath),
      byteLength: stat.size,
      contentUrl: `/api/personal-knowledge/assets/${encodeURIComponent(page.refId)}/content${relativePath.length === 0 ? "" : `?path=${encodeURIComponent(relativePath)}`}`,
    };
  }
  if (isKnownBinaryPath(typePath)) {
    return { status: "unsupported", relativePath, message: "这个二进制文件暂不支持读取。" };
  }

  const offset = readOffset(input.continuation);
  const maxLength = input.maxLength ?? MAX_READ_PAGE_LENGTH;
  const maxBytes = Math.min(stat.size, Math.max(MAX_TEXT_PREVIEW_BYTES, offset + maxLength * 4));
  const preview = await readFileText(source, { maxBytes, typeHintPath: typePath });
  if (!preview.ok) return { status: "unsupported", relativePath, message: "内容不是可解码的文本。" };
  const text = preview.value.text.slice(offset, offset + maxLength);
  const truncated = preview.value.truncated || offset + text.length < preview.value.text.length;
  return {
    status: "text",
    relativePath,
    text,
    truncated,
    fingerprint: preview.value.fingerprint,
    byteLength: preview.value.byteLength,
    ...(preview.value.language === null ? {} : { language: preview.value.language }),
    ...(truncated ? { continuation: String(offset + text.length) } : {}),
  };
}

function normalizeReadPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function readOffset(continuation: string | undefined): number {
  if (continuation === undefined) return 0;
  const parsed = Number(continuation);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new PanelHttpError(400, "invalid_space_reference_path", "续读位置无效。");
  return parsed;
}

async function listManagedDirectory(source: string): Promise<readonly { readonly name: string; readonly kind: "file" | "directory" | "other" }[]> {
  const entries = await fs.readdir(source, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? "directory" as const : entry.isFile() ? "file" as const : "other" as const,
  })).sort((left, right) =>
    (left.kind === "directory" ? 0 : 1) - (right.kind === "directory" ? 0 : 1)
    || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
}

function safeAssetId(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function exists(value: string): Promise<boolean> {
  return await fs.lstat(value).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}
