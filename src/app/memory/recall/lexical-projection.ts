/**
 * Lexical projection（《手册》16.2）：汉字 bigram + 拉丁词标准化。
 *
 * 与离线评测工具链同源：算法与 `scripts/eval-run.mjs` 的 `lexicalProjection`
 * 逐行一致（T11 检索基线验证过的实现）。unicode61 分词器下直接存中文原文
 * 等于把整句当作一个 token，无法匹配，因此写入 FTS 前先把文本投影为
 * 汉字 bigram + 小写拉丁词的 token 序列。
 *
 * 本文件是运行时投影的唯一 owner；评测脚本保留独立副本（scripts 不允许被
 * src import，见 scripts/check-architecture-baseline.mjs 的依赖方向规则），
 * 两侧算法必须同步修改。
 */

/** 拉丁词（含数字/下划线）与小写化；汉字连续段切成 bigram，单字保留。 */
export function lexicalProjection(text: string): readonly string[] {
  const tokens = new Set<string>();
  for (const word of text.match(/[A-Za-z0-9_]+/g) ?? []) tokens.add(word.toLowerCase());
  for (const run of text.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens];
}

/**
 * 投影为 FTS5 MATCH 表达式（OR 连接 + 引号转义）。
 * bigram 查询用 OR + bm25 排序：包含更多查询 bigram 的记录排名更高；
 * AND 会在长查询上过度严格（缺任一 bigram 即全灭），不适合作召回基线
 * （与 eval-run.mjs 的 ftsMatchQuery 同源同注释）。
 */
export function lexicalMatchExpression(text: string): string {
  return lexicalProjection(text)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}
