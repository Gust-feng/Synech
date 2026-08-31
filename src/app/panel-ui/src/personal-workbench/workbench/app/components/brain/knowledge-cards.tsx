import { useState, type ReactNode } from 'react'
import { Check, Film, Link2, Lock, LockOpen, Plus, Tag } from 'lucide-react'
import { CodeDocumentSurface } from '../CodeDocumentSurface'
import type { ResolvedPage } from '../brainStore'
import {
  cleanKnowledgeText,
  formatKnowledgeTimeAgo,
  getKnowledgePreviewText,
  KNOWLEDGE_FILTERS,
  knowledgeKindLabel,
  knowledgePageIcon,
  type KnowledgeKind,
} from '../knowledge-view-projection'
import { useThemes } from '../themesStore'
import { ImageWithFallback } from '../ImageWithFallback'
import { getCachedReferencePreview } from '../referencePreviewClient'
import { prefetchDocumentSurface } from '../documentPreviewWarmup'

export function CardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))' }}>
      {children}
    </div>
  )
}
/* ---------------------- 搜索态:命中平铺 ---------------------- */

export function SearchResults({
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
        <span className="text-sm" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
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
        <p className="py-16 text-center text-sm" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
          没有命中的东西。
        </p>
      ) : (
        <CardGrid>
          {results.map((p) => (
            <KnowledgeCard key={p.refId} page={p} degree={degreeOf(p.refId)} themeApi={themeApi} onOpen={() => onOpen(p.refId)} />
          ))}
        </CardGrid>
      )}
    </div>
  )
}


function pageHasCover(p: ResolvedPage): boolean {
  if (p.contentKind === 'code') return Boolean(p.previewText)
  if (p.contentKind === 'pdf') return true
  return p.contentKind === 'image'
    || p.contentKind === 'video'
    || p.contentKind === 'audio'
}

