import { promises as fs } from "node:fs";

import { isTransientRenameError } from "../values/error.js";

/** rename 重试的默认次数，覆盖 Windows 上常见的瞬时占用窗口。 */
const DEFAULT_MAX_ATTEMPTS = 6;

/**
 * 线性退避：25ms, 50ms, 75ms, 100ms, 125ms，总等待 375ms。
 *
 * 选择线性而非指数，是因为 Windows 上的占用窗口通常在百毫秒级，
 * 指数退避会在尾部产生不必要的长等待。
 */
function defaultBackoffMs(attempt: number): number {
  return 25 * attempt;
}

/**
 * 跨平台原子重命名；对 Windows 上偶发的可恢复错误做短退避重试。
 *
 * 背景：Windows 的 `fs.rename` 在目标文件被防病毒扫描、搜索索引器、备份程序或
 * 并发读句柄瞬时占用时，会抛 EPERM / EACCES / EBUSY / ENOTEMPTY，即使操作语义
 * 上完全合法。这是 Windows 文件系统原子写的已知平台差异（POSIX rename 原子且
 * 极少触发这些码）。对这几类瞬时错误重试，可让并发的 settings / run 记录写入
 * 稳定收敛，避免单次平台抖动导致整个 run 失败。
 *
 * 非瞬时错误立即抛出，不重试；重试耗尽后抛出最后一次的原始错误，保留 errno。
 */
export async function renameWithRetry(
  source: string,
  target: string,
  options?: {
    readonly maxAttempts?: number;
    readonly backoffMs?: (attempt: number) => number;
  },
): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options?.backoffMs ?? defaultBackoffMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientRenameError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
    }
  }
}
