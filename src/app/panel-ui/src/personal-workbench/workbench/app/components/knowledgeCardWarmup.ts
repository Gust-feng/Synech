import { useEffect } from 'react'
import { prefetchDocumentSurface } from './documentPreviewWarmup'
import {
  fetchDocumentPreview,
  getCachedReferencePreview,
  type DocumentPreview,
} from './referencePreviewClient'
import type { ResolvedPage } from './brainStore'

/**
 * 知识卡片网格的有界预热。
 *
 * 卡片封面（图片、PDF 首页、视频首帧、Office 渲染、正文摘录）依赖
 * `/api/personal-knowledge/assets/:id/preview`；该投影原本只在打开阅读视图时
 * 才会被拉取，网格本身只读缓存。没有网格级预热时，未打开过的卡片只能显示
 * 占位：图片空白、PDF 只剩灰条、文档没有正文。本模块在网格可见集合变化时，
 * 按可见顺序补拉轻量元数据，再以更小的预算预热重型渲染（PDF 首页 / 视频
 * 首帧 / Office 解析 / 图片解码），全程有总量上限、客户端单飞合并与失败
 * 冷却，不会演变成全量扫描。
 */

const MAX_METADATA_PREVIEWS = 30
const MAX_SURFACE_PREVIEWS = 12
const MAX_CONCURRENT_METADATA = 2
const ERROR_RETRY_COOLDOWN_MS = 30_000

type WarmupTarget = {
  readonly itemId: string
  readonly apiBase: string
}

let warmupGeneration = 0
const failureTimestamps = new Map<string, number>()

/** 按当前可见顺序挑出仍需元数据的知识资产，去重并限制总量。 */
export function collectKnowledgeWarmupTargets(pages: readonly ResolvedPage[]): WarmupTarget[] {
  const targets: WarmupTarget[] = []
  const seen = new Set<string>()
  const now = Date.now()
  for (const page of pages) {
    const target = page.documentTarget
    if (target === undefined) continue
    const key = `${target.apiBase}\u0000${target.itemId}`
    if (seen.has(key)) continue
    if (getCachedReferencePreview(target.itemId, '', target.apiBase) !== undefined) continue
    const failedAt = failureTimestamps.get(key)
    if (failedAt !== undefined && now - failedAt < ERROR_RETRY_COOLDOWN_MS) continue
    seen.add(key)
    targets.push(target)
    if (targets.length >= MAX_METADATA_PREVIEWS) break
  }
  return targets
}

/** 启动一轮预热；可见集合变化时旧轮次不再调度新任务（在飞请求由客户端单飞合并）。 */
export function warmKnowledgeCardPreviews(pages: readonly ResolvedPage[]): () => void {
  const targets = collectKnowledgeWarmupTargets(pages)
  if (targets.length === 0) return () => undefined
  const generation = ++warmupGeneration
  const abortController = new AbortController()
  window.setTimeout(() => {
    void runWarmup(generation, targets, abortController.signal)
  }, 0)
  return () => {
    abortController.abort()
    if (warmupGeneration === generation) warmupGeneration += 1
  }
}

/** React 绑定：可见卡片集合变化即重排预热队列。 */
export function useKnowledgeCardWarmup(pages: readonly ResolvedPage[]): void {
  const targetKey = pages
    .map((page) => page.documentTarget?.itemId ?? page.refId)
    .join('\u0000')
  useEffect(() => {
    const dispose = warmKnowledgeCardPreviews(pages)
    return dispose
    // 仅按可见集合内容重排，避免数组引用每帧变化导致重复调度。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])
}

async function runWarmup(
  generation: number,
  targets: readonly WarmupTarget[],
  signal: AbortSignal,
): Promise<void> {
  let surfaceBudget = MAX_SURFACE_PREVIEWS
  let cursor = 0

  const warmSurface = (preview: DocumentPreview): void => {
    if (surfaceBudget <= 0 || !needsSurfaceWarmup(preview)) return
    surfaceBudget -= 1
    // 重型渲染延后到宏任务尾部，避免和元数据读取争抢主线程。
    window.setTimeout(() => {
      if (generation !== warmupGeneration) return
      prefetchDocumentSurface(preview)
    }, 0)
  }

  const worker = async (): Promise<void> => {
    while (generation === warmupGeneration && !signal.aborted) {
      const target = targets[cursor]
      cursor += 1
      if (target === undefined) return
      const preview = await fetchDocumentPreview(target.itemId, '', signal, target.apiBase)
        .catch((error: unknown) => {
          if (!isAbortError(error)) rememberFailure(`${target.apiBase}\u0000${target.itemId}`)
          return undefined
        })
      if (preview === undefined || generation !== warmupGeneration || signal.aborted) continue
      warmSurface(preview)
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_METADATA, targets.length) },
    () => worker(),
  ))
}

function needsSurfaceWarmup(preview: DocumentPreview): boolean {
  if (preview.content.kind === 'media') {
    return preview.content.mediaKind === 'image'
      || preview.content.mediaKind === 'pdf'
      || preview.content.mediaKind === 'video'
  }
  return preview.content.kind === 'office'
}

function rememberFailure(key: string): void {
  failureTimestamps.set(key, Date.now())
  while (failureTimestamps.size > MAX_METADATA_PREVIEWS * 2) {
    failureTimestamps.delete(failureTimestamps.keys().next().value!)
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
