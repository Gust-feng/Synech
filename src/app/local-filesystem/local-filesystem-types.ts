/**
 * 中性文件系统操作的类型定义。
 *
 * 这些类型不依赖任何 Space/Knowledge 业务概念，只描述文件系统的机械事实。
 */

/** 标准目录条目。 */
export interface FsDirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
}

/** 标准操作结果。 */
export type FsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FsError };

/** 中性文件系统错误，由调用方映射为各自的业务错误。 */
export type FsError =
  | { readonly kind: "not_found" }
  | { readonly kind: "already_exists" }
  | { readonly kind: "is_directory" }
  | { readonly kind: "not_directory" }
  | { readonly kind: "fingerprint_mismatch"; readonly expected: string; readonly actual: string }
  | { readonly kind: "io_error"; readonly message: string };

/** 文件内容文本预览。 */
export interface FsTextPreview {
  readonly text: string;
  readonly truncated: boolean;
  readonly byteLength: number;
  readonly fingerprint: string;
  readonly language: string | null;
  readonly mimeType: string;
  readonly encoding: string;
}

/** 目录列表结果，包含条目和是否被截断。 */
export interface FsDirectoryListing {
  readonly entries: readonly FsDirectoryEntry[];
  readonly truncated: boolean;
}
