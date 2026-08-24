import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { Search, X } from 'lucide-react'
import { useBrain, type ResolvedPage } from './brainStore'
import {
  getKnowledgePreviewText,
  matchesKnowledgeFilter,
  type KnowledgeKind,
} from './knowledge-view-projection'
import { useThemes } from './themesStore'
import { panelStorageKey } from '@ui/shell/local-preferences'
import {
  KnowledgeNavigation,
  ThemeHeader,
  type KnowledgeView,
} from './brain/knowledge-navigation'
import {
  CardGrid,
  KnowledgeCard,
  KnowledgeEmptyState,
  SearchResults,
} from './brain/knowledge-cards'
import { KnowledgeReader } from './brain/knowledge-reader'
import {
  KnowledgeWiki,
  WIKI_PANE_WIDTH,
  WIKI_SPINE_WIDTH,
} from './brain/knowledge-wiki'

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
      const left = index < 0 ? 0 : WIKI_PANE_WIDTH + index * (WIKI_PANE_WIDTH - WIKI_SPINE_WIDTH)
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
        <KnowledgeEmptyState />
      </section>
    )
  }

  return (
    <section className="flex-1 flex" style={{ minHeight: 0 }}>
      {/* ── 左栏:纯导航入口 ── */}
      <KnowledgeNavigation
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
              <KnowledgeWiki
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
              <KnowledgeReader
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
                      background: 'var(--ui-surface, #fff)',
                      border: `1px solid ${searching ? 'var(--ui-accent, #6865a7)' : 'var(--ui-border, rgba(45,40,34,0.1))'}`,
                      boxShadow: searching ? '0 4px 16px rgba(104,101,167,0.12)' : '0 1px 2px rgba(45,40,34,0.03)',
                      transition: 'all .15s',
                    }}
                  >
                    <Search size={17} style={{ color: searching ? 'var(--ui-accent, #6865a7)' : 'var(--ui-text-3, #aba39b)' }} />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="想找点什么?搜标题、正文,或直接问……"
                      spellCheck={false}
                      className="flex-1 bg-transparent outline-none text-sm"
                      style={{ color: 'var(--ui-text-1, #292722)' }}
                    />
                    {searching && (
                      <button onClick={() => setQuery('')} className="p-1 rounded-full hover:bg-[var(--ui-hover-tint)]">
                        <X size={15} style={{ color: 'var(--ui-text-3, #aba39b)' }} />
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
                        <h2 className="m-0 mb-5 text-sm font-semibold" style={{ color: 'var(--ui-text-2, #87827c)' }}>
                          {nav === 'all' ? '全部' : nav === 'recent' ? '最近' : '未归类'}
                          <span className="ml-2" style={{ color: 'var(--ui-text-3, #aba39b)', fontWeight: 400 }}>
                            {navCards.length}
                          </span>
                        </h2>
                      )}
                      {navCards.length === 0 ? (
                        <p className="py-16 text-center text-sm" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
                          这里还没有东西。
                        </p>
                      ) : (
                        <CardGrid>
                          {navCards.map((p) => (
                            <KnowledgeCard key={p.refId} page={p} degree={degreeOf(p.refId)} themeApi={themeApi} onOpen={() => openCard(p.refId)} />
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
