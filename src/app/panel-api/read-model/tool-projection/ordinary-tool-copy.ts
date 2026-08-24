export function cleanOrdinaryToolText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value
    .replace(/^(?:目标文件|目标|运行命令|执行命令|执行\s*Shell|命令|浏览网页|页面|搜索文件|搜索|查询|读取文件|浏览目录|编辑文件|写入文件|创建文件|删除文件)(?:未完成|已完成|完成|进行中)\s*[:：]\s*(.+?)(?:[。.]?)$/iu, "$1")
    .replace(/^(?:目标文件|目标|运行命令|执行命令|执行\s*Shell|命令|浏览网页|页面|搜索文件|搜索|查询|读取文件|浏览目录|编辑文件|写入文件|创建文件|删除文件|路径|文件)[:：]\s*/iu, "")
    .replace(/\s*·\s*exit\s+-?\d+\b/gi, "")
    .replace(/\bexit\s+-?\d+\b/gi, "")
    .replace(/\s*·\s*\d+\s*bytes\b/gi, "")
    .replace(/\b\d+\s*bytes\b/gi, "")
    .replace(/\s*·\s*\d+\s*->\s*\d+\s*chars\b/gi, "")
    .replace(/\b\d+\s*->\s*\d+\s*chars\b/gi, "")
    .replace(/\s*·\s*(\d+)\s+replacements?\b/gi, " · $1 处修改")
    .replace(/\b(\d+)\s+replacements?\b/gi, "$1 处修改")
    .replace(/\s*·\s*append(?:ed)?\b/gi, " · 追加写入")
    .replace(/\bappend(?:ed)?\b/gi, "追加写入")
    .replace(/\s*·\s*created\b/gi, " · 已创建")
    .replace(/\s*·\s*written\b/gi, " · 已写入")
    .replace(/\s*·\s*deleted\b/gi, " · 已删除")
    .replace(/\s*·\s*$/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned.length === 0 ? undefined : cleaned;
}
