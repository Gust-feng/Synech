/**
 * 统一文件读取模块。
 *
 * 从 space-reference-preview.ts 中提取的纯机械性文件读取函数：
 * MIME 识别、文本解码、fingerprint 计算、目录列表和文本预览。
 * 不包含任何 reference.kind 业务判断。
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { analyse } from "chardet";
import iconv from "iconv-lite";

import type { FsDirectoryListing, FsDirectoryEntry, FsResult, FsTextPreview } from "./local-filesystem-types.js";

export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
export const MAX_DIRECTORY_ENTRIES = 200;

/** 根据文件扩展名返回 MIME 类型。 */
export function mimeTypeForPath(value: string): string {
  switch (path.extname(value).toLowerCase()) {
    case ".md": return "text/markdown; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".ts": return "text/typescript; charset=utf-8";
    case ".tsx": return "text/tsx; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".ogg": return "audio/ogg";
    default: return "application/octet-stream";
  }
}

/** 根据 MIME 类型判断是否为可预览的媒体类型。 */
export function mediaKindForMimeType(mimeType: string): "image" | "pdf" | "video" | "audio" | undefined {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return undefined;
}

/** 根据文件路径判断是否为工作台支持的现代 Office 文档。 */
export function officeKindForPath(value: string): "docx" | "xlsx" | undefined {
  switch (path.extname(value).toLowerCase()) {
    case ".docx": return "docx";
    case ".xlsx": return "xlsx";
    default: return undefined;
  }
}

/** 根据文件路径推断代码语言。 */
export function languageForPath(value: string): { readonly language?: string } {
  const basename = path.basename(value).toLowerCase();
  const namedLanguage: Readonly<Record<string, string>> = {
    ".gitignore": "gitignore",
    ".gitattributes": "gitattributes",
    ".gitmodules": "gitmodules",
    ".editorconfig": "editorconfig",
    ".npmrc": "npmrc",
    ".nvmrc": "nvmrc",
    ".env": "dotenv",
    "dockerfile": "dockerfile",
    "makefile": "makefile",
    "license": "license",
  };
  if (namedLanguage[basename] !== undefined) return { language: namedLanguage[basename] };
  const extension = path.extname(value).toLowerCase().slice(1);
  const aliases: Readonly<Record<string, string>> = { jsonc: "json", mjs: "javascript", cjs: "javascript", js: "javascript", ts: "typescript", tsx: "typescript", py: "python", yml: "yaml", ps1: "powershell", sh: "shell" };
  return extension.length === 0 ? { language: "plaintext" } : { language: aliases[extension] ?? extension };
}

/** 判断路径是否为已知的文本文件（通过 MIME 或扩展名白名单）。 */
export function isKnownTextPath(value: string, mimeType: string): boolean {
  if (mimeType.startsWith("text/") || mimeType.startsWith("application/json")) return true;
  const basename = path.basename(value).toLowerCase();
  if ([".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc", ".nvmrc", ".env", "dockerfile", "makefile", "license"].includes(basename)) return true;
  return [
    ".csv", ".xml", ".yaml", ".yml", ".toml", ".ini", ".log", ".jsonc", ".jsonl",
    ".py", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".go", ".rs", ".rb", ".php",
    ".sh", ".bash", ".zsh", ".ps1", ".sql", ".graphql", ".vue", ".svelte",
  ].includes(path.extname(value).toLowerCase());
}

/** 判断路径是否为已知的二进制文件（不支持预览）。 */
export function isKnownBinaryPath(value: string): boolean {
  return [
    ".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".jar",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".iso",
    ".doc", ".xls", ".ppt", ".pptx",
    ".sqlite", ".db", ".woff", ".woff2", ".ttf", ".otf",
  ].includes(path.extname(value).toLowerCase());
}

