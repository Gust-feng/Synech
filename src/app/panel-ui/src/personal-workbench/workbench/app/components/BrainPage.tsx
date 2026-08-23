import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type SetStateAction } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import {
  Film,
  Link2,
  CornerUpLeft,
  Plus,
  X,
  Trash2,
  ChevronDown,
  Search,
  Tag,
  Lock,
  Check,
  Clock,
  LayoutGrid,
  Columns3,
} from 'lucide-react'
import { CodeDocumentSurface } from './CodeDocumentSurface'
import { MarkdownDocumentSurface } from './MarkdownDocumentSurface'
import { PdfDocumentThumbnail } from './PdfDocumentSurface'
import { getNote } from './notesStore'
import { useBrain, type ResolvedPage } from './brainStore'
import {
  getKnowledgePreviewText,
  KNOWLEDGE_FILTERS,
  knowledgeKindLabel,
  knowledgePageIcon,
  matchesKnowledgeFilter,
  formatKnowledgeTimeAgo,
  cleanKnowledgeText,
  type KnowledgeKind,
} from './knowledge-view-projection'
import { useThemes, type Theme } from './themesStore'
import { ImageWithFallback } from './ImageWithFallback'
import { ReferencePreview } from './ReferencePreview'
import { getCachedReferencePreview } from './referencePreviewClient'
import { prefetchDocumentSurface } from './documentPreviewWarmup'
import { panelStorageKey } from '../../../../app-local-preferences'

/**
 * 知识库 —— 顶层场所(见 docs/概念与设计.md §5)。
 *
 * 门面是「卡片画廊」,不是文件列表:进门第一眼要轻,大量留白,
 * 顶部只有一排轻筛选(类型 + 搜索)。降低心智负担——不逼用户先在
 * 「资源库 vs wiki」之间做选择。
 *
 * 「资源库 / wiki」降级为用时才出现的透镜:点开一张卡片进入阅读态,
 * 链接 / 反向链接(第二大脑的核心机制)才作为右栏透镜出现。
 */

type KnowledgeView = 'browse' | 'stack'

const KNOWLEDGE_VIEW_STORAGE_KEY = panelStorageKey('knowledge.view')

