import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  Code2,
  File as FileIcon,
  FileSpreadsheet,
  FileType2,
  Film,
  Globe,
  Image as ImageIcon,
  Link2,
  Lock,
  LockOpen,
  Music,
  NotebookPen,
  Play,
  Plus,
  Tag,
} from 'lucide-react'
import { CodeDocumentSurface } from '../CodeDocumentSurface'
import { PdfDocumentThumbnail } from '../PdfDocumentSurface'
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
import { getCachedReferencePreview, type DocumentPreview } from '../referencePreviewClient'
import { prefetchDocumentSurface } from '../documentPreviewWarmup'
import {
  getCachedDocxPreviewMarkup,
  getCachedSpreadsheetPreview,
  loadDocxPreviewMarkup,
  loadSpreadsheetPreview,
  type DocxPreviewMarkup,
} from '../officePreviewRuntime'
import { getWarmedVideoPoster, subscribeVideoPreviewPoster } from '../videoPreviewRuntime'
import type { SpreadsheetCellValue, SpreadsheetSheet } from '../spreadsheetPreviewTypes'
import './knowledge-cards.css'

/** 所有格式封面统一高度：网格行高只由正文决定，不会被某一种格式撑大。 */
export const CARD_COVER_HEIGHT = 148
const SHEET_PREVIEW_ROWS = 6
const SHEET_PREVIEW_COLS = 6

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

