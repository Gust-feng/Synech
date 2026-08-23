import { promises as fs } from "node:fs";

import { isTransientRenameError } from "../values/error.js";

/**
 * 原子写入中「重试 rename」这一段的唯一事实源。
 *
 * 收敛范围说明：全仓有 6 处原子写实现，但它们在临时文件布局与持久化强度上存在
 * 真实差异，且这些差异被现有测试断言覆盖：
 *
 * - `file-system-config-store` 把临时文件放在目标同级目录并以 `.` 前缀命名；
 *   其测试断言临时文件名匹配 `^\.settings\.json\..+\.tmp$`。
 * - `conversation-control-repository` 与 Ordinary `file-system-repository` 把临时文件
 *   放进独立的 `.tmp/` 子目录，因为它们的枚举逻辑按 `entry.isDirectory()` 遍历同级目录，
 *   临时文件混入同级会污染枚举；其测试断言 `.tmp` 目录写后为空。
 * - `run-snapshot-store` 额外调用 `handle.sync()` 做 fsync，持久化强度高于其余实现。
 *
 * 因此这里不强行合并出一个带大量开关的「万能原子写」，只收敛各实现中逐字重复、
 * 且曾经出现语义分歧的重试段。临时文件布局与 fsync 策略仍由各 store 自己决定。
 */

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
