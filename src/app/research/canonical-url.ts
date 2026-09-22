/**
 * 来源去重键（canonical URL）的唯一实现。
 *
 * 去重是框架职责（ADR 0001 §2.1 / §2.8）：同一任务内 canonical URL 相同的检索结果
 * 是同一条来源，重复入列会污染来源统计与引用编号。规则只能有一份实现——仓储按它写
 * `research_source_entry.canonical_url` 的唯一键，研究 loop 的检索工具按它判定
 * 「这条结果是否已经在账本里」，两边算出不同的键会让去重事实说谎。
 */

/** 去重键：忽略协议/主机大小写、hash 与 utm 参数；无法解析的 URL 不入列。 */
export function canonicalizeUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