export function BrainPage({
  selectedId,
  onSelect,
}: {
  // 当前打开的文件 id 提升到 App 管理,好让顶栏渲染「知识库 › 文件」的路径面包屑。
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const brain = useBrain()
  const themeApi = useThemes()
  const reducedMotion = useReducedMotion()
  const [filter, setFilter] = useState<KnowledgeKind>('all')
  const [query, setQuery] = useState('')
  // 左栏导航当前落点:'recent'(最近)/'all'(全部)/'unclassified'(未归类)/ 或某个 themeId。
  const [nav, setNav] = useState<string>('recent')
  const [view, setView] = useState<KnowledgeView>(() =>
    window.localStorage.getItem(KNOWLEDGE_VIEW_STORAGE_KEY) === 'stack' ? 'stack' : 'browse'
  )
  const [trail, setTrail] = useState<string[]>([])
  const [activeStackPane, setActiveStackPane] = useState(-1)
  const wikiViewportRef = useRef<HTMLDivElement>(null)

  const resolved = useMemo(() => brain.pages.map(brain.resolvePage), [brain.pages])
  const byId = useMemo(() => {
    const m = new Map<string, ResolvedPage>()
    resolved.forEach((p) => m.set(p.refId, p))
    return m
  }, [resolved])

  const searching = query.trim().length > 0

  // 搜索结果:命中标题或正文即算。取用优先——带着念头进来直接捞。
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return resolved
      .filter((p) => matchesKnowledgeFilter(p, filter))
      .filter((p) => p.title.toLowerCase().includes(q) || getKnowledgePreviewText(p).toLowerCase().includes(q))
      .sort((a, b) => b.collectedAt - a.collectedAt)
  }, [resolved, filter, query])

  // 主题透镜里用的全量卡片(不受搜索影响,只受类型筛选)。
  const cards = useMemo(
    () => [...resolved].filter((p) => matchesKnowledgeFilter(p, filter)).sort((a, b) => b.collectedAt - a.collectedAt),
    [resolved, filter]
  )

  // 「最近」= 时间维度筛选:最近活动的收藏(最近打开 ∪ 最近收藏,按最近活动时间倒序)。
  // 与「全部 / 未归类 / 主题」共用同一展示契约(标题 + 计数 + 网格),切换导航只换内容集合,不改变布局。
  const RECENT_PAGE_LIMIT = 12
  const recentPages = useMemo(() => {
    return [...cards]
      .map((page) => ({ page, activityAt: Math.max(page.collectedAt, brain.openedAtOf(page.refId) ?? 0) }))
      .sort((a, b) => b.activityAt - a.activityAt)
      .slice(0, RECENT_PAGE_LIMIT)
      .map(({ page }) => page)
  }, [brain, cards])

  const selected = resolved.find((p) => p.refId === selectedId) ?? null
  const trailPages = trail.map((id) => byId.get(id)).filter((page): page is ResolvedPage => page !== undefined)
  const navigateStackPane = (index: number) => {
    setActiveStackPane(index)
    requestAnimationFrame(() => {
      const left = index < 0 ? 0 : PANE_W + index * (PANE_W - SPINE_W)
      wikiViewportRef.current?.scrollTo({ left, behavior: 'smooth' })
    })
  }
  const changeView = (next: KnowledgeView) => {
    if (next === 'stack' && trail.length === 0 && selected) setTrail([selected.refId])
    setView(next)
    window.localStorage.setItem(KNOWLEDGE_VIEW_STORAGE_KEY, next)
  }
  useEffect(() => {
    setActiveStackPane((current) => {
      if (trail.length === 0) return -1
      return Math.min(Math.max(0, current), trail.length - 1)
    })
  }, [trail.length])
  const degreeOf = (refId: string) => brain.outgoing(refId).length + brain.backlinks(refId).length
  const openCard = (refId: string) => {
    brain.markOpened(refId) // 记一笔「继续看」
    onSelect(refId)
  }

  // 当前左栏落点对应的卡片(搜索时右主区改由 results 接管)。
  const navCards =
    nav === 'all'
      ? cards
      : nav === 'unclassified'
        ? cards.filter((c) => themeApi.themesOf(c.refId).length === 0)
        : nav === 'recent'
          ? recentPages
          : cards.filter((c) => themeApi.themesOf(c.refId).includes(nav))
  const activeTheme = themeApi.themes.find((t) => t.id === nav) ?? null

  if (resolved.length === 0) {
    return (
      <section className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        <EmptyState />
      </section>
    )
  }

  return (
    <section className="flex-1 flex" style={{ minHeight: 0 }}>
      {/* ── 左栏:纯导航入口 ── */}
      <LeftNav
        nav={nav}
        setNav={(n) => {
          changeView('browse')
          setNav(n)
          setQuery('')
          onSelect(null)
        }}
        total={resolved.length}
        cards={cards}
        themeApi={themeApi}
        view={view}
        onViewChange={changeView}
        trailPages={trailPages}
        activeStackPane={activeStackPane}
        onRevealStackPane={navigateStackPane}
      />

      <div className="relative min-w-0 flex-1 overflow-hidden">
        <AnimatePresence>
          <KnowledgeViewSurface
            key={view}
            view={view}
            reducedMotion={reducedMotion}
          >
            {view === 'stack' ? (
              <WikiView
                brain={brain}
                resolved={resolved}
                startIds={(searching ? results : nav === 'recent' ? resolved : navCards).map((page) => page.refId)}
                trail={trail}
                setTrail={setTrail}
                viewportRef={wikiViewportRef}
                onNavigate={navigateStackPane}
                onActivePaneChange={setActiveStackPane}
              />
            ) : selected ? (
              <ReadingView
                page={selected}
                resolved={resolved}
                brain={brain}
                onBack={() => onSelect(null)}
                onOpen={openCard}
              />
            ) : (
              /* ── 右主区:搜索框 + 随导航切换的内容 ── */
              <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        <div className="mx-auto w-full px-10 py-10" style={{ maxWidth: 860 }}>
          {/* 搜索框:任何时候都能盖过导航直接取用 */}
          <div
            className="flex items-center gap-3 px-4 rounded-2xl mb-9"
            style={{
              height: 48,
              background: 'var(--aa-surface, #fff)',
              border: `1px solid ${searching ? 'var(--aa-accent, #6865a7)' : 'var(--aa-border, rgba(45,40,34,0.1))'}`,
              boxShadow: searching ? '0 4px 16px rgba(104,101,167,0.12)' : '0 1px 2px rgba(45,40,34,0.03)',
              transition: 'all .15s',
            }}
          >
            <Search size={17} style={{ color: searching ? 'var(--aa-accent, #6865a7)' : 'var(--aa-text-3, #aba39b)' }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="想找点什么?搜标题、正文,或直接问……"
              spellCheck={false}
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: 'var(--aa-text-1, #292722)' }}
            />
            {searching && (
              <button onClick={() => setQuery('')} className="p-1 rounded-full hover:bg-[var(--aa-hover-tint)]">
                <X size={15} style={{ color: 'var(--aa-text-3, #aba39b)' }} />
              </button>
            )}
          </div>

          {searching ? (
            <SearchResults
              results={results}
              filter={filter}
              setFilter={setFilter}
              degreeOf={degreeOf}
              themeApi={themeApi}
              onOpen={openCard}
            />
          ) : (
            <div>
              {/* 主区标题:最近 / 全部 / 未归类 / 某主题(主题可改名、删)。
                  所有导航落点共用同一展示契约,避免切换筛选时布局跳变。 */}
              {activeTheme ? (
                <ThemeHeader theme={activeTheme} count={navCards.length} themeApi={themeApi} onDeleted={() => setNav('recent')} />
              ) : (
                <h2 className="m-0 mb-5 text-sm font-semibold" style={{ color: 'var(--aa-text-2, #87827c)' }}>
                  {nav === 'all' ? '全部' : nav === 'recent' ? '最近' : '未归类'}
                  <span className="ml-2" style={{ color: 'var(--aa-text-3, #aba39b)', fontWeight: 400 }}>
                    {navCards.length}
                  </span>
                </h2>
              )}
              {navCards.length === 0 ? (
                <p className="py-16 text-center text-sm" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
                  这里还没有东西。
                </p>
              ) : (
                <CardGrid>
                  {navCards.map((p) => (
                    <Card key={p.refId} page={p} degree={degreeOf(p.refId)} themeApi={themeApi} onOpen={() => openCard(p.refId)} />
                  ))}
                </CardGrid>
              )}
            </div>
          )}
        </div>
              </div>
            )}
          </KnowledgeViewSurface>
        </AnimatePresence>
      </div>

    </section>
  )
}