/** 计算 Uint8Array 内容的 SHA-256 fingerprint。 */
export function contentFingerprint(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/**
 * 尝试将 Buffer 解码为文本。
 * @returns 解码结果（含编码名称），无法解码时返回 undefined。
 */
export function decodeTextPreview(body: Buffer, knownText: boolean, truncated = false): { readonly text: string; readonly encoding: string } | undefined {
  if (body.length === 0) return { text: "", encoding: "UTF-8" };
  if (body[0] === 0xff && body[1] === 0xfe) return { text: iconv.decode(body, "utf16-le"), encoding: "UTF-16LE" };
  if (body[0] === 0xfe && body[1] === 0xff) return { text: iconv.decode(body, "utf16-be"), encoding: "UTF-16BE" };
  if (looksBinary(body)) return undefined;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body).replace(/^\uFEFF/u, ""), encoding: "UTF-8" };
  } catch {
    if (truncated) {
      for (let trim = 1; trim <= Math.min(3, body.length); trim += 1) {
        try {
          return { text: new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, body.length - trim)).replace(/^\uFEFF/u, ""), encoding: "UTF-8" };
        } catch {
          // A UTF-8 scalar uses at most four bytes, so three tail retries are sufficient.
        }
      }
    }
    const minimumConfidence = knownText ? 50 : 80;
    const match = analyse(body).find((candidate) => candidate.confidence >= minimumConfidence && iconv.encodingExists(candidate.name));
    if (match === undefined) return undefined;
    return { text: iconv.decode(body, match.name), encoding: match.name };
  }
}

/**
 * 列出目录条目，按文件夹优先 + 字母排序，限制 200 条。
 */
export async function listDirectory(dirPath: string): Promise<FsResult<FsDirectoryListing>> {
  let allEntries: import("node:fs").Dirent[];
  try {
    allEntries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ok: false, error: { kind: "not_found" } };
    if (e.code === "ENOTDIR") return { ok: false, error: { kind: "not_directory" } };
    return { ok: false, error: { kind: "io_error", message: e.message } };
  }
  const sorted = allEntries
    .map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "directory" as const : entry.isFile() ? "file" as const : "other" as const,
    }))
    .sort((left, right) =>
      entryRank(left.kind) - entryRank(right.kind) ||
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
    )
    .slice(0, MAX_DIRECTORY_ENTRIES);
  const entries: FsDirectoryEntry[] = sorted;
  return { ok: true, value: { entries, truncated: allEntries.length > sorted.length } };
}

/**
 * 读取文件并生成文本预览，支持截断、fingerprint 计算、MIME/语言识别。
 *
 * @param filePath 绝对文件路径。
 * @param options.maxBytes 最大读取字节数（默认 512 KiB）。
 * @param options.typeHintPath 用于 MIME/语言识别的路径提示（资产无扩展名时使用原始文件名）。
 */
export async function readFileText(
  filePath: string,
  options?: { readonly maxBytes?: number; readonly typeHintPath?: string },
): Promise<FsResult<FsTextPreview>> {
  const maxBytes = options?.maxBytes ?? MAX_TEXT_PREVIEW_BYTES;
  const typePath = options?.typeHintPath ?? filePath;
  const stat = await fs.stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat === undefined) return { ok: false, error: { kind: "not_found" } };
  if (stat.isDirectory()) return { ok: false, error: { kind: "is_directory" } };
  if (!stat.isFile()) return { ok: false, error: { kind: "io_error", message: "Not a regular file." } };

  const mimeType = mimeTypeForPath(typePath);
  const handle = await fs.open(filePath, "r");
  try {
    const byteLimit = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0);
    const truncated = stat.size > bytesRead;
    const decoded = decodeTextPreview(buffer.subarray(0, bytesRead), isKnownTextPath(typePath, mimeType), truncated);
    if (decoded === undefined) {
      return { ok: false, error: { kind: "io_error", message: "File content is not decodable as text." } };
    }
    const fingerprint = !truncated
      ? contentFingerprint(buffer.subarray(0, bytesRead))
      : `${Math.trunc(stat.mtimeMs)}:${stat.size}`;
    return {
      ok: true,
      value: {
        text: decoded.text,
        encoding: decoded.encoding,
        truncated,
        byteLength: stat.size,
        fingerprint,
        language: languageForPath(typePath).language ?? null,
        mimeType,
      },
    };
  } finally {
    await handle.close();
  }
}

function looksBinary(body: Buffer): boolean {
  let controls = 0;
  for (const byte of body) {
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12) controls += 1;
  }
  return controls / body.length > 0.02;
}

function entryRank(kind: FsDirectoryEntry["kind"]): number {
  return kind === "directory" ? 0 : kind === "file" ? 1 : 2;
}
