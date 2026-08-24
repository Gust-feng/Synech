import {
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Clock, Columns3, CornerUpLeft, LayoutGrid, Link2, X } from 'lucide-react'
import { useBrain, type ResolvedPage } from '../brainStore'
import { knowledgeKindLabel, knowledgePageIcon } from '../knowledge-view-projection'
import { KnowledgePageContent } from './knowledge-reader'

export const WIKI_PANE_WIDTH = 460 // 每栏总宽
export const WIKI_SPINE_WIDTH = 46 // 收起后露出的书脊宽

/**
 * 起点索引 —— 不替用户预选；选中内容后仍保留在底层，可从路径导航重新展开。
 * 优先给「最近打开」,其余按关联度(出链+反链)排序,连得越多越靠前。
 */
function StartPicker({
  brain,
  byId,
  startIds,
  onPick,
  onReveal,
}: {
  brain: ReturnType<typeof useBrain>
  byId: Map<string, ResolvedPage>
  startIds: string[]
  onPick: (id: string) => void
  onReveal: () => void
}) {
  const reducedMotion = useReducedMotion()
  const available = new Set(startIds)
  const recent = brain.recentlyOpened(4).filter((id) => byId.has(id) && available.has(id))
  const recentSet = new Set(recent)
  const rest = startIds
    .filter((id) => !recentSet.has(id))
    .sort(
      (a, b) =>
        brain.outgoing(b).length + brain.backlinks(b).length - (brain.outgoing(a).length + brain.backlinks(a).length)
    )

  const renderItem = (id: string) => {
    const p = byId.get(id)
    if (!p) return null
    const degree = brain.outgoing(id).length + brain.backlinks(id).length
    return (
      <button
        key={id}
        data-wiki-start-item
        onClick={() => onPick(id)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-[var(--ui-hover-tint)]"
        style={{ color: 'var(--ui-text-1, #292722)' }}
      >
        <span className="shrink-0">{knowledgePageIcon(p, 15)}</span>
        <span className="flex-1 min-w-0 truncate text-sm">{p.title}</span>
        <span
          className="shrink-0 text-xs"
          style={{ color: 'var(--ui-text-3, #aba39b)' }}
        >
          {knowledgeKindLabel(p)}
          {degree > 0 ? ` · ${degree} 链` : ''}
        </span>
      </button>
    )
  }

  return (
    <div
      data-wiki-start-picker
      className="flex h-full shrink-0 overflow-hidden"
      style={{ position: 'relative', zIndex: 0, width: WIKI_PANE_WIDTH }}
    >
      <button
        type="button"
        onClick={onReveal}
        aria-label="展开起点索引"
        className="shrink-0 flex flex-col items-center gap-3 pt-4 pb-4 transition-colors hover:bg-[var(--ui-hover-tint)]"
        style={{
          width: WIKI_SPINE_WIDTH,
          background: 'var(--ui-surface, #fff)',
          borderRight: '1px solid var(--ui-border, rgba(45,40,34,0.08))',
        }}
      >
        <Columns3 size={15} />
        <span
          className="text-xs"
          style={{ writingMode: 'vertical-rl', color: 'var(--ui-text-2, #87827c)' }}
        >
          起点索引
        </span>
      </button>

      <div
        className="shrink-0 flex min-w-0 flex-col"
        style={{
          width: WIKI_PANE_WIDTH - WIKI_SPINE_WIDTH,
          background: 'var(--ui-surface, #fff)',
        }}
      >
        <header
          className="shrink-0 flex items-center px-4"
          style={{ height: 48, borderBottom: '1px solid var(--ui-border, rgba(45,40,34,0.07))' }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--ui-text-1, #292722)' }}>
            从哪里开始
          </span>
        </header>
        <div className="flex-1 overflow-x-hidden overflow-y-auto px-3 py-3">
          {startIds.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
              当前范围还没有内容。
            </p>
          ) : (
            <>
              {recent.length > 0 && (
                <>
                  <div className="px-3 pt-1 pb-1 text-xs flex items-center gap-1.5" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
                    <Clock size={11} /> 最近看过
                  </div>
                  {recent.map(renderItem)}
                  <div className="px-3 pt-4 pb-1 text-xs flex items-center gap-1.5" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
                    <LayoutGrid size={11} /> 当前范围
                  </div>
                </>
              )}
              {rest.map(renderItem)}
            </>
          )}
        </div>
      </div>
      <PaneBoundary reducedMotion={reducedMotion} />
    </div>
  )
}

export function KnowledgeWiki({
  brain,
  resolved,
  startIds,
  trail,
  setTrail,
  viewportRef,
  onNavigate,
  onActivePaneChange,
}: {
  brain: ReturnType<typeof useBrain>
  resolved: ResolvedPage[]
  startIds: string[]
  trail: string[]
  setTrail: Dispatch<SetStateAction<string[]>>
  viewportRef: RefObject<HTMLDivElement | null>
  onNavigate: (index: number) => void
  onActivePaneChange: (index: number) => void
}) {
  const initialTrailLengthRef = useRef(trail.length)
  const scrollSettleTimerRef = useRef<number | null>(null)

  const byId = useMemo(() => {
    const m = new Map<string, ResolvedPage>()
    resolved.forEach((p) => m.set(p.refId, p))
    return m
  }, [resolved])

  // 知识库同步可能移除正在路径中的页面；路径和栏索引必须同时收敛。
  useEffect(() => {
    setTrail((current) => {
      const available = current.filter((id) => byId.has(id))
      return available.length === current.length ? current : available
    })
  }, [byId, setTrail])

  // 切回堆叠视图时恢复到路径末端，而不是重新从起点开始。
  useEffect(() => {
    if (initialTrailLengthRef.current > 0) onNavigate(initialTrailLengthRef.current - 1)
  }, [])

  useEffect(() => () => {
    if (scrollSettleTimerRef.current !== null) window.clearTimeout(scrollSettleTimerRef.current)
  }, [])

  // 从第 index 栏顺着链接打开 id。
  // 已在路径中的目标只切换焦点；只有新目标才从当前栏生成一条新分支。
  const openFrom = (index: number, id: string) => {
    const existing = trail.indexOf(id)
    if (existing !== -1) {
      onNavigate(existing)
      return
    }
    const prefix = trail.slice(0, index + 1)
    brain.markOpened(id)
    setTrail([...prefix, id])
    onNavigate(prefix.length)
  }
  // 点书脊只切换当前阅读位置,不改写已经形成的路径。
  const revealPane = (index: number) => onNavigate(index)
  // 关闭 = 显式地把这一栏及其之后全部合上,并滚回上一栏。
  const closeFrom = (index: number) => {
    setTrail((current) => current.slice(0, index))
    onNavigate(index - 1)
  }

  return (
    <section
      className="flex-1 flex flex-col overflow-hidden"
      style={{ minHeight: 0, background: 'var(--ui-surface-hover, #efece7)' }}
    >
      {/* 横向栏容器 */}
      <div
        ref={viewportRef}
        data-wiki-scroll-viewport
        aria-label="堆叠阅读栏"
        onScroll={(event) => {
          const scrollLeft = event.currentTarget.scrollLeft
          if (scrollSettleTimerRef.current !== null) window.clearTimeout(scrollSettleTimerRef.current)
          scrollSettleTimerRef.current = window.setTimeout(() => {
            const index = scrollLeft < WIKI_PANE_WIDTH / 2
              ? -1
              : Math.round((scrollLeft - WIKI_PANE_WIDTH) / (WIKI_PANE_WIDTH - WIKI_SPINE_WIDTH))
            onActivePaneChange(Math.min(Math.max(-1, trail.length - 1), Math.max(-1, index)))
          }, 120)
        }}
        className="flex-1 flex overflow-x-auto overflow-y-hidden"
        style={{
          minHeight: 0,
          overscrollBehaviorX: 'contain',
          scrollbarWidth: 'thin',
        }}
      >
        <StartPicker
          brain={brain}
          byId={byId}
          startIds={startIds}
          onReveal={() => onNavigate(-1)}
          onPick={(id) => {
            brain.markOpened(id)
            setTrail([id])
            onNavigate(0)
          }}
        />
        {trail.length > 0 && trail.map((id, i) => {
          const page = byId.get(id)
          if (!page) return null
          return (
            <Pane
              key={id}
              page={page}
              index={i}
              isLast={i === trail.length - 1}
              brain={brain}
              byId={byId}
              onOpen={(target) => openFrom(i, target)}
              onReveal={() => revealPane(i)}
              onClose={() => closeFrom(i)}
            />
          )
        })}
        {/* 宽屏也要保留足够滚动距离，让最后一栏能够覆盖到自己的目标栏位。 */}
        <div
          data-wiki-scroll-runway
          aria-hidden="true"
          className="h-full shrink-0"
          style={{ width: '100%', minWidth: WIKI_PANE_WIDTH }}
        />
      </div>
    </section>
  )
}

/** 单栏:左侧竖书脊 + 右侧内容(正文 + 关系)。 */
function Pane({
  page,
  index,
  isLast,
  brain,
  byId,
  onOpen,
  onReveal,
  onClose,
}: {
  page: ResolvedPage
  index: number
  isLast: boolean
  brain: ReturnType<typeof useBrain>
  byId: Map<string, ResolvedPage>
  onOpen: (id: string) => void
  onReveal: () => void
  onClose?: () => void
}) {
  const reducedMotion = useReducedMotion()
  // 关系:先出链(它引用了),再反向链接(被谁引用),去重。
  const out = brain.outgoing(page.refId)
  const back = brain.backlinks(page.refId).filter((id) => !out.includes(id))
  const rels = [
    ...out.map((id) => ({ id, dir: 'out' as const })),
    ...back.map((id) => ({ id, dir: 'in' as const })),
  ]
    .map((r) => ({ ...r, page: byId.get(r.id) }))
    .filter((r): r is { id: string; dir: 'out' | 'in'; page: ResolvedPage } => !!r.page)

  return (
    <div
      data-wiki-pane={page.refId}
      className="shrink-0 flex h-full overflow-hidden"
      style={{
        position: 'sticky',
        left: index * WIKI_SPINE_WIDTH,
        zIndex: index + 1,
        width: WIKI_PANE_WIDTH,
      }}
    >
      {/* 竖书脊:收起时露出的就是它 */}
      <button
        onClick={onReveal}
        aria-label={`展开${page.title}`}
        className="shrink-0 flex flex-col items-center gap-3 pt-4 pb-4 transition-colors hover:bg-[var(--ui-hover-tint)]"
        style={{
          width: WIKI_SPINE_WIDTH,
          background: 'var(--ui-surface, #fff)',
          borderRight: '1px solid var(--ui-border, rgba(45,40,34,0.08))',
        }}
      >
        <span className="shrink-0">{knowledgePageIcon(page, 15)}</span>
        <span
          className="text-xs overflow-hidden"
          style={{
            writingMode: 'vertical-rl',
            color: 'var(--ui-text-2, #87827c)',
            maxHeight: 220,
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {page.title}
        </span>
      </button>

      {/* 内容区保持固定宽度,入场只做位移与透明度变化,避免正文在动画中回流。 */}
      <div
        className="shrink-0 flex flex-col min-w-0"
        style={{
          width: WIKI_PANE_WIDTH - WIKI_SPINE_WIDTH,
          background: 'var(--ui-surface, #fff)',
        }}
      >
        <header
          className="shrink-0 flex items-center gap-2.5 px-4"
          style={{ height: 48, borderBottom: '1px solid var(--ui-border, rgba(45,40,34,0.07))' }}
        >
          <span className="text-sm font-semibold truncate min-w-0" style={{ color: 'var(--ui-text-1, #292722)' }}>
            {page.title}
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded shrink-0"
            style={{ background: 'var(--ui-surface-hover, #eeebe6)', color: 'var(--ui-text-2, #87827c)' }}
          >
            {knowledgeKindLabel(page)}
          </span>
          <div className="flex-1" />
          {onClose && (
            <button
              onClick={onClose}
              aria-label={`关闭${page.title}`}
              className="p-1 rounded hover:bg-[var(--ui-hover-tint)] shrink-0"
              style={{ color: 'var(--ui-text-3, #aba39b)' }}
            >
              <X size={15} />
            </button>
          )}
        </header>

        <div data-wiki-pane-content className="flex-1 min-h-0 overflow-hidden">
          <KnowledgePageContent page={page} />
        </div>

        {/* 关联导航独立于正文滚动。标签只占左上角,右侧留白自然结束这张附属卡片。 */}
        {rels.length > 0 && (
          <nav
            aria-label={`${page.title}的关联文件`}
            className="shrink-0 px-3 pb-3"
            style={{ background: 'var(--ui-surface, #fff)' }}
          >
            <div
              data-wiki-relations-tab
              className="relative z-[1] inline-flex h-7 items-center gap-1.5 rounded-t-md border border-b-0 px-3"
              style={{
                marginBottom: -1,
                background: 'var(--ui-canvas, #f7f5f2)',
                borderColor: 'var(--ui-border, rgba(45,40,34,0.09))',
                color: 'var(--ui-text-2, #87827c)',
              }}
            >
              <Link2 size={13} style={{ color: 'var(--ui-accent, #6865a7)' }} />
              <span className="text-xs">
                顺着走 · {rels.length} 个链接
              </span>
            </div>
            <div
              data-wiki-relations-surface
              className="overflow-hidden rounded-bl-md rounded-br-md rounded-tr-md border"
              style={{
                background: 'color-mix(in srgb, var(--ui-canvas, #f7f5f2) 72%, var(--ui-surface, #fff))',
                borderColor: 'var(--ui-border, rgba(45,40,34,0.09))',
              }}
            >
              <div
                data-wiki-relations-list
                className="flex min-h-0 flex-col overflow-x-hidden overflow-y-auto p-1"
                style={{ maxHeight: 'min(220px, 28vh)', overscrollBehavior: 'contain' }}
              >
                {rels.map((r) => (
                  <RelRow key={r.id} page={r.page} dir={r.dir} onClick={() => onOpen(r.id)} />
                ))}
              </div>
            </div>
          </nav>
        )}
      </div>
      <PaneBoundary reducedMotion={reducedMotion} emphasized={isLast} />
    </div>
  )
}

/** 内容先稳定，栏位边界随后建立，表达堆叠关系而不移动正文。 */
function PaneBoundary({
  reducedMotion,
  emphasized = false,
}: {
  reducedMotion: boolean | null
  emphasized?: boolean
}) {
  return (
    <motion.div
      data-wiki-pane-boundary
      aria-hidden="true"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reducedMotion ? { duration: 0 } : { delay: 0.11, duration: 0.18, ease: 'easeOut' }}
      className="pointer-events-none absolute inset-y-0 right-0 w-px"
      style={{
        background: 'var(--ui-border, rgba(45,40,34,0.09))',
        boxShadow: emphasized ? '12px 0 30px rgba(45,40,34,0.08)' : 'none',
        willChange: reducedMotion ? undefined : 'opacity',
      }}
    />
  )
}

/** 一条可点开的关系行:图标 + 标题 + 方向(引用/被引用)。 */
function RelRow({
  page,
  dir,
  onClick,
}: {
  page: ResolvedPage
  dir: 'out' | 'in'
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="group flex min-h-10 w-full min-w-0 items-center gap-2.5 border-b px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-[var(--ui-hover-tint)] focus-visible:bg-[var(--ui-hover-tint)]"
      style={{ borderColor: 'var(--ui-border, rgba(45,40,34,0.08))' }}
    >
      <span className="shrink-0">{knowledgePageIcon(page, 14)}</span>
      <span className="flex-1 min-w-0 text-sm truncate" style={{ color: 'var(--ui-text-1, #292722)' }}>
        {page.title}
      </span>
      <span
        className="shrink-0 text-xs"
        style={{
          color: dir === 'out' ? 'var(--ui-accent, #6865a7)' : 'var(--ui-text-3, #aba39b)',
        }}
      >
        {dir === 'out' ? '引用' : '被引用'}
      </span>
      <CornerUpLeft
        size={13}
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ color: 'var(--ui-accent, #6865a7)', transform: 'scaleX(-1)' }}
      />
    </button>
  )
}
