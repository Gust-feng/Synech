/**
 * 中性文件系统能力统一入口。
 *
 * 本模块提供纯粹的机械性文件系统操作，不依赖任何 Space/Knowledge 业务概念：
 * - 路径安全（逃逸防止、规范化、同一路径判断）
 * - 文件读取（MIME 识别、文本解码、指纹计算、目录列表、文本预览）
 * - 文件写入（CAS 原子写入、排他创建、重命名、递归删除）
 *
 * 所有操作返回 FsResult 或抛出 plain Error（路径逃逸），
 * 调用方负责将结果映射为各自的业务错误。
 */
export type {
  FsDirectoryEntry,
  FsResult,
  FsError,
  FsTextPreview,
  FsDirectoryListing,
} from "./local-filesystem-types.js";

export {
  normalizeRelativePath,
  joinRelativePath,
  isWithinRoot,
  resolveWithinRoot,
  resolveDestinationWithinRoot,
  samePathIdentity,
} from "./local-filesystem-path.js";

export {
  MAX_TEXT_PREVIEW_BYTES,
  MAX_DIRECTORY_ENTRIES,
  mimeTypeForPath,
  mediaKindForMimeType,
  officeKindForPath,
  languageForPath,
  isKnownTextPath,
  isKnownBinaryPath,
  contentFingerprint,
  decodeTextPreview,
  listDirectory,
  readFileText,
} from "./local-filesystem-read.js";

export {
  writeText,
  createFile,
  createDirectory,
  renameEntry,
  deleteEntry,
} from "./local-filesystem-write.js";