/** 封面本身已经承载正文的格式，卡片正文不再重复摘录。 */
function coverCarriesBodyText(page: ResolvedPage): boolean {
  if (page.kind === 'note') return true
  return page.contentKind === 'markdown' || page.contentKind === 'code' || page.contentKind === 'web'
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
  const isWeb = page.kind !== 'note' && page.contentKind === 'web'
  const excerpt = coverCarriesBodyText(page) ? '' : getKnowledgePreviewText(page)

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
      <KnowledgeCardCover page={page} hovered={hovered} />

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
        {excerpt && (
          <p
            className="m-0 mt-2 text-xs leading-relaxed line-clamp-3"
            style={{ color: 'var(--ui-text-2, #87827c)' }}
          >
            {excerpt}
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

/* ------------------------------ 封面分发 ------------------------------ */

function KnowledgeCardCover({ page, hovered }: { page: ResolvedPage; hovered: boolean }) {
  if (page.kind === 'note') {
    return <TextPaperCover text={getKnowledgePreviewText(page)} icon={<NotebookPen size={22} />} />
  }
  switch (page.contentKind) {
    case 'image':
      return <ImageCover page={page} hovered={hovered} />
    case 'video':
      return <VideoCover page={page} />
    case 'audio':
      return <AudioCover page={page} />
    case 'pdf':
      return <PdfCover page={page} />
    case 'docx':
      return <DocxCover page={page} />
    case 'xlsx':
      return <SpreadsheetCover page={page} />
    case 'code':
      return page.previewText
        ? <CodeDocumentSurface source={page.previewText} language={page.language} variant="cover" />
        : <IconCover icon={<Code2 size={24} />} />
    case 'markdown':
      return <TextPaperCover text={getKnowledgePreviewText(page)} />
    case 'web':
      return <WebCover page={page} />
    default:
      // 纯文本文件在元数据到达后也走纸张摘录；其余通用文件显示类型占位。
      return page.previewText
        ? <TextPaperCover text={cleanKnowledgeText(page.previewText)} />
        : <GenericFileCover page={page} />
  }
}

function pageCachedPreview(page: ResolvedPage): DocumentPreview | undefined {
  const target = page.documentTarget
  return target === undefined ? undefined : getCachedReferencePreview(target.itemId, '', target.apiBase)
}

type MediaContent = Extract<DocumentPreview['content'], { kind: 'media' }>
function mediaContent<K extends MediaContent['mediaKind']>(
  page: ResolvedPage,
  mediaKind: K,
): (MediaContent & { mediaKind: K }) | undefined {
  const preview = pageCachedPreview(page)
  return preview?.content.kind === 'media' && preview.content.mediaKind === mediaKind
    ? (preview.content as MediaContent & { mediaKind: K })
    : undefined
}

function previewFingerprint(page: ResolvedPage): string | undefined {
  return pageCachedPreview(page)?.fingerprint
}

/* ------------------------------ 图片 ------------------------------ */

function ImageCover({ page, hovered }: { page: ResolvedPage; hovered: boolean }) {
  if (!page.thumbnail) return <IconCover icon={<ImageIcon size={24} />} />
  return (
    <div className="knowledge-card-cover">
      <ImageWithFallback
        src={page.thumbnail}
        alt={page.title}
        className="knowledge-card-cover__image"
        style={{ transform: hovered ? 'scale(1.04)' : 'none' }}
      />
    </div>
  )
}

/* ------------------------------ 视频 ------------------------------ */

function VideoCover({ page }: { page: ResolvedPage }) {
  const video = mediaContent(page, 'video')
  const fingerprint = previewFingerprint(page)
  const [, force] = useState(0)
  useEffect(() => subscribeVideoPreviewPoster(() => force((value) => value + 1)), [])
  const poster = video?.poster ?? (video ? getWarmedVideoPoster(video.url, fingerprint) : undefined)

  if (!poster) {
    return (
      <div
        className="knowledge-card-cover"
        style={{ background: 'linear-gradient(135deg, #2d2822 0%, #4a4038 100%)' }}
      >
        <span className="knowledge-card-cover__play">
          <span>
            <Film size={18} />
          </span>
        </span>
        {video?.duration && <span className="knowledge-card-cover__badge">{video.duration}</span>}
      </div>
    )
  }
  return (
    <div className="knowledge-card-cover">
      <img src={poster} alt={page.title} className="knowledge-card-cover__video-frame" />
      <span className="knowledge-card-cover__play">
        <span>
          <Play size={18} fill="currentColor" />
        </span>
      </span>
      {video?.duration && <span className="knowledge-card-cover__badge">{video.duration}</span>}
    </div>
  )
}

/* ------------------------------ 音频 ------------------------------ */

function AudioCover({ page }: { page: ResolvedPage }) {
  const audio = mediaContent(page, 'audio')
  return (
    <div
      className="knowledge-card-cover"
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: 4,
        padding: '0 24px 28px',
        background: 'linear-gradient(135deg, #b0885a22 0%, #b0885a3d 100%)',
      }}
    >
      {WAVE.map((height, index) => (
        <span
          key={index}
          style={{ width: 4, height: `${height}%`, borderRadius: 2, background: '#b0885a', opacity: 0.75 }}
        />
      ))}
      <span className="absolute left-3 top-3" style={{ color: '#b0885a' }}>
        <Music size={16} />
      </span>
      {audio?.duration && <span className="knowledge-card-cover__badge">{audio.duration}</span>}
    </div>
  )
}

/* ------------------------------ PDF ------------------------------ */

function PdfCover({ page }: { page: ResolvedPage }) {
  const preview = pageCachedPreview(page)
  const source = preview?.content.kind === 'media' && preview.content.mediaKind === 'pdf'
    ? { url: preview.content.url, byteLength: preview.byteLength, sourceVersion: preview.fingerprint }
    : undefined
  return (
    <PdfDocumentThumbnail
      source={source}
      title={page.title}
      fallbackText={page.previewText === undefined ? undefined : cleanKnowledgeText(page.previewText).slice(0, 480)}
    />
  )
}

/* ------------------------------ Word ------------------------------ */

const injectedDocxStyles = new Set<string>()

function ensureDocxStylesInjected(styleHtml: string): void {
  if (injectedDocxStyles.has(styleHtml)) return
  injectedDocxStyles.add(styleHtml)
  const host = globalThis.document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.position = 'absolute'
  host.style.width = '0'
  host.style.height = '0'
  host.style.overflow = 'hidden'
  host.innerHTML = styleHtml
  globalThis.document.body.append(host)
}

function DocxCover({ page }: { page: ResolvedPage }) {
  const preview = pageCachedPreview(page)
  const office = preview?.content.kind === 'office' && preview.content.officeKind === 'docx' ? preview.content : undefined
  const [markup, setMarkup] = useState<DocxPreviewMarkup | undefined>(() =>
    office === undefined ? undefined : getCachedDocxPreviewMarkup(office.url, preview?.fingerprint),
  )

  useEffect(() => {
    if (office === undefined || preview === undefined) {
      setMarkup(undefined)
      return
    }
    const controller = new AbortController()
    const cached = getCachedDocxPreviewMarkup(office.url, preview.fingerprint)
    if (cached !== undefined) {
      setMarkup(cached)
      return () => controller.abort()
    }
    void loadDocxPreviewMarkup({
      url: office.url,
      byteLength: preview.byteLength,
      sourceVersion: preview.fingerprint,
      signal: controller.signal,
    }).then((next) => {
      if (!controller.signal.aborted) setMarkup(next)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [office?.url, preview?.fingerprint, preview?.byteLength])

  const viewportRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.32)

  useLayoutEffect(() => {
    if (markup === undefined) return
    ensureDocxStylesInjected(markup.styleHtml)
    const viewport = viewportRef.current
    const measure = () => {
      const section = pageRef.current?.querySelector('section.ui-docx') ?? pageRef.current?.firstElementChild
      const pageWidth = (section as HTMLElement | null)?.offsetWidth
      if (viewport !== null && pageWidth !== undefined && pageWidth > 0) {
        setScale(viewport.clientWidth / pageWidth)
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined' || viewport === null) return
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [markup])

  if (markup === undefined) return <IconCover icon={<FileType2 size={24} />} />
  return (
    <div className="knowledge-card-cover">
      <div className="knowledge-card-cover__docx-viewport" ref={viewportRef}>
        <div
          className="knowledge-card-cover__docx-page"
          ref={pageRef}
          style={{ transform: `scale(${scale})` }}
          dangerouslySetInnerHTML={{ __html: markup.bodyHtml }}
        />
      </div>
    </div>
  )
}

/* ------------------------------ Excel ------------------------------ */

function SpreadsheetCover({ page }: { page: ResolvedPage }) {
  const preview = pageCachedPreview(page)
  const office = preview?.content.kind === 'office' && preview.content.officeKind === 'xlsx' ? preview.content : undefined
  const [sheets, setSheets] = useState<readonly SpreadsheetSheet[] | undefined>(() =>
    office === undefined ? undefined : getCachedSpreadsheetPreview(office.url, preview?.fingerprint),
  )

  useEffect(() => {
    if (office === undefined || preview === undefined) {
      setSheets(undefined)
      return
    }
    const controller = new AbortController()
    const cached = getCachedSpreadsheetPreview(office.url, preview.fingerprint)
    if (cached !== undefined) {
      setSheets(cached)
      return () => controller.abort()
    }
    void loadSpreadsheetPreview({
      url: office.url,
      byteLength: preview.byteLength,
      sourceVersion: preview.fingerprint,
      signal: controller.signal,
    }).then((next) => {
      if (!controller.signal.aborted) setSheets(next)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [office?.url, preview?.fingerprint, preview?.byteLength])

  if (sheets === undefined || sheets[0] === undefined) {
    return <IconCover icon={<FileSpreadsheet size={24} />} />
  }
  const sheet = sheets[0]
  const rows = sheet.data.slice(0, SHEET_PREVIEW_ROWS)
  const widestRow = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const columnCount = Math.max(1, Math.min(SHEET_PREVIEW_COLS, widestRow))
  return (
    <div className="knowledge-card-cover">
      <div className="knowledge-card-cover__sheet">
        <div className="knowledge-card-cover__sheet-name">{sheet.sheet}</div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }} />
              {Array.from({ length: columnCount }, (_, index) => (
                <th key={index}>{columnLetter(index)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th>{rowIndex + 1}</th>
                {Array.from({ length: columnCount }, (_, columnIndex) => (
                  <td key={columnIndex}>{formatSheetCell(row[columnIndex])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function columnLetter(index: number): string {
  return String.fromCharCode(65 + index)
}

function formatSheetCell(value: SpreadsheetCellValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toLocaleDateString()
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

/* --------------------------- 文字纸张（笔记 / Markdown / 文本） --------------------------- */

function TextPaperCover({ text, icon }: { text: string; icon?: ReactNode }) {
  const body = cleanKnowledgeText(text)
  return (
    <div className="knowledge-card-cover">
      <div className="knowledge-card-cover__paper">
        {body ? (
          <p className="knowledge-card-cover__paper-text">{body.slice(0, 320)}</p>
        ) : (
          <div className="knowledge-card-cover__skeleton">
            {icon !== undefined && (
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>{icon}</div>
            )}
            {[92, 84, 96, 70, 88, 62].map((width, index) => (
              <span key={index} style={{ width: `${width}%` }} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------ 网页 ------------------------------ */

function WebCover({ page }: { page: ResolvedPage }) {
  const preview = pageCachedPreview(page)
  const web = preview?.content.kind === 'web' ? preview.content : undefined
  const host = hostnameOf(web?.site ?? web?.url ?? page.detail)
  const body = cleanKnowledgeText(page.previewText)
  return (
    <div className="knowledge-card-cover">
      <div className="knowledge-card-cover__browser">
        <div className="knowledge-card-cover__browser-bar">
          <span className="knowledge-card-cover__browser-dot" />
          <span className="knowledge-card-cover__browser-dot" />
          <span className="knowledge-card-cover__browser-dot" />
          <span style={{ marginLeft: 4, display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <Globe size={10} aria-hidden="true" />
            <span className="min-w-0 truncate">{host || '网页'}</span>
          </span>
        </div>
        <div className="knowledge-card-cover__browser-body">
          {body ? (
            <p className="knowledge-card-cover__paper-text" style={{ WebkitLineClamp: 6 }}>{body.slice(0, 260)}</p>
          ) : (
            <>
              <span className="knowledge-card-cover__browser-title" />
              {[96, 90, 82, 70].map((width, index) => (
                <span key={index} className="knowledge-card-cover__browser-line" style={{ width: `${width}%` }} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function hostnameOf(source: string | undefined): string {
  if (source === undefined) return ''
  const trimmed = source.trim()
  if (/^https?:\/\//u.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.replace(/^www\./u, '')
    } catch {
      return trimmed
    }
  }
  return trimmed
}

/* ------------------------------ 通用占位 ------------------------------ */

function IconCover({ icon }: { icon: ReactNode }) {
  return (
    <div className="knowledge-card-cover">
      <div className="knowledge-card-cover__placeholder">{icon}</div>
    </div>
  )
}

function GenericFileCover({ page }: { page: ResolvedPage }) {
  const ext = fileExtension(page.detail ?? page.title)
  return (
    <div className="knowledge-card-cover">
      <div className="knowledge-card-cover__placeholder">
        <FileIcon size={26} />
      </div>
      {ext && <span className="knowledge-card-cover__ext">{ext}</span>}
    </div>
  )
}

function fileExtension(label: string): string {
  const match = /\.([a-z0-9]{1,8})$/iu.exec(label.trim())
  return match?.[1] ?? ''
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