export function KnowledgeCard({
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
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setHovered(false)
          setTagOpen(false)
        }
      }}
      className="relative text-left flex flex-col rounded-2xl overflow-hidden transition-all cursor-pointer"
      style={{
        background: 'var(--ui-surface, #fff)',
        border: '1px solid var(--ui-border, rgba(45,40,34,0.09))',
        minHeight: 132,
        transform: hovered ? 'translateY(-2px)' : 'none',
        boxShadow: hovered ? '0 6px 20px rgba(45,40,34,0.08)' : '0 1px 2px rgba(45,40,34,0.03)',
      }}
    >
      <button
        type="button"
        aria-label={`打开${page.title}`}
        onClick={onOpen}
        className="absolute inset-0 z-[1] rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
      />
      {cover && <CardCover page={page} hovered={hovered} />}

      {/* 悬停时右上角出现「标签」入口 */}
      {(hovered || tagOpen) && (
        <div className="absolute top-2.5 right-2.5 z-10" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            aria-label={`管理${page.title}的主题`}
            aria-haspopup="dialog"
            aria-expanded={tagOpen}
            onClick={() => setTagOpen((v) => !v)}
            className="flex h-7 w-7 items-center justify-center rounded-full transition-colors"
            style={{
              background: tagOpen ? 'var(--ui-accent, #6865a7)' : 'rgba(255,255,255,0.92)',
              color: tagOpen ? 'var(--ui-accent-fg, #fff)' : 'var(--ui-text-2, #87827c)',
              boxShadow: '0 1px 4px rgba(45,40,34,0.15)',
            }}
          >
            <Tag aria-hidden="true" size={13} />
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
          <span className="text-xs" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
            {knowledgeKindLabel(page)}
          </span>
        </div>
        <h3
          className="m-0 text-sm font-medium leading-snug line-clamp-2"
          style={{ color: 'var(--ui-text-1, #292722)' }}
        >
          {page.title}
        </h3>
        {preview && (
          <p
            className="m-0 mt-2 text-xs leading-relaxed line-clamp-6"
            style={{ color: 'var(--ui-text-2, #87827c)' }}
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
                className="flex max-w-full items-center gap-1 rounded-full text-xs"
                style={{ padding: '2px 8px', background: `${t.color}18`, color: 'var(--ui-text-2, #87827c)' }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.color }} />
                <span className="min-w-0 truncate">{t.name}</span>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 mt-4 text-xs" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
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
    return <PdfCardCover text={page.previewText} />
  }
  if (kind === 'code' && page.previewText) {
    return <CodeDocumentSurface source={page.previewText} language={page.language} variant="cover" />
  }
  return null
}

function PdfCardCover({ text: sourceText }: { text: string | undefined }) {
  const text = sourceText === undefined ? '' : cleanKnowledgeText(sourceText).slice(0, 240)
  return (
    <div className="w-full overflow-hidden px-4 pt-4" style={{ height: 132, background: 'var(--ui-surface-hover, #eeebe6)' }}>
      <div
        className="w-full h-full rounded-t-md overflow-hidden"
        style={{
          boxSizing: 'border-box',
          background: 'var(--ui-paper, #fff)',
          border: '1px solid var(--ui-border, rgba(45,40,34,0.08))',
          borderBottom: 0,
          padding: '14px 16px 18px',
        }}
      >
        {text ? (
          <p
            className="m-0 whitespace-pre-wrap"
            style={{
              display: '-webkit-box',
              overflow: 'hidden',
              color: 'var(--ui-text-2, #6b655e)',
              fontSize: 8.5,
              lineHeight: 1.5,
              fontFamily: 'var(--reading-font)',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 6,
            }}
          >
            {text}
          </p>
        ) : (
          <div className="flex flex-col gap-2" aria-hidden="true">
            {[72, 92, 84, 58, 88, 66].map((width) => (
              <span key={width} className="block h-1 rounded-full" style={{ width: `${width}%`, background: 'var(--ui-border, rgba(45,40,34,0.12))' }} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
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
      role="dialog"
      aria-label={`管理${page.title}的主题`}
      className="absolute right-0 mt-2 rounded-xl overflow-hidden"
      style={{
        width: 208,
        background: 'var(--ui-surface, #fff)',
        border: '1px solid var(--ui-border, rgba(45,40,34,0.12))',
        boxShadow: '0 8px 28px rgba(45,40,34,0.16)',
      }}
    >
      <div
        className="px-3 py-2 text-xs"
        style={{ color: 'var(--ui-text-3, #aba39b)', borderBottom: '1px solid var(--ui-border, rgba(45,40,34,0.08))' }}
      >
        归入主题
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto' }}>
        {themeApi.themes.map((t) => {
          const on = myThemeIds.includes(t.id)
          const locked = themeApi.isLocked(page.refId, t.id)
          return (
            <div key={t.id} className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--ui-hover-tint)]">
              <button
                type="button"
                aria-pressed={on}
                onClick={() => (on ? themeApi.unassign(page.refId, t.id) : themeApi.assign(page.refId, t.id))}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
                <span className="min-w-0 truncate text-sm" style={{ color: 'var(--ui-text-1, #292722)' }}>
                  {t.name}
                </span>
              </button>
              {on && (
                <button
                  type="button"
                  aria-label={`${locked ? '取消锁定' : '锁定'}主题${t.name}`}
                  aria-pressed={locked}
                  onClick={() => themeApi.toggleLock(page.refId, t.id)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--ui-hover-tint)]"
                  style={{ color: locked ? t.color : 'var(--ui-text-3, #cfc9c1)' }}
                >
                  {locked ? <Lock aria-hidden="true" size={12} /> : <LockOpen aria-hidden="true" size={12} />}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ borderTop: '1px solid var(--ui-border, rgba(45,40,34,0.08))' }}>
        {creating ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="新主题名称"
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
            className="w-full px-3 py-2 bg-transparent outline-none text-sm focus-visible:ring-2 focus-visible:ring-inset"
            style={{ color: 'var(--ui-text-1, #292722)' }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 w-full px-3 py-2 text-sm hover:bg-[var(--ui-hover-tint)]"
            style={{ color: 'var(--ui-accent, #6865a7)' }}
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
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 rounded-full text-xs transition-colors"
      style={{
        height: 30,
        background: active ? 'var(--ui-accent, #6865a7)' : 'transparent',
        color: active ? 'var(--ui-accent-fg, #fff)' : 'var(--ui-text-2, #87827c)',
        border: active ? '1px solid transparent' : '1px solid var(--ui-border, rgba(45,40,34,0.09))',
      }}
    >
      {label}
      {count != null && <span style={{ opacity: 0.7 }}>{count}</span>}
    </button>
  )
}


export function KnowledgeEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="m-0 text-sm" style={{ color: 'var(--ui-text-2, #87827c)' }}>
        知识库还空着。
      </p>
      <p className="m-0 mt-2 text-xs leading-relaxed" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
        在空间里「收藏」笔记或材料,
        <br />
        它们就会沉淀到这里。
      </p>
    </div>
  )
}
