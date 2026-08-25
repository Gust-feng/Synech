import { useState, useEffect, useRef, useMemo } from 'react'
import { Search, FileText, Globe, MessageSquare, NotebookPen, ArrowRight, X } from 'lucide-react'
import { type View } from './Sidebar'
import type { ConversationSummary } from '@ui/contracts/conversation'
import type { PersonalSpaceItemProjection, PersonalSpaceProjection } from '../../../space'
import { GUTTER, READING_WIDTH, composerSurface } from './tokens'
import { useNotes } from './notesStore'
import { searchPersonalKnowledge, type PersonalKnowledgeSearchHit } from './personalKnowledgeClient'

/**
 * 全局检索 —— 覆盖「我写的笔记」、读进来的材料和对话。
 *
 * 当前索引由 SQLite 投影的真实笔记、空间引用和会话组成；后续若引入服务端
 * 检索，本组件只保留结果的呈现与筛选。
 */

type ResultType = 'note' | 'file' | 'web' | 'conversation'
type FilterType = 'all' | ResultType

interface SearchResult {
  id: string
  name: string
  type: ResultType
  space: string
  snippet: string
  /** 搜索命中所用的全文(标题+正文),不展示。 */
  haystack: string
  spaceId?: string
  conversationId?: string
}

/** 从一段正文里,围绕命中词截取一小段摘要。 */
function makeSnippet(text: string, query: string, fallback = ''): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return fallback
  const q = query.trim().toLowerCase()
  if (q) {
    const idx = flat.toLowerCase().indexOf(q)
    if (idx >= 0) {
      const start = Math.max(0, idx - 30)
      return (start > 0 ? '…' : '') + flat.slice(start, start + 90) + '…'
    }
  }
  return flat.slice(0, 90) + (flat.length > 90 ? '…' : '')
}

/** 材料 kind → 搜索结果类型(供筛选与图标)。 */
function flattenSpaceItems(items: readonly PersonalSpaceItemProjection[]): PersonalSpaceItemProjection[] {
  return items.flatMap((item) => [item, ...flattenSpaceItems(item.children ?? [])])
}

function spaceReferenceResultType(kind: PersonalSpaceItemProjection['kind']): ResultType {
  if (kind === 'web_reference') return 'web'
  return 'file'
}

function spaceReferenceKindLabel(kind: PersonalSpaceItemProjection['kind']): string {
  switch (kind) {
    case 'folder': return '文件夹'
    case 'local_file': return '本地文件引用'
    case 'workspace': return '工作区引用'
    case 'managed_folder': return '软件文件夹'
    case 'managed_asset': return '托管资产'
    case 'web_reference': return '网页引用'
    case 'generated_artifact': return '生成内容引用'
  }
}

const FILTER_LABELS: { key: FilterType; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'note', label: '笔记' },
  { key: 'file', label: '材料' },
  { key: 'web', label: '网页' },
  { key: 'conversation', label: '对话' },
]

function resultIcon(type: ResultType) {
  switch (type) {
    case 'note':
      return <NotebookPen size={14} style={{ color: '#6f8778' }} />
    case 'file':
      return <FileText size={14} style={{ color: '#6A90B0' }} />
    case 'web':
      return <Globe size={14} style={{ color: '#4A8A6A' }} />
    case 'conversation':
      return <MessageSquare size={14} style={{ color: 'var(--ui-lavender-mid)' }} />
  }
}

function typeLabel(type: ResultType) {
  switch (type) {
    case 'note': return '笔记'
    case 'file': return '材料'
    case 'web': return '网页'
    case 'conversation': return '对话'
  }
}

interface SearchPageProps {
  onNavigate: (v: View) => void
  spaces: readonly PersonalSpaceProjection[]
  conversations: readonly ConversationSummary[]
  /** 在空间里打开某个笔记/材料。 */
  onOpenInSpace: (spaceId: string, id: string) => void
  /** 打开不再归属于 Space 的长期 Knowledge 条目。 */
  onOpenInKnowledge: (id: string) => void
  onOpenConversation: (conversationId: string) => boolean | Promise<boolean>
}

const searchMemory: { query: string; filter: FilterType } = { query: '', filter: 'all' }

