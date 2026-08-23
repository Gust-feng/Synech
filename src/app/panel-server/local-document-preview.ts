/**
 * 本地文件/文件夹引用的共享预览、内容流式传输和文本编辑。
 *
 * 从 space-reference-preview.ts 和 space-reference-mutations.ts 中提取的
 * 本地文件系统预览构建逻辑。Space（用于 local_file / workspace_folder /
 * managed_folder 引用类型）和 Knowledge（用于受管资产文件夹）共同使用本模块，
 * 避免跨模块业务函数依赖。
 *
 * 路径安全由 local-filesystem 提供；本模块不包含 reference.kind 业务分派，
 * 只负责将文件系统事实转换为 DocumentPreview API 契约。
 */
import { promises as fs, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import { getResolvedPDFJS } from "unpdf";

import type { DocumentPreview, DocumentSourceKind } from "../panel-api-contracts.js";
import { PanelHttpError } from "./http-utils.js";
import { documentPresentation } from "./document-preview-presentation.js";
import {
  MAX_TEXT_PREVIEW_BYTES,
  resolveWithinRoot,
  normalizeRelativePath,
  joinRelativePath,
  mimeTypeForPath,
  mediaKindForMimeType,
  officeKindForPath,
  isKnownBinaryPath,
  listDirectory,
  readFileText,
  writeText,
} from "../local-filesystem/index.js";

/** 本地引用的元数据，用于填充 DocumentPreview 的标识字段。 */
export interface LocalDocumentMeta {
  readonly itemId: string;
  readonly title: string;
  readonly sourceKind: DocumentSourceKind;
}

/**
 * 构建本地文件/文件夹的预览。
 *
 * @param rootDir 挂载根目录绝对路径（local_file 时为文件路径本身，relativePath 必须为空）。
 * @param relativePath 相对于根目录的子路径。
 * @param meta 预览元数据（itemId、title、sourceKind）。
 * @param options.contentBaseUrl 媒体内容流式 URL 基础路径。
 * @param options.contentTypeHintPath MIME / 语言识别的类型提示路径（资产无扩展名时使用原始文件名）。
 */
export async function buildLocalDocumentPreview(
  rootDir: string,
  relativePath: string,
  meta: LocalDocumentMeta,
  options?: { readonly contentBaseUrl?: string; readonly contentTypeHintPath?: string },
): Promise<DocumentPreview> {
  const source = await resolveSource(rootDir, relativePath);
  const normalizedRelative = normalizeRelativePath(relativePath);

  const stat = await fs.stat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat === undefined) {
    return basePreview(meta, source, "missing", { kind: "unavailable", message: "来源路径已不存在或暂时不可用。" });
  }

  const statFingerprint = `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
  const metadata: Pick<DocumentPreview, "fingerprint" | "byteLength" | "modifiedAt"> = {
    fingerprint: statFingerprint,
    byteLength: stat.isFile() ? stat.size : undefined,
    modifiedAt: Math.trunc(stat.mtimeMs),
  };

  if (stat.isDirectory()) {
    const listing = await listDirectory(source);
    if (!listing.ok) {
      if (listing.error.kind === "not_found") {
        return basePreview(meta, source, "missing", { kind: "unavailable", message: "来源路径已不存在或暂时不可用。" });
      }
      throw new PanelHttpError(500, "space_reference_read_failed", "无法读取这个文件夹。");
    }
    const entries = listing.value.entries.map((entry) => ({
      name: entry.name,
      relativePath: joinRelativePath(normalizedRelative, entry.name),
      kind: entry.kind,
    }));
    return {
      ...basePreview(meta, source, "ready", {
        kind: "directory",
        relativePath: normalizedRelative,
        entries,
        truncated: listing.value.truncated,
      }),
      ...metadata,
    };
  }
  if (!stat.isFile()) {
    return basePreview(meta, source, "missing", { kind: "unavailable", message: "来源不再是普通文件。" });
  }

  // Managed single-file assets live at a stable `content` path with no
  // extension. The caller supplies the original source path as a format
  // hint; ordinary local references continue to classify their physical path.
  const typePath = options?.contentTypeHintPath ?? source;
  const mimeType = mimeTypeForPath(typePath);
  const contentUrl = options?.contentBaseUrl ?? `/api/spaces/references/${encodeURIComponent(meta.itemId)}/content`;
  const url = `${contentUrl}${normalizedRelative.length === 0 ? "" : `?path=${encodeURIComponent(normalizedRelative)}`}`;
  const mediaKind = mediaKindForMimeType(mimeType);
  if (mediaKind === "pdf") {
    const pages = await extractPdfTextPages(source, stat.size);
    if (pages !== undefined) {
      return {
        ...basePreview(meta, source, "ready", { kind: "pages", pages }),
        ...metadata,
      };
    }
  }
  if (mediaKind !== undefined) {
    return {
      ...basePreview(meta, source, "ready", {
        kind: "media",
        mediaKind,
        mimeType,
        url,
      }),
      ...metadata,
    };
  }
  const officeKind = officeKindForPath(typePath);
  if (officeKind !== undefined) {
    return {
      ...basePreview(meta, source, "ready", { kind: "office", officeKind, mimeType, url }),
      ...metadata,
    };
  }
  if (isKnownBinaryPath(typePath)) {
    return {
      ...basePreview(meta, source, "unsupported", { kind: "unavailable", message: "这个二进制文件暂不支持在工作台中预览。" }),
      ...metadata,
    };
  }

  const text = await readFileText(source, { typeHintPath: typePath });
  if (text.ok) {
    return {
      ...basePreview(meta, source, "ready", {
        kind: "text",
        text: text.value.text,
        encoding: text.value.encoding,
        truncated: text.value.truncated,
        editable: !text.value.truncated && text.value.encoding === "UTF-8",
        ...(text.value.language === null ? {} : { language: text.value.language }),
      }),
      ...metadata,
      fingerprint: text.value.fingerprint,
    };
  }

  return {
    ...basePreview(meta, source, "unsupported", { kind: "unavailable", message: "暂不支持在工作台中预览此文件类型。" }),
    ...metadata,
  };
}

/**
 * 将本地文件内容流式传输到 HTTP 响应，支持 Range 请求。
 *
 * @param rootDir 挂载根目录绝对路径。
 * @param relativePath 相对于根目录的子路径。
 * @param contentTypeHintPath MIME 识别的类型提示路径。
 */
export async function streamLocalDocumentContent(
  rootDir: string,
  relativePath: string,
  request: IncomingMessage,
  response: ServerResponse,
  contentTypeHintPath?: string,
): Promise<void> {
  const source = await resolveSource(rootDir, relativePath);
  const stat = await fs.stat(source).catch(() => undefined);
  if (stat?.isFile() !== true) throw new PanelHttpError(404, "space_reference_source_missing", "来源文件已不存在。");

  const range = parseByteRange(request.headers.range, stat.size);
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  response.statusCode = range === undefined ? 200 : 206;
  response.setHeader("content-type", mimeTypeForPath(contentTypeHintPath ?? source));
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", String(Math.max(0, end - start + 1)));
  if (range !== undefined) response.setHeader("content-range", `bytes ${start}-${end}/${stat.size}`);
  if (stat.size === 0) {
    response.end();
    return;
  }
  await pipeline(createReadStream(source, { start, end }), response);
}

/**
 * 以 CAS 方式原子更新本地文件文本，并返回更新后的预览。
 *
 * 校验文件可编辑性（UTF-8 编码、大小限制）和指纹一致性后执行原子写入，
 * 成功后重新构建预览返回。
 */
export async function updateLocalDocumentText(
  rootDir: string,
  relativePath: string,
  input: { readonly expectedFingerprint: string; readonly text: string },
  meta: LocalDocumentMeta,
  options?: { readonly contentBaseUrl?: string; readonly contentTypeHintPath?: string },
): Promise<DocumentPreview> {
  const source = await resolveSource(rootDir, relativePath);
  const stat = await fs.stat(source).catch(() => undefined);
  if (stat?.isFile() !== true) throw new PanelHttpError(404, "space_reference_source_missing", "来源文件已不存在。");
  if (stat.size > MAX_TEXT_PREVIEW_BYTES || Buffer.byteLength(input.text, "utf8") > MAX_TEXT_PREVIEW_BYTES) {
    throw new PanelHttpError(409, "space_reference_not_editable", "这个文件不能在工作台中编辑。");
  }

  const typePath = options?.contentTypeHintPath ?? source;
  const current = await readFileText(source, { maxBytes: MAX_TEXT_PREVIEW_BYTES, typeHintPath: typePath });
  if (!current.ok || current.value.truncated || current.value.encoding !== "UTF-8") {
    throw new PanelHttpError(409, "space_reference_not_editable", "这个文件不能在工作台中编辑。");
  }

  const result = await writeText(source, input.text, input.expectedFingerprint);
  if (!result.ok) {
    const error = result.error;
    if (error.kind === "fingerprint_mismatch") {
      throw new PanelHttpError(409, "space_reference_revision_conflict", "来源文件已发生变化，请先比较更改。");
    }
    if (error.kind === "not_found") {
      throw new PanelHttpError(404, "space_reference_source_missing", "来源文件已不存在。");
    }
    throw new PanelHttpError(500, "space_reference_not_editable", "无法保存文件更改。");
  }

  const updatedStat = await fs.stat(source).catch(() => undefined);
  const byteLength = Buffer.byteLength(input.text, "utf8");
  const mimeType = mimeTypeForPath(typePath);
  const mediaKind = mediaKindForMimeType(mimeType);
  if (mediaKind !== undefined) {
    const normalizedRelative = normalizeRelativePath(relativePath);
    const contentUrl = options?.contentBaseUrl ?? `/api/spaces/references/${encodeURIComponent(meta.itemId)}/content`;
    return {
      ...basePreview(meta, source, "ready", {
        kind: "media",
        mediaKind,
        mimeType,
        url: `${contentUrl}${normalizedRelative.length === 0 ? "" : `?path=${encodeURIComponent(normalizedRelative)}`}`,
      }),
      fingerprint: result.value.fingerprint,
      byteLength,
      ...(updatedStat === undefined ? {} : { modifiedAt: Math.trunc(updatedStat.mtimeMs) }),
    };
  }
  const content: Extract<DocumentPreview["content"], { readonly kind: "text" }> = {
    kind: "text",
    text: input.text,
    encoding: "UTF-8",
    truncated: false,
    editable: true,
    ...(current.value.language === null ? {} : { language: current.value.language }),
  };
  return {
    ...basePreview(meta, source, "ready", content),
    fingerprint: result.value.fingerprint,
    byteLength,
    ...(updatedStat === undefined ? {} : { modifiedAt: Math.trunc(updatedStat.mtimeMs) }),
  };
}

// ─── helpers ──────────────────────────────────────────────────────

function basePreview(
  meta: LocalDocumentMeta,
  source: string,
  status: DocumentPreview["status"],
  content: DocumentPreview["content"],
): DocumentPreview {
  return {
    itemId: meta.itemId,
    title: meta.title,
    sourceKind: meta.sourceKind,
    source,
    status,
    presentation: documentPresentation(content),
    content,
  };
}

async function resolveSource(rootDir: string, relativePath: string): Promise<string> {
  try {
    return await resolveWithinRoot(rootDir, relativePath);
  } catch {
    throw new PanelHttpError(400, "invalid_space_reference_path", "引用子路径超出了文件夹范围。");
  }
}

function parseByteRange(value: string | undefined, size: number): { readonly start: number; readonly end: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null || size <= 0) throw new PanelHttpError(416, "invalid_space_reference_range", "请求的文件范围无效。");
  const rawStart = match[1];
  const rawEnd = match[2];
  let start: number;
  let end: number;
  if (rawStart.length === 0) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new PanelHttpError(416, "invalid_space_reference_range", "请求的文件范围无效。");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd.length === 0 ? size - 1 : Number(rawEnd);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw new PanelHttpError(416, "invalid_space_reference_range", "请求的文件范围无效。");
  }
  return { start, end: Math.min(end, size - 1) };
}

/** PDF 文本分页提取；文件过大或解析失败时返回 undefined，让调用方降级为媒体预览。 */
async function extractPdfTextPages(source: string, size: number): Promise<string[] | undefined> {
  if (size <= 0 || size > MAX_PDF_PREVIEW_BYTES) return undefined;
  try {
    const buffer = await fs.readFile(source);
    const pdfjs = await getResolvedPDFJS();
    const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const fragments: string[] = [];
        for (const item of content.items) {
          if (!("str" in item) || typeof item.str !== "string" || item.str.length === 0) continue;
          fragments.push(item.str, item.hasEOL ? "\n" : " ");
        }
        pages.push(fragments.join(""));
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } catch {
    return undefined;
  }
}

const MAX_PDF_PREVIEW_BYTES = 64 * 1_024 * 1_024;
