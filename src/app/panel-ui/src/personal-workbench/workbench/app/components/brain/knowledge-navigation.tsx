import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { Check, ChevronDown, Clock, Columns3, LayoutGrid, Plus, Trash2 } from 'lucide-react'
import type { ResolvedPage } from '../brainStore'
import { knowledgePageIcon } from '../knowledge-view-projection'
import { useThemes, type Theme } from '../themesStore'

export type KnowledgeView = 'browse' | 'stack'

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
                rest: { y: 0, color: 'var(--ui-text-1, #292722)' },
                hover: { y: reducedMotion ? 0 : -2, color: 'var(--ui-accent, #6865a7)' },
                active: { y: 0, color: 'var(--ui-accent, #6865a7)' },
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
          style={{ color: 'var(--ui-text-3, #aba39b)' }}
          animate={{ rotate: open ? 180 : 0 }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: 'easeOut' }}
        >
          <ChevronDown size={14} />
        </motion.span>
        <motion.span
          className="absolute left-0 h-0.5 w-full origin-left rounded-full"
          style={{ bottom: -4, background: 'var(--ui-accent, #6865a7)' }}
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
              background: 'var(--ui-surface, #fff)',
              border: '1px solid var(--ui-border, rgba(45,40,34,0.1))',
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
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--ui-hover-tint)]"
    >
      <span className="mt-0.5 shrink-0" style={{ color: selected ? 'var(--ui-accent, #6865a7)' : 'var(--ui-text-3, #aba39b)' }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm" style={{ color: 'var(--ui-text-1, #292722)' }}>{title}</span>
        <span className="mt-0.5 block text-xs" style={{ color: 'var(--ui-text-3, #aba39b)' }}>{description}</span>
      </span>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" style={{ color: 'var(--ui-accent, #6865a7)' }}>
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

export function KnowledgeNavigation({
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
        borderRight: '1px solid var(--ui-border, rgba(45,40,34,0.08))',
        background: 'var(--ui-surface, #faf9f7)',
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
              <span className="text-xs font-medium" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
                主题
              </span>
              <button
                type="button"
                aria-label="新建主题"
                title="新建主题"
                onClick={() => setAdding(true)}
                className="flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--ui-hover-tint)]"
                style={{ color: 'var(--ui-text-3, #aba39b)' }}
              >
                <Plus aria-hidden="true" size={13} />
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
                  icon={<span className="w-2.5 h-2.5 rounded-full" style={{ background: 'var(--ui-text-3, #cfc9c1)' }} />}
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
                  aria-label="主题名称"
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
                  style={{ color: 'var(--ui-text-1, #292722)', border: '1px solid var(--ui-accent, #6865a7)' }}
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
        <span className="text-xs font-medium" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
          阅读路径
        </span>
        <span className="text-xs" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
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
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={label}
      className="relative isolate flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--ui-hover-tint)]"
      style={{
        color: active ? 'var(--ui-accent-fg, #fff)' : 'var(--ui-text-1, #292722)',
      }}
    >
      {active && (
        <span
          data-knowledge-nav-active
          className="absolute inset-0 z-0 rounded-lg"
          style={{
            background: 'var(--ui-accent, #6865a7)',
            boxShadow: '0 1px 3px rgba(45,40,34,0.12)',
          }}
        />
      )}
      <span className="relative z-[1] shrink-0 flex items-center justify-center" style={{ width: 15, opacity: active ? 1 : 0.7 }}>
        {icon}
      </span>
      <span className="relative z-[1] min-w-0 flex-1 truncate text-sm">{label}</span>
      {count != null && (
        <span className="relative z-[1] shrink-0 text-xs tabular-nums" style={{ opacity: 0.68 }}>
          {count}
        </span>
      )}
    </button>
  )
}

/* 主区里某个主题的标题条:改名 / 删除。 */
export function ThemeHeader({
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
          aria-label={`重命名主题${theme.name}`}
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
          className="min-w-0 flex-1 text-base font-semibold bg-transparent outline-none border-b"
          style={{ color: 'var(--ui-text-1, #292722)', borderColor: theme.color }}
        />
      ) : (
        <h2 className="m-0 min-w-0" style={{ color: 'var(--ui-text-1, #292722)' }}>
          <button
            type="button"
            className="block max-w-full truncate text-left text-base font-semibold"
            title={`重命名主题${theme.name}`}
            onClick={() => (setDraft(theme.name), setEditing(true))}
          >
            {theme.name}
          </button>
        </h2>
      )}
      <span className="text-xs" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
        {count}
      </span>
      <div className="flex-1" />
      <button
        type="button"
        aria-label={`删除主题${theme.name}`}
        title={`删除主题${theme.name}`}
        onClick={() => {
          themeApi.deleteTheme(theme.id)
          onDeleted()
        }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-[var(--ui-hover-tint)]"
        style={{ color: 'var(--ui-text-3, #aba39b)' }}
      >
        <Trash2 aria-hidden="true" size={14} />
      </button>
    </div>
  )
}
