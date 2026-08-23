/**
 * 错误判定与消息提取的唯一事实源。
 *
 * 收敛前 `errorMessage` 有 15 处实现、`isNodeError` 6 处、`isFileNotFound` 7 处、
 * `isTransientRenameError` 4 处。其中 `isTransientRenameError` 的错误码集合在各实现间
 * 并不一致，已导致 Windows 上配置写入不重试的真实缺陷（详见开发指南
 * `06-工程实现/16-共享工具层收敛与重复实现治理.md`）。
 */

/** 提取错误的可读消息；非 `Error` 值退回 `String(value)`，始终返回字符串。 */
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** 判断错误是否携带指定的 Node `errno` 码。 */
export function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

/** 判断错误是否为“文件或目录不存在”（`ENOENT`）。 */
export function isFileNotFound(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

/**
 * 跨平台可重试的 rename 瞬时错误码。
 *
 * Windows 的 `fs.rename` 在目标文件被防病毒扫描、搜索索引器、备份程序或并发读句柄
 * 瞬时占用时，会抛 EPERM / EACCES / EBUSY / ENOTEMPTY，即使操作语义上完全合法。
 * 这是 Windows 文件系统原子写的已知平台差异（POSIX rename 原子且极少触发这些码）。
 *
 * 收敛前各实现只覆盖其中一个子集：配置存储缺 `EBUSY`，其余三处缺 `ENOTEMPTY`，
 * 导致 Windows 上配置写入遇到 `EBUSY` 时直接失败而不重试。此处取四码并集。
 */
const TRANSIENT_RENAME_CODES: readonly string[] = ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"];

/** 判断 rename 错误是否属于可通过短退避重试恢复的平台瞬时错误。 */
export function isTransientRenameError(error: unknown): boolean {
  return TRANSIENT_RENAME_CODES.some((code) => isNodeError(error, code));
}