function KnowledgeViewSurface({
  view,
  reducedMotion,
  children,
}: {
  view: KnowledgeView
  reducedMotion: boolean | null
  children: ReactNode
}) {
  const isPresent = useIsPresent()

  return (
    <motion.div
      data-knowledge-view-surface={view}
      aria-hidden={!isPresent}
      initial={reducedMotion ? false : { opacity: 0.08, y: 7 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reducedMotion ? undefined : {
        opacity: 0,
        y: -3,
        transition: { duration: 0.12, ease: 'easeOut' },
      }}
      transition={reducedMotion ? { duration: 0 } : {
        opacity: { delay: 0.025, duration: 0.18, ease: 'easeOut' },
        y: { delay: 0.025, type: 'spring', stiffness: 300, damping: 31, mass: 0.7 },
      }}
      className="absolute inset-0 flex min-w-0 overflow-hidden"
      style={{
        pointerEvents: isPresent ? 'auto' : 'none',
        willChange: reducedMotion ? undefined : 'opacity, transform',
      }}
    >
      {children}
    </motion.div>
  )
}

/* ------------------------------ 知识库视图菜单 ------------------------------ */

/**
 * 标题保留逐字浮动与下划线作为菜单提示；真正的视图切换在菜单内完成。
 */
function KnowledgeViewMenu({
  view,
  onViewChange,
}: {
  view: KnowledgeView
  onViewChange: (view: KnowledgeView) => void
}) {
  const [open, setOpen] = useState(false)
  const [pendingView, setPendingView] = useState<KnowledgeView | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const restoreFocusOnCloseRef = useRef(false)
  const reducedMotion = useReducedMotion()
  const chars = '知识库'.split('')
  const selectView = (nextView: KnowledgeView) => {
    if (nextView !== view) setPendingView(nextView)
    restoreFocusOnCloseRef.current = true
    setOpen(false)
  }
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const options = optionRefs.current.filter((option): option is HTMLButtonElement => option !== null)
    if (options.length === 0) return
    const currentIndex = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement))
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1) % options.length
          : (currentIndex - 1 + options.length) % options.length
    options[nextIndex]?.focus()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        restoreFocusOnCloseRef.current = true
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => optionRefs.current[view === 'browse' ? 0 : 1]?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, view])

  return (
    <div
      ref={menuRef}
      className="relative inline-flex"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <motion.button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={pendingView !== null}
        disabled={pendingView !== null}
        onClick={() => setOpen((current) => !current)}
        initial="rest"
        animate={open ? 'active' : 'rest'}
        whileHover="hover"
        whileTap={reducedMotion ? undefined : { scale: 0.97 }}
        className="group relative inline-flex items-center gap-1.5 pb-1"
      >
        <span className="inline-flex">
          {chars.map((char, index) => (
            <motion.span
              key={char}
              className="text-lg font-semibold leading-none"
              variants={{
                rest: { y: 0, color: 'var(--aa-text-1, #292722)' },
                hover: { y: reducedMotion ? 0 : -2, color: 'var(--aa-accent, #6865a7)' },
                active: { y: 0, color: 'var(--aa-accent, #6865a7)' },
              }}
              transition={reducedMotion
                ? { duration: 0 }
                : { type: 'spring', stiffness: 320, damping: 15, delay: index * 0.05 }}
            >
              {char}
            </motion.span>
          ))}
        </span>
        <motion.span
          className="flex items-center"
          style={{ color: 'var(--aa-text-3, #aba39b)' }}
          animate={{ rotate: open ? 180 : 0 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: 'easeOut' }}
        >
          <ChevronDown size={14} />
        </motion.span>
        <motion.span
          className="absolute left-0 h-0.5 w-full origin-left rounded-full"
          style={{ bottom: -4, background: 'var(--aa-accent, #6865a7)' }}
          variants={{
            rest: { scaleX: 0, opacity: 0 },
            hover: { scaleX: 1, opacity: 1 },
            active: { scaleX: 1, opacity: 1 },
          }}
          transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 26 }}
        />
      </motion.button>

      <AnimatePresence
        onExitComplete={() => {
          if (pendingView !== null) onViewChange(pendingView)
          setPendingView(null)
          if (restoreFocusOnCloseRef.current) {
            restoreFocusOnCloseRef.current = false
            requestAnimationFrame(() => triggerRef.current?.focus())
          }
        }}
      >
        {open && (
          <motion.div
            role="menu"
            aria-label="知识库视图"
            onKeyDown={handleMenuKeyDown}
            initial={reducedMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: -3 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.09, ease: [0.22, 1, 0.36, 1] }}
            className="absolute left-0 top-full z-40 mt-2 w-52 overflow-hidden rounded-lg py-1.5"
            style={{
              background: 'var(--aa-surface, #fff)',
              border: '1px solid var(--aa-border, rgba(45,40,34,0.1))',
              boxShadow: '0 10px 28px rgba(45,40,34,0.13)',
              transformOrigin: 'top left',
            }}
          >
            <KnowledgeViewOption
              icon={<LayoutGrid size={15} />}
              title="浏览视图"
              description="搜索、主题与卡片浏览"
              selected={view === 'browse'}
              buttonRef={(element) => { optionRefs.current[0] = element }}
              onSelect={() => selectView('browse')}
            />
            <KnowledgeViewOption
              icon={<Columns3 size={15} />}
              title="堆叠阅读"
              description="沿链接保留阅读路径"
              selected={view === 'stack'}
              buttonRef={(element) => { optionRefs.current[1] = element }}
              onSelect={() => selectView('stack')}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function KnowledgeViewOption({
  icon,
  title,
  description,
  selected,
  buttonRef,
  onSelect,
}: {
  icon: ReactNode
  title: string
  description: string
  selected: boolean
  buttonRef: (element: HTMLButtonElement | null) => void
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      role="menuitemradio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--aa-hover-tint)]"
    >
      <span className="mt-0.5 shrink-0" style={{ color: selected ? 'var(--aa-accent, #6865a7)' : 'var(--aa-text-3, #aba39b)' }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm" style={{ color: 'var(--aa-text-1, #292722)' }}>{title}</span>
        <span className="mt-0.5 block text-xs" style={{ color: 'var(--aa-text-3, #aba39b)' }}>{description}</span>
      </span>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" style={{ color: 'var(--aa-accent, #6865a7)' }}>
        {selected && <Check size={14} />}
      </span>
    </button>
  )
}

/* ------------------------------ 左栏导航 ------------------------------ */

const NAV_CONTEXT_VARIANTS = {
  enter: (direction: number) => ({ opacity: 0.12, y: direction * 14 }),
  visible: { opacity: 1, y: 0 },
  exit: (direction: number) => ({
    opacity: 0,
    y: direction * -8,
    transition: {
      opacity: { duration: 0.09, ease: 'easeOut' as const },
      y: { duration: 0.12, ease: [0.4, 0, 1, 1] as const },
    },
  }),
}

function LeftNav({
  nav,
  setNav,
  total,
  cards,
  themeApi,
  view,
  onViewChange,
  trailPages,
  activeStackPane,
  onRevealStackPane,
}: {
  nav: string
  setNav: (n: string) => void
  total: number
  cards: ResolvedPage[]
  themeApi: ReturnType<typeof useThemes>
  view: KnowledgeView
  onViewChange: (view: KnowledgeView) => void
  trailPages: ResolvedPage[]
  activeStackPane: number
  onRevealStackPane: (index: number) => void
}) {
  const countIn = (themeId: string) => cards.filter((c) => themeApi.themesOf(c.refId).includes(themeId)).length
  const unclassifiedCount = cards.filter((c) => themeApi.themesOf(c.refId).length === 0).length
  const reducedMotion = useReducedMotion()
  const contextDirection = view === 'stack' ? 1 : -1
  const navScrollPositionsRef = useRef<Record<KnowledgeView, number>>({ browse: 0, stack: 0 })
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  return (
    <nav
      aria-label="知识库导航"
      className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden"
      style={{
        width: 224,
        borderRight: '1px solid var(--aa-border, rgba(45,40,34,0.08))',
        background: 'var(--aa-surface, #faf9f7)',
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col px-4 py-6">
        <div className="mb-5 shrink-0 px-2">
          <KnowledgeViewMenu view={view} onViewChange={onViewChange} />
        </div>

        <div data-knowledge-nav-viewport className="relative -mx-1 -my-1 min-h-0 flex-1 overflow-hidden px-1 py-1">
          <AnimatePresence initial={false} custom={contextDirection}>
            <NavigationContextSurface
              key={view}
              view={view}
              direction={contextDirection}
              reducedMotion={reducedMotion}
              scrollPositions={navScrollPositionsRef.current}
            >
              {view === 'stack' ? (
                <StackPathNav pages={trailPages} activeIndex={activeStackPane} onReveal={onRevealStackPane} />
              ) : (
                <>
            <div className="space-y-0.5">
              <NavItem icon={<Clock size={15} />} label="最近" active={nav === 'recent'} onClick={() => setNav('recent')} />
              <NavItem icon={<LayoutGrid size={15} />} label="全部" count={total} active={nav === 'all'} onClick={() => setNav('all')} />
            </div>

            <div className="mt-6 mb-2 px-2 flex items-center justify-between">
              <span className="text-xs font-medium" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
                主题
              </span>
              <button
                onClick={() => setAdding(true)}
                className="p-0.5 rounded hover:bg-[var(--aa-hover-tint)]"
                style={{ color: 'var(--aa-text-3, #aba39b)' }}
              >
                <Plus size={13} />
              </button>
            </div>
            <div className="space-y-0.5">
              {themeApi.themes.map((t) => (
                <NavItem
                  key={t.id}
                  icon={<span className="w-2.5 h-2.5 rounded-full" style={{ background: t.color }} />}
                  label={t.name}
                  count={countIn(t.id)}
                  active={nav === t.id}
                  onClick={() => setNav(t.id)}
                />
              ))}
              {unclassifiedCount > 0 && (
                <NavItem
                  icon={<span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--aa-text-3, #cfc9c1)' }} />}
                  label="未归类"
                  count={unclassifiedCount}
                  active={nav === 'unclassified'}
                  onClick={() => setNav('unclassified')}
                />
              )}
              {adding && (
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => {
                    if (name.trim()) {
                      const id = themeApi.createTheme(name)
                      setNav(id)
                    }
                    setName('')
                    setAdding(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') {
                      setName('')
                      setAdding(false)
                    }
                  }}
                  placeholder="主题名…"
                  spellCheck={false}
                  className="w-full px-2 py-1.5 rounded-lg bg-transparent outline-none text-sm"
                  style={{ color: 'var(--aa-text-1, #292722)', border: '1px solid var(--aa-accent, #6865a7)' }}
                />
              )}
            </div>
                </>
              )}
            </NavigationContextSurface>
          </AnimatePresence>
        </div>
      </div>
    </nav>
  )
}

function NavigationContextSurface({
  view,
  direction,
  reducedMotion,
  scrollPositions,
  children,
}: {
  view: KnowledgeView
  direction: number
  reducedMotion: boolean | null
  scrollPositions: Record<KnowledgeView, number>
  children: ReactNode
}) {
  const isPresent = useIsPresent()
  const scrollRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (isPresent && scrollRef.current) scrollRef.current.scrollTop = scrollPositions[view]
  }, [isPresent, scrollPositions, view])

  return (
    <motion.div
      ref={scrollRef}
      data-knowledge-nav-context={view}
      aria-hidden={!isPresent}
      custom={direction}
      variants={NAV_CONTEXT_VARIANTS}
      initial={reducedMotion ? false : 'enter'}
      animate="visible"
      exit={reducedMotion ? undefined : 'exit'}
      transition={reducedMotion ? { duration: 0 } : {
        opacity: { duration: 0.16, ease: 'easeOut' },
        y: { type: 'spring', stiffness: 360, damping: 33, mass: 0.65 },
      }}
      onScroll={(event) => {
        if (isPresent) scrollPositions[view] = event.currentTarget.scrollTop
      }}
      className="absolute inset-1 overflow-y-auto"
      style={{ pointerEvents: isPresent ? 'auto' : 'none' }}
    >
      {children}
    </motion.div>
  )
}

function StackPathNav({
  pages,
  activeIndex,
  onReveal,
}: {
  pages: ResolvedPage[]
  activeIndex: number
  onReveal: (index: number) => void
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-2">
        <span className="text-xs font-medium" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
          阅读路径
        </span>
        <span className="text-xs" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
          {pages.length}
        </span>
      </div>
      <div className="space-y-0.5">
        <NavItem
          icon={<Columns3 size={15} />}
          label="起点索引"
          active={activeIndex === -1}
          onClick={() => onReveal(-1)}
        />
        {pages.map((page, index) => (
          <NavItem
            key={page.refId}
            icon={knowledgePageIcon(page, 14)}
            label={page.title}
            active={activeIndex === index}
            onClick={() => onReveal(index)}
          />
        ))}
      </div>
    </div>
  )
}

function NavItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: ReactNode
  label: string
  count?: number
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className="relative isolate flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--aa-hover-tint)]"
      style={{
        color: active ? 'var(--aa-accent-fg, #fff)' : 'var(--aa-text-1, #292722)',
      }}
    >
      {active && (
        <span
          data-knowledge-nav-active
          className="absolute inset-0 z-0 rounded-lg"
          style={{
            background: 'var(--aa-accent, #6865a7)',
            boxShadow: '0 1px 3px rgba(45,40,34,0.12)',
          }}
        />
      )}
      <span className="relative z-[1] shrink-0 flex items-center justify-center" style={{ width: 15, opacity: active ? 1 : 0.7 }}>
        {icon}
      </span>
      <span className="relative z-[1] flex-1 truncate text-sm">{label}</span>
      {count != null && (
        <span className="relative z-[1] text-xs" style={{ opacity: 0.6 }}>
          {count}
        </span>
      )}
    </button>
  )
}

