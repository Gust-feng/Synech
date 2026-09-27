/**
 * 相对时间标签（界面展示用）：工作台各 feature 共用一份口径。
 *
 * 研究记录、空间条目都显示「刚刚 / N 分钟前 / N 小时前 / 月-日」——
 * 同一个时间事实不得在两个页面长出两套阈值。纯函数，`now` 可注入以便测试。
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp
  if (diff < 60_000) return '刚刚'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