export function SearchPage({ onNavigate, onOpenInSpace, onOpenInKnowledge, onOpenConversation, spaces, conversations }: SearchPageProps) {
  const { notes } = useNotes()
  const [query, setQuery] = useState(searchMemory.query)
  const [debouncedQuery, setDebouncedQuery] = useState(searchMemory.query)
  const [filter, setFilter] = useState<FilterType>(searchMemory.filter)
  const [remoteNotes, setRemoteNotes] = useState<readonly PersonalKnowledgeSearchHit[] | undefined>()
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { searchMemory.query = query }, [query])
  useEffect(() => { searchMemory.filter = filter }, [filter])
  useEffect(() => {
    const input = inputRef.current
    if (input === null) return
    input.focus()
    const length = input.value.length
    input.setSelectionRange(length, length)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    const normalized = debouncedQuery.trim()
    if (!normalized) {
      setRemoteNotes(undefined)
      return undefined
    }
    setRemoteNotes(undefined)
    const abortController = new AbortController()
    void searchPersonalKnowledge(normalized, 50, abortController.signal).then(
      (results) => setRemoteNotes(results),
      (error: unknown) => {
        if (!isAbortError(error)) setRemoteNotes(undefined)
      },
    )
    return () => abortController.abort()
  }, [debouncedQuery])

  // 构建索引:笔记 + 材料 + 对话。debouncedQuery 变化时重算摘要。
  const index = useMemo<SearchResult[]>(() => {
    const spaceTitles = new Map(spaces.map((space) => [space.spaceId, space.title]))
    const noteResults: SearchResult[] = remoteNotes === undefined
      ? notes.map((n) => ({
          id: n.id,
          name: n.title || '无标题',
          type: 'note',
          space: n.spaceId === undefined ? '未归属空间' : spaceTitles.get(n.spaceId) ?? '未归属空间',
          snippet: makeSnippet(n.bodyMarkdown, debouncedQuery, '(空笔记)'),
          haystack: `${n.title} ${n.bodyMarkdown}`,
          spaceId: n.spaceId,
        }))
      : remoteNotes.map(({ note, snippet }) => ({
          id: note.id,
          name: note.title || '无标题',
          type: 'note',
          space: note.spaceId === undefined ? '未归属空间' : spaceTitles.get(note.spaceId) ?? '未归属空间',
          snippet: snippet || '(空笔记)',
          haystack: `${note.title} ${debouncedQuery}`,
          spaceId: note.spaceId,
        }))
    const spaceReferences = spaces.flatMap((space) => flattenSpaceItems(space.items).map((item) => ({
      id: item.itemId,
      name: item.title,
      type: spaceReferenceResultType(item.kind),
      space: space.title,
      snippet: makeSnippet(item.detail ?? '', debouncedQuery, spaceReferenceKindLabel(item.kind)),
      haystack: `${item.title} ${item.detail ?? ''} ${space.title}`,
      spaceId: space.spaceId,
    } satisfies SearchResult)))
    const conversationResults: SearchResult[] = conversations
      .map((conversation) => ({
        id: conversation.conversationId,
        name: conversation.title,
        type: 'conversation',
        space: '对话',
        snippet: makeSnippet(conversation.preview ?? '', debouncedQuery, conversation.status ?? '对话'),
        haystack: `${conversation.title} ${conversation.preview ?? ''}`,
        conversationId: conversation.conversationId,
      }))
    return [...noteResults, ...spaceReferences, ...conversationResults]
  }, [conversations, debouncedQuery, notes, remoteNotes, spaces])

  const filtered = useMemo(
    () =>
      index.filter((r) => {
        const matchesType = filter === 'all' || r.type === filter
        const q = debouncedQuery.trim().toLowerCase()
        const matchesQuery = !q || r.haystack.toLowerCase().includes(q)
        return matchesType && matchesQuery
      }),
    [index, debouncedQuery, filter]
  )

  const counts = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    const hits = index.filter((r) => !q || r.haystack.toLowerCase().includes(q))
    return {
      all: hits.length,
      note: hits.filter((r) => r.type === 'note').length,
      file: hits.filter((r) => r.type === 'file').length,
      web: hits.filter((r) => r.type === 'web').length,
      conversation: hits.filter((r) => r.type === 'conversation').length,
    } as Record<FilterType, number>
  }, [index, debouncedQuery])

  async function handleResultClick(result: SearchResult) {
    if (result.conversationId !== undefined) {
      const opened = await onOpenConversation(result.conversationId)
      // The host opens the loaded Conversation in its current Synech surface.
      if (opened !== false) onNavigate('space')
    } else if (result.spaceId !== undefined) {
      onOpenInSpace(result.spaceId, result.id)
    } else if (result.type === 'note') {
      onOpenInKnowledge(result.id)
    }
  }

  return (
    <div className="flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
        <div className="mx-auto pt-8 pb-16" style={{ maxWidth: READING_WIDTH, paddingLeft: GUTTER, paddingRight: GUTTER }}>
          {/* 搜索框 */}
          <div className="flex items-center gap-3 px-4 py-3 mb-5" style={composerSurface(true)}>
            <Search size={15} style={{ color: 'var(--ui-text-3)', flexShrink: 0 }} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索笔记、材料、对话…"
              spellCheck={false}
              className="flex-1 text-sm outline-none"
              style={{ color: 'var(--ui-text-1)', background: 'transparent' }}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="p-0.5 rounded shrink-0 transition-colors hover:bg-[var(--ui-hover-tint)]"
                style={{ color: 'var(--ui-text-3)' }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* 类型筛选 */}
          <div className="flex items-center gap-1.5 mb-5">
            {FILTER_LABELS.map(({ key, label }) => {
              const active = filter === key
              return (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{
                    background: active ? 'var(--ui-accent-bg)' : 'var(--ui-surface-hover)',
                    color: active ? 'var(--ui-accent)' : 'var(--ui-text-2)',
                    border: active ? '1px solid rgba(104,101,167,0.2)' : '1px solid transparent',
                  }}
                >
                  {label}
                  <span
                    className="rounded px-1 text-[10px]"
                    style={{
                      background: active ? 'rgba(104,101,167,0.15)' : 'rgba(45,40,34,0.07)',
                      color: active ? 'var(--ui-accent)' : 'var(--ui-text-3)',
                    }}
                  >
                    {counts[key]}
                  </span>
                </button>
              )
            })}
          </div>

          {/* 结果计数 */}
          <p className="text-xs mb-4" style={{ color: 'var(--ui-text-3)' }}>
            {debouncedQuery.trim() ? `找到 ${filtered.length} 条结果` : `共 ${filtered.length} 个项目`}
          </p>

          {/* 结果列表 */}
          <div className="space-y-0.5">
            {filtered.map((result) => (
              <button
                key={result.id}
                className="w-full flex items-start gap-3 px-3 py-3 rounded-lg text-left transition-all"
                style={{ background: hoveredId === result.id ? 'var(--ui-surface-hover)' : 'transparent' }}
                onMouseEnter={() => setHoveredId(result.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => void handleResultClick(result)}
              >
                <div className="mt-0.5 shrink-0">{resultIcon(result.type)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-sm font-medium" style={{ color: 'var(--ui-text-1)' }}>
                      {result.name}
                    </span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                      style={{ background: 'rgba(45,40,34,0.05)', color: 'var(--ui-text-3)' }}
                    >
                      {typeLabel(result.type)}
                    </span>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--ui-text-3)', lineHeight: 1.65 }}>
                    {result.snippet}
                  </p>
                  <p className="text-[10px] mt-1" style={{ color: 'var(--ui-text-3)' }}>{result.space}</p>
                </div>
                <div
                  className="mt-0.5 shrink-0 transition-opacity"
                  style={{ opacity: hoveredId === result.id ? 1 : 0, color: 'var(--ui-text-3)' }}
                >
                  <ArrowRight size={13} />
                </div>
              </button>
            ))}
          </div>

          {filtered.length === 0 && (
            <div className="py-16 text-center">
              <p className="text-sm mb-1" style={{ color: 'var(--ui-text-2)' }}>
                没有找到匹配的内容
              </p>
              <p className="text-xs" style={{ color: 'var(--ui-text-3)' }}>
                试试其他关键词,或切换到「全部」类型
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}