/* 主区里某个主题的标题条:改名 / 删除。 */
function ThemeHeader({
  theme,
  count,
  themeApi,
  onDeleted,
}: {
  theme: Theme
  count: number
  themeApi: ReturnType<typeof useThemes>
  onDeleted: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(theme.name)
  return (
    <div className="flex items-center gap-2 mb-5">
      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: theme.color }} />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            themeApi.renameTheme(theme.id, draft)
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setDraft(theme.name)
              setEditing(false)
            }
          }}
          spellCheck={false}
          className="text-base font-semibold bg-transparent outline-none border-b"
          style={{ color: 'var(--aa-text-1, #292722)', borderColor: theme.color }}
        />
      ) : (
        <h2
          className="m-0 text-base font-semibold cursor-text"
          style={{ color: 'var(--aa-text-1, #292722)' }}
          onClick={() => (setDraft(theme.name), setEditing(true))}
        >
          {theme.name}
        </h2>
      )}
      <span className="text-xs" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
        {count}
      </span>
      <div className="flex-1" />
      <button
        onClick={() => {
          themeApi.deleteTheme(theme.id)
          onDeleted()
        }}
        className="p-1 rounded hover:bg-[var(--aa-hover-tint)]"
        style={{ color: 'var(--aa-text-3, #aba39b)' }}
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

