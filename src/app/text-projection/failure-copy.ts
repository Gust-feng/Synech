/**
 * 失败文案不做归因、不做兜底、也不改写厂商或 SDK 的说法。
 *
 * 原则：返回什么就显示什么；什么都没返回就空着。分类（failureKind）只用于程序
 * 分支（是否可重试），不参与文案。
 */
export function friendlyFailureCopy(value: string): string {
  return value.trim();
}