/* ------------------------------ 主题分段 ------------------------------ */

function CardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
      {children}
    </div>
  )
}

/* ---------------------- 搜索态:命中平铺 ---------------------- */

function SearchResults({
  results,
  filter,
  setFilter,
  degreeOf,
  themeApi,
  onOpen,
}: {
  results: ResolvedPage[]
  filter: KnowledgeKind
  setFilter: (k: KnowledgeKind) => void
  degreeOf: (refId: string) => number
  themeApi: ReturnType<typeof useThemes>
  onOpen: (refId: string) => void
}) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <span className="text-sm" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
          {results.length} 个结果
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 flex-wrap">
          {KNOWLEDGE_FILTERS.map((f) => (
            <FilterChip key={f.key} active={filter === f.key} label={f.label} onClick={() => setFilter(f.key)} />
          ))}
        </div>
      </div>
      {results.length === 0 ? (
        <p className="py-16 text-center text-sm" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
          没有命中的东西。
        </p>
      ) : (
        <CardGrid>
          {results.map((p) => (
            <Card key={p.refId} page={p} degree={degreeOf(p.refId)} themeApi={themeApi} onOpen={() => onOpen(p.refId)} />
          ))}
        </CardGrid>
      )}
    </div>
  )
}

/* ------------------------------ 阅读态(链接透镜) ------------------------------ */

function ReadingView({
  page,
  resolved,
  brain,
  onBack,
  onOpen,
}: {
  page: ResolvedPage
  resolved: ResolvedPage[]
  brain: ReturnType<typeof useBrain>
  onBack: () => void
  onOpen: (id: string) => void
}) {
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const outIds = brain.outgoing(page.refId)
  const backIds = brain.backlinks(page.refId)
  const linkableTargets = resolved.filter((p) => p.refId !== page.refId && !outIds.includes(p.refId))

  return (
    <section className="flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* 路径面包屑(知识库 › 文件)已上移到顶栏;这里只留内容操作。 */}
        <header className="shrink-0 flex items-center gap-2 px-5" style={{ height: 44 }}>
          <div className="flex-1" />
          <button
            onClick={() => {
              brain.uncollect(page.refId)
              onBack()
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--aa-hover-tint)]"
            style={{ color: 'var(--aa-text-3, #aba39b)' }}
          >
            <Trash2 size={12} />
            移出
          </button>
        </header>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          <PageContent page={page} />
        </div>
      </div>

      {/* 右:链接 + 反向链接(透镜) */}
      <div
        className="shrink-0 flex flex-col overflow-y-auto"
        style={{ width: 256, borderLeft: '1px solid var(--aa-border, rgba(45,40,34,0.09))' }}
      >
        <div className="px-4 py-4">
          <SectionHead icon={<CornerUpLeft size={12} />} label="反向链接" count={backIds.length} />
          {backIds.length === 0 ? (
            <p className="text-xs mb-5" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
              还没有页面链到这里。
            </p>
          ) : (
            <div className="space-y-1 mb-5">
              {backIds.map((id) => {
                const rp = resolved.find((p) => p.refId === id)
                if (!rp) return null
                return <LinkChip key={id} page={rp} onClick={() => onOpen(id)} />
              })}
            </div>
          )}

          <SectionHead icon={<Link2 size={12} />} label="链接到" count={outIds.length} />
          <div className="space-y-1">
            {outIds.map((id) => {
              const rp = resolved.find((p) => p.refId === id)
              if (!rp) return null
              return (
                <LinkChip
                  key={id}
                  page={rp}
                  onClick={() => onOpen(id)}
                  onRemove={() => brain.removeLink(page.refId, id)}
                />
              )
            })}
          </div>

          {linkPickerOpen ? (
            <div className="mt-2 rounded-md p-1" style={{ border: '1px solid var(--aa-border, rgba(45,40,34,0.09))' }}>
              <div className="flex items-center justify-between px-1.5 py-1">
                <span className="text-xs" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
                  链接到…
                </span>
                <button onClick={() => setLinkPickerOpen(false)} style={{ color: 'var(--aa-text-3, #aba39b)' }}>
                  <X size={12} />
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {linkableTargets.length === 0 ? (
                  <p className="px-1.5 py-2 text-xs" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
                    没有可链接的其它页面。
                  </p>
                ) : (
                  linkableTargets.map((p) => (
                    <button
                      key={p.refId}
                      onClick={() => {
                        brain.addLink(page.refId, p.refId)
                        setLinkPickerOpen(false)
                      }}
                      className="w-full flex items-center gap-2 px-1.5 py-1.5 rounded text-left text-xs transition-colors hover:bg-[var(--aa-hover-tint)]"
                      style={{ color: 'var(--aa-text-1, #292722)' }}
                    >
                      {knowledgePageIcon(p, 12)}
                      <span className="flex-1 truncate">{p.title}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={() => setLinkPickerOpen(true)}
              className="mt-2 w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--aa-hover-tint)]"
              style={{ color: 'var(--aa-accent, #6865a7)' }}
            >
              <Plus size={12} />
              建立链接
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------ Wiki 堆叠阅读 ------------------------------ */

/**
 * 堆叠阅读(Sliding Panes)—— 知识库与浏览视图平级的阅读投影。
 *
 * 灵感来自 Andy Matuschak 的联网笔记:你打开一篇 = 一栏;顺着这一栏底部
 * 的「关系」再点开另一篇,新的一栏滑到右边、原来的不关。于是你顺链走多深,
 * 就横向叠出多少栏——思路轨迹看得见,且从不丢上下文。读过的栏自动收成左侧
 * 一条竖书脊,像书架;点书脊即可回到那一栏,其余路径仍然保留。
 *
 * 起点索引始终保留在路径底层；选中后第一篇正文滚入同一栏位并覆盖其上。
 */

const PANE_W = 460 // 每栏总宽
const SPINE_W = 46 // 收起后露出的书脊宽

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
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-[var(--aa-hover-tint)]"
        style={{ color: 'var(--aa-text-1, #292722)' }}
      >
        <span className="shrink-0">{knowledgePageIcon(p, 15)}</span>
        <span className="flex-1 min-w-0 truncate text-sm">{p.title}</span>
        <span
          className="shrink-0 text-xs"
          style={{ color: 'var(--aa-text-3, #aba39b)' }}
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
      style={{ position: 'relative', zIndex: 0, width: PANE_W }}
    >
      <button
        type="button"
        onClick={onReveal}
        aria-label="展开起点索引"
        className="shrink-0 flex flex-col items-center gap-3 pt-4 pb-4 transition-colors hover:bg-[var(--aa-hover-tint)]"
        style={{
          width: SPINE_W,
          background: 'var(--aa-surface, #fff)',
          borderRight: '1px solid var(--aa-border, rgba(45,40,34,0.08))',
        }}
      >
        <Columns3 size={15} />
        <span
          className="text-xs"
          style={{ writingMode: 'vertical-rl', color: 'var(--aa-text-2, #87827c)' }}
        >
          起点索引
        </span>
      </button>

      <div
        className="shrink-0 flex min-w-0 flex-col"
        style={{
          width: PANE_W - SPINE_W,
          background: 'var(--aa-surface, #fff)',
        }}
      >
        <header
          className="shrink-0 flex items-center px-4"
          style={{ height: 48, borderBottom: '1px solid var(--aa-border, rgba(45,40,34,0.07))' }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--aa-text-1, #292722)' }}>
            从哪里开始
          </span>
        </header>
        <div className="flex-1 overflow-x-hidden overflow-y-auto px-3 py-3">
          {startIds.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
              当前范围还没有内容。
            </p>
          ) : (
            <>
              {recent.length > 0 && (
                <>
                  <div className="px-3 pt-1 pb-1 text-xs flex items-center gap-1.5" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
                    <Clock size={11} /> 最近看过
                  </div>
                  {recent.map(renderItem)}
                  <div className="px-3 pt-4 pb-1 text-xs flex items-center gap-1.5" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
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

function WikiView({
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
      style={{ minHeight: 0, background: 'var(--aa-surface-hover, #efece7)' }}
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
            const index = scrollLeft < PANE_W / 2
              ? -1
              : Math.round((scrollLeft - PANE_W) / (PANE_W - SPINE_W))
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
          style={{ width: '100%', minWidth: PANE_W }}
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
        left: index * SPINE_W,
        zIndex: index + 1,
        width: PANE_W,
      }}
    >
      {/* 竖书脊:收起时露出的就是它 */}
      <button
        onClick={onReveal}
        aria-label={`展开${page.title}`}
        className="shrink-0 flex flex-col items-center gap-3 pt-4 pb-4 transition-colors hover:bg-[var(--aa-hover-tint)]"
        style={{
          width: SPINE_W,
          background: 'var(--aa-surface, #fff)',
          borderRight: '1px solid var(--aa-border, rgba(45,40,34,0.08))',
        }}
      >
        <span className="shrink-0">{knowledgePageIcon(page, 15)}</span>
        <span
          className="text-xs overflow-hidden"
          style={{
            writingMode: 'vertical-rl',
            color: 'var(--aa-text-2, #87827c)',
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
          width: PANE_W - SPINE_W,
          background: 'var(--aa-surface, #fff)',
        }}
      >
        <header
          className="shrink-0 flex items-center gap-2.5 px-4"
          style={{ height: 48, borderBottom: '1px solid var(--aa-border, rgba(45,40,34,0.07))' }}
        >
          <span className="text-sm font-semibold truncate min-w-0" style={{ color: 'var(--aa-text-1, #292722)' }}>
            {page.title}
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded shrink-0"
            style={{ background: 'var(--aa-surface-hover, #eeebe6)', color: 'var(--aa-text-2, #87827c)' }}
          >
            {knowledgeKindLabel(page)}
          </span>
          <div className="flex-1" />
          {onClose && (
            <button
              onClick={onClose}
              aria-label={`关闭${page.title}`}
              className="p-1 rounded hover:bg-[var(--aa-hover-tint)] shrink-0"
              style={{ color: 'var(--aa-text-3, #aba39b)' }}
            >
              <X size={15} />
            </button>
          )}
        </header>

        <div data-wiki-pane-content className="flex-1 min-h-0 overflow-hidden">
          <PageContent page={page} />
        </div>

        {/* 关联导航独立于正文滚动。标签只占左上角,右侧留白自然结束这张附属卡片。 */}
        {rels.length > 0 && (
          <nav
            aria-label={`${page.title}的关联文件`}
            className="shrink-0 px-3 pb-3"
            style={{ background: 'var(--aa-surface, #fff)' }}
          >
            <div
              data-wiki-relations-tab
              className="relative z-[1] inline-flex h-7 items-center gap-1.5 rounded-t-md border border-b-0 px-3"
              style={{
                marginBottom: -1,
                background: 'var(--aa-canvas, #f7f5f2)',
                borderColor: 'var(--aa-border, rgba(45,40,34,0.09))',
                color: 'var(--aa-text-2, #87827c)',
              }}
            >
              <Link2 size={13} style={{ color: 'var(--aa-accent, #6865a7)' }} />
              <span className="text-xs">
                顺着走 · {rels.length} 个链接
              </span>
            </div>
            <div
              data-wiki-relations-surface
              className="overflow-hidden rounded-bl-md rounded-br-md rounded-tr-md border"
              style={{
                background: 'color-mix(in srgb, var(--aa-canvas, #f7f5f2) 72%, var(--aa-surface, #fff))',
                borderColor: 'var(--aa-border, rgba(45,40,34,0.09))',
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
        background: 'var(--aa-border, rgba(45,40,34,0.09))',
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
      className="group flex min-h-10 w-full min-w-0 items-center gap-2.5 border-b px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-[var(--aa-hover-tint)] focus-visible:bg-[var(--aa-hover-tint)]"
      style={{ borderColor: 'var(--aa-border, rgba(45,40,34,0.08))' }}
    >
      <span className="shrink-0">{knowledgePageIcon(page, 14)}</span>
      <span className="flex-1 min-w-0 text-sm truncate" style={{ color: 'var(--aa-text-1, #292722)' }}>
        {page.title}
      </span>
      <span
        className="shrink-0 text-xs"
        style={{
          color: dir === 'out' ? 'var(--aa-accent, #6865a7)' : 'var(--aa-text-3, #aba39b)',
        }}
      >
        {dir === 'out' ? '引用' : '被引用'}
      </span>
      <CornerUpLeft
        size={13}
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ color: 'var(--aa-accent, #6865a7)', transform: 'scaleX(-1)' }}
      />
    </button>
  )
}
/* ------------------------------ 内容渲染 ------------------------------ */

function PageContent({
  page,
}: {
  page: ResolvedPage
}) {
  const [documentPath, setDocumentPath] = useState('')
  useEffect(() => {
    setDocumentPath('')
  }, [page.refId])
  const navigateDocumentPath = (relativePath: string) => {
    setDocumentPath(relativePath)
  }
  if (!page.exists) {
    return (
      <div
        className="h-full w-full overflow-y-auto px-6 py-10 text-sm"
        style={{ maxWidth: 'var(--reading-width, 680px)', color: 'var(--aa-text-3, #aba39b)' }}
      >
        这个对象已不存在(可能已被删除)。可以把它移出知识库。
      </div>
    )
  }
  if (page.kind === 'note') {
    const note = getNote(page.refId)!
    return (
      <div className="h-full w-full overflow-y-auto">
        <div className="mx-auto px-6 py-10 reading-prose" style={{ maxWidth: 'var(--reading-width, 680px)' }}>
          {note.bodyMarkdown.trim() ? (
            <MarkdownDocumentSurface markdown={note.bodyMarkdown} sourceVersion={`${note.id}:${note.updatedAt}`} />
          ) : (
            <p className="text-sm" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
              这篇笔记还没有内容。
            </p>
          )}
        </div>
      </div>
    )
  }
  if (page.documentTarget === undefined) return null
  return (
    <ReferencePreview
      itemId={page.refId}
      fallbackTitle={page.title}
      canOpen={false}
      onOpen={() => undefined}
      apiBase={page.documentTarget.apiBase}
      initialRelativePath={documentPath}
      onNavigatePath={navigateDocumentPath}
      embedded
    />
  )
}

/* ------------------------------ 卡片 & 小部件 ------------------------------ */

/** 哪些格式有封面(图/视频/音频/PDF/代码);文字类(笔记/Markdown/网页)无封面。 */
function pageHasCover(p: ResolvedPage): boolean {
  if (p.contentKind === 'code') return Boolean(p.previewText)
  if (p.contentKind === 'pdf') return true
  return p.contentKind === 'image'
    || p.contentKind === 'video'
    || p.contentKind === 'audio'
}

function Card({
  page,
  degree,
  themeApi,
  onOpen,
}: {
  page: ResolvedPage
  degree: number
  themeApi: ReturnType<typeof useThemes>
  onOpen: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const cover = pageHasCover(page)
  const isWeb = page.kind !== 'note' && page.contentKind === 'web'
  const preview = cover || page.contentKind === 'pdf' ? '' : getKnowledgePreviewText(page)

  const myThemeIds = themeApi.themesOf(page.refId)
  const myThemes = themeApi.themes.filter((t) => myThemeIds.includes(t.id))

  return (
    <div
      onMouseEnter={() => {
        setHovered(true)
        prefetchPageOfficePreview(page)
      }}
      onMouseLeave={() => {
        setHovered(false)
        setTagOpen(false)
      }}
      className="relative text-left flex flex-col rounded-2xl overflow-hidden transition-all cursor-pointer"
      style={{
        background: 'var(--aa-surface, #fff)',
        border: '1px solid var(--aa-border, rgba(45,40,34,0.09))',
        minHeight: 132,
        transform: hovered ? 'translateY(-2px)' : 'none',
        boxShadow: hovered ? '0 6px 20px rgba(45,40,34,0.08)' : '0 1px 2px rgba(45,40,34,0.03)',
      }}
      onClick={onOpen}
    >
      {cover && <CardCover page={page} hovered={hovered} />}

      {/* 悬停时右上角出现「标签」入口 */}
      {(hovered || tagOpen) && (
        <div className="absolute top-2.5 right-2.5 z-10" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setTagOpen((v) => !v)}
            className="flex items-center justify-center rounded-full transition-colors"
            style={{
              width: 26,
              height: 26,
              background: tagOpen ? 'var(--aa-accent, #6865a7)' : 'rgba(255,255,255,0.92)',
              color: tagOpen ? 'var(--aa-accent-fg, #fff)' : 'var(--aa-text-2, #87827c)',
              boxShadow: '0 1px 4px rgba(45,40,34,0.15)',
            }}
          >
            <Tag size={13} />
          </button>
          {tagOpen && (
            <TagPopover page={page} themeApi={themeApi} myThemeIds={myThemeIds} />
          )}
        </div>
      )}

      <div className="flex flex-col flex-1" style={{ padding: 18 }}>
        <div className="flex items-center gap-2 mb-3">
          {isWeb && page.thumbnail ? (
            <ImageWithFallback src={page.thumbnail} alt="" className="rounded-sm" style={{ width: 14, height: 14, objectFit: 'contain' }} />
          ) : knowledgePageIcon(page)}
          <span className="text-xs" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
            {knowledgeKindLabel(page)}
          </span>
        </div>
        <h3
          className="m-0 text-sm font-medium leading-snug line-clamp-2"
          style={{ color: 'var(--aa-text-1, #292722)' }}
        >
          {page.title}
        </h3>
        {preview && (
          <p
            className="m-0 mt-2 text-xs leading-relaxed line-clamp-6"
            style={{ color: 'var(--aa-text-2, #87827c)' }}
          >
            {preview}
          </p>
        )}
        <div className="flex-1" />

        {/* 归属的主题(可多属:一张卡可能挂多个) */}
        {myThemes.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-3">
            {myThemes.map((t) => (
              <span
                key={t.id}
                className="flex items-center gap-1 rounded-full text-xs"
                style={{ padding: '2px 8px', background: `${t.color}18`, color: t.color }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.color }} />
                {t.name}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 mt-4 text-xs" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
          <span>{formatKnowledgeTimeAgo(page.collectedAt)}</span>
          {degree > 0 && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1">
                <Link2 size={11} />
                {degree}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function prefetchPageOfficePreview(page: ResolvedPage): void {
  const target = page.documentTarget
  if (target === undefined) return
  const preview = getCachedReferencePreview(target.itemId, '', target.apiBase)
  if (preview !== undefined) {
    prefetchDocumentSurface(preview)
  }
}

function CardCover({ page, hovered }: { page: ResolvedPage; hovered: boolean }) {
  const kind = page.contentKind
  if (kind === 'image' && page.thumbnail) return <div className="w-full overflow-hidden" style={{ height: 132 }}><ImageWithFallback src={page.thumbnail} alt={page.title} className="w-full h-full object-cover" style={{ transform: hovered ? 'scale(1.04)' : 'none', transition: 'transform 240ms ease' }} /></div>
  if (kind === 'video') {
    return <div className="relative w-full flex items-center justify-center" style={{ height: 132, background: 'linear-gradient(135deg, #2d2822 0%, #4a4038 100%)' }}>
      <span className="flex items-center justify-center rounded-full transition-transform" style={{ width: 44, height: 44, background: 'rgba(255,255,255,0.16)', transform: hovered ? 'scale(1.1)' : 'none' }}>
        <Film size={18} style={{ color: '#fff' }} />
      </span>
    </div>
  }
  if (kind === 'audio') {
    return <div className="relative w-full flex items-end justify-center gap-1 px-6" style={{ height: 132, background: 'linear-gradient(135deg, #b0885a22 0%, #b0885a3d 100%)', paddingBottom: 28 }}>
      {WAVE.map((height, index) => <span key={index} style={{ width: 4, height: `${height}%`, borderRadius: 2, background: '#b0885a', opacity: 0.75 }} />)}
    </div>
  }
  if (kind === 'pdf') {
    const preview = page.documentTarget === undefined
      ? undefined
      : getCachedReferencePreview(page.documentTarget.itemId, '', page.documentTarget.apiBase)
    const source = preview?.content.kind === 'media' && preview.content.mediaKind === 'pdf'
      ? { url: preview.content.url, byteLength: preview.byteLength, sourceVersion: preview.fingerprint }
      : undefined
    return <PdfDocumentThumbnail
      source={source}
      title={page.title}
      fallbackText={page.previewText === undefined ? undefined : cleanKnowledgeText(page.previewText).slice(0, 240)}
    />
  }
  if (kind === 'code' && page.previewText) {
    return <CodeDocumentSurface source={page.previewText} language={page.language} variant="cover" />
  }
  return null
}

const WAVE = [30, 55, 40, 80, 60, 95, 50, 70, 45, 85, 35, 65, 50, 90, 40, 60, 30]

/** 卡片上的「归入主题」浮层:勾选归属 + 锁定归类。 */
function TagPopover({
  page,
  themeApi,
  myThemeIds,
}: {
  page: ResolvedPage
  themeApi: ReturnType<typeof useThemes>
  myThemeIds: string[]
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  return (
    <div
      className="absolute right-0 mt-2 rounded-xl overflow-hidden"
      style={{
        width: 208,
        background: 'var(--aa-surface, #fff)',
        border: '1px solid var(--aa-border, rgba(45,40,34,0.12))',
        boxShadow: '0 8px 28px rgba(45,40,34,0.16)',
      }}
    >
      <div
        className="px-3 py-2 text-xs"
        style={{ color: 'var(--aa-text-3, #aba39b)', borderBottom: '1px solid var(--aa-border, rgba(45,40,34,0.08))' }}
      >
        归入主题
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto' }}>
        {themeApi.themes.map((t) => {
          const on = myThemeIds.includes(t.id)
          const locked = themeApi.isLocked(page.refId, t.id)
          return (
            <div key={t.id} className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--aa-hover-tint)]">
              <button
                onClick={() => (on ? themeApi.unassign(page.refId, t.id) : themeApi.assign(page.refId, t.id))}
                className="flex items-center gap-2 flex-1 text-left"
              >
                <span
                  className="flex items-center justify-center rounded shrink-0"
                  style={{
                    width: 16,
                    height: 16,
                    background: on ? t.color : 'transparent',
                    border: on ? 'none' : `1.5px solid ${t.color}`,
                  }}
                >
                  {on && <Check size={11} color="#fff" />}
                </span>
                <span className="text-sm" style={{ color: 'var(--aa-text-1, #292722)' }}>
                  {t.name}
                </span>
              </button>
              {on && (
                <button
                  onClick={() => themeApi.toggleLock(page.refId, t.id)}
                  className="p-0.5 rounded hover:bg-[var(--aa-hover-tint)]"
                  style={{ color: locked ? t.color : 'var(--aa-text-3, #cfc9c1)' }}
                >
                  <Lock size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ borderTop: '1px solid var(--aa-border, rgba(45,40,34,0.08))' }}>
        {creating ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (name.trim()) {
                const id = themeApi.createTheme(name)
                themeApi.assign(page.refId, id)
              }
              setName('')
              setCreating(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                setName('')
                setCreating(false)
              }
            }}
            placeholder="新主题名…"
            spellCheck={false}
            className="w-full px-3 py-2 bg-transparent outline-none text-sm"
            style={{ color: 'var(--aa-text-1, #292722)' }}
          />
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 w-full px-3 py-2 text-sm hover:bg-[var(--aa-hover-tint)]"
            style={{ color: 'var(--aa-accent, #6865a7)' }}
          >
            <Plus size={13} />
            新建主题
          </button>
        )}
      </div>
    </div>
  )
}

function FilterChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 rounded-full text-xs transition-colors"
      style={{
        height: 30,
        background: active ? 'var(--aa-accent, #6865a7)' : 'transparent',
        color: active ? 'var(--aa-accent-fg, #fff)' : 'var(--aa-text-2, #87827c)',
        border: active ? '1px solid transparent' : '1px solid var(--aa-border, rgba(45,40,34,0.09))',
      }}
    >
      {label}
      {count != null && <span style={{ opacity: 0.7 }}>{count}</span>}
    </button>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="m-0 text-sm" style={{ color: 'var(--aa-text-2, #87827c)' }}>
        知识库还空着。
      </p>
      <p className="m-0 mt-2 text-xs leading-relaxed" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
        在空间里「收藏」笔记或材料,
        <br />
        它们就会沉淀到这里。
      </p>
    </div>
  )
}

function SectionHead({ icon, label, count }: { icon: React.ReactNode; label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 mb-2" style={{ color: 'var(--aa-text-2, #87827c)' }}>
      {icon}
      <span className="text-xs font-medium">{label}</span>
      <span className="text-xs" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
        {count}
      </span>
    </div>
  )
}

function LinkChip({ page, onClick, onRemove }: { page: ResolvedPage; onClick: () => void; onRemove?: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors"
      style={{ background: hovered ? 'var(--aa-surface-hover, #eeebe6)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      {knowledgePageIcon(page, 12)}
      <span className="flex-1 text-xs truncate" style={{ color: 'var(--aa-text-1, #292722)' }}>
        {page.title}
      </span>
      {onRemove && hovered && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          style={{ color: 'var(--aa-text-3, #aba39b)' }}
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}
