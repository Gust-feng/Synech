import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronDown, MessageSquare, Pencil, Pin, PinOff, Search, Trash2 } from 'lucide-react'
import type { Conversation, ConversationSummary } from '@ui/contracts/conversation'
import { FloatingMenu } from '@ui/components/floating-menu'
import { InlineName } from '@ui/components/inline-name'
import { conversationStatusMarker } from '@ui/features/conversations/conversation-status-marker'
import { sameConversationOwner, type ConversationOwnerSelection } from '@ui/workbench/navigation-state'

export interface ConversationPickerProps {
  readonly conversation?: Conversation
  readonly conversations: readonly ConversationSummary[]
  readonly scope: ConversationOwnerSelection | null
  readonly visible: boolean
  readonly pendingIds: ReadonlySet<string>
  readonly onOpen: (id: string) => boolean | Promise<boolean>
  readonly onRename: (id: string, title: string) => void | Promise<void>
  readonly onTogglePinned: (id: string, pinned: boolean) => void | Promise<void>
  readonly onDelete: (id: string) => void | Promise<void>
}

type HistoryGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older'
const PINNED_GROUP_KEY: HistoryGroupKey = 'pinned'

const historyGroupLabels: Record<HistoryGroupKey, string> = {
  pinned: '置顶',
  today: '今天',
  yesterday: '昨天',
  week: '7 天内',
  older: '更早',
}

interface HistoryGroup {
  readonly key: HistoryGroupKey
  readonly label: string
  readonly items: ConversationSummary[]
}

/** History belongs to the conversation pane; opening it never replaces or unmounts the transcript. */
export function ConversationPicker(props: ConversationPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [mutationId, setMutationId] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)
  const insidePointerEventRef = useRef<PointerEvent | null>(null)
  const popoverId = useId()
  const title = props.conversation?.title ?? '新对话'
  const ordered = useMemo(() => props.conversations
    .filter((item) => props.scope !== null && sameConversationOwner(item.owner, props.scope))
    .sort(compareConversations), [props.conversations, props.scope])
  const search = query.trim().toLocaleLowerCase()
  const items = ordered.filter((item) => item.title.toLocaleLowerCase().includes(search))
  const sections = groupHistory(items)
  const firstGroupIsPinned = sections[0]?.key === PINNED_GROUP_KEY
  const showGroupLabels = sections.length > 1 || firstGroupIsPinned

  useEffect(() => {
    requestRef.current += 1
    setOpen(false)
    setQuery('')
    setHoveredId(null)
    setRenamingId(null)
    setOpeningId(null)
    setError(undefined)
  }, [props.scope?.kind, props.scope?.id, props.visible])

  useEffect(() => {
    if (open) {
      const root = rootRef.current
      const firstTarget = root?.querySelector<HTMLElement>('input[type="search"]')
        ?? root?.querySelector<HTMLElement>('[data-conversation-option][aria-current="true"]')
        ?? root?.querySelector<HTMLElement>('[data-conversation-option]')
      firstTarget?.focus({ preventScroll: true })
      return
    }
    requestRef.current += 1
    setOpeningId(null)
    setHoveredId(null)
    setRenamingId(null)
    setQuery('')
    setError(undefined)
  }, [open])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      // Portal 菜单仍属于当前 React 子树；不能只用 DOM contains 判断外部点击。
      if (insidePointerEventRef.current !== event) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function handleListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    // 重命名输入框内的方向键交给文本光标，搜索框内则允许直接下探到列表。
    if (event.target instanceof HTMLInputElement && event.target.type !== 'search') return
    const options = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-conversation-option]:not(:disabled)') ?? [])
    if (options.length === 0) return
    event.preventDefault()
    const current = options.indexOf(document.activeElement as HTMLElement)
    const next = current === -1
      ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
      : event.key === 'ArrowDown'
        ? Math.min(current + 1, options.length - 1)
        : Math.max(current - 1, 0)
    options[next]?.focus({ preventScroll: true })
  }

  async function openConversation(id: string) {
    if (id === props.conversation?.conversationId) {
      setOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
      return
    }
    const request = ++requestRef.current
    setOpeningId(id)
    setError(undefined)
    try {
      const opened = await props.onOpen(id)
      if (request !== requestRef.current) return
      if (opened) {
        setOpen(false)
        triggerRef.current?.focus({ preventScroll: true })
      }
    } catch (reason) {
      if (request === requestRef.current) setError(reason instanceof Error ? reason.message : '对话暂时无法打开')
    } finally {
      if (request === requestRef.current) setOpeningId(null)
    }
  }

  async function mutate(id: string, operation: () => void | Promise<void>) {
    setMutationId(id)
    setRenamingId(null)
    setError(undefined)
    try { await operation() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '对话操作未完成') }
    finally { setMutationId(null) }
  }

  return (
    <div className="ui-conversation-picker" ref={rootRef} onPointerDownCapture={(event) => { insidePointerEventRef.current = event.nativeEvent }}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-conversation-picker-trigger"
        aria-label={'切换对话：' + title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={ordered.length === 0}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{title}</span>
        {ordered.length > 0 && <ChevronDown size={13} aria-hidden="true" />}
      </button>
      {open && (
        <div id={popoverId} className="ui-conversation-picker-popover" role="dialog" aria-label="最近对话">
          <div className="ui-conversation-picker-label">
            <span>最近对话</span>
            {ordered.length > 0 && <span className="ui-conversation-picker-count">{ordered.length}</span>}
          </div>
          {ordered.length > 8 && <div className="ui-conversation-picker-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索对话"
              placeholder="搜索对话"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>}
          {error !== undefined && <p className="ui-conversation-picker-error" role="alert">{error}</p>}
          <div ref={listRef} className="ui-conversation-picker-list" onKeyDown={handleListKeyDown}>
            {items.length === 0 && (
              <div className="ui-conversation-picker-empty">
                <MessageSquare size={15} aria-hidden="true" />
                <span>{search ? '没有匹配的对话' : '这里还没有对话'}</span>
              </div>
            )}
            {sections.map((group) => (
              <div key={group.key} className="ui-conversation-history-group">
                {showGroupLabels && <div className="ui-conversation-history-group-label">{group.label}</div>}
                {group.items.map((item) => {
                  const busy = openingId !== null || mutationId !== null || props.pendingIds.has(item.conversationId)
                  const current = item.conversationId === props.conversation?.conversationId
                  const pending = openingId === item.conversationId || mutationId === item.conversationId || props.pendingIds.has(item.conversationId)
                  const marker = conversationStatusMarker(item)
                  const status = marker?.kind === 'done' ? undefined : marker
                  return (
                    <div
                      key={item.conversationId}
                      className="ui-conversation-history-row"
                      data-current={current}
                      onPointerEnter={() => setHoveredId(item.conversationId)}
                      onPointerLeave={() => setHoveredId((id) => (id === item.conversationId ? null : id))}
                      onFocusCapture={() => setHoveredId(item.conversationId)}
                      onBlurCapture={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoveredId((id) => (id === item.conversationId ? null : id))
                      }}
                    >
                      <div className="ui-conversation-history-main">
                        {renamingId === item.conversationId ? (
                          <div className="ui-conversation-history-edit">
                            <InlineName value={item.title} label="对话名称" onCancel={() => setRenamingId(null)} onCommit={(name) => { void mutate(item.conversationId, () => props.onRename(item.conversationId, name)) }} />
                          </div>
                        ) : (
                          <button type="button" data-conversation-option className="ui-conversation-history-open" disabled={busy} aria-current={current ? 'true' : undefined} aria-busy={pending || undefined} onClick={() => { void openConversation(item.conversationId) }}>
                            <span className="ui-conversation-history-copy">
                              <span className="ui-conversation-history-title">{item.title}</span>
                              {item.pinnedAt !== undefined && <span className="ui-conversation-history-pin" role="img" aria-label="已置顶"><Pin size={11} aria-hidden="true" /></span>}
                            </span>
                            <span className="ui-conversation-history-meta" data-status={pending ? 'working' : status?.kind}>
                              {openingId === item.conversationId ? '打开中…' : pending ? '处理中…' : status?.label ?? relativeDate(item.updatedAt)}
                            </span>
                          </button>
                        )}
                        <FloatingMenu
                          label={item.title + '的操作'}
                          visible={hoveredId === item.conversationId && !busy}
                          actions={[
                            {
                              label: item.pinnedAt === undefined ? '置顶' : '取消置顶',
                              icon: item.pinnedAt === undefined ? <Pin size={12} aria-hidden="true" /> : <PinOff size={12} aria-hidden="true" />,
                              onClick: () => { void mutate(item.conversationId, () => props.onTogglePinned(item.conversationId, item.pinnedAt === undefined)) },
                            },
                            {
                              label: '重命名',
                              icon: <Pencil size={12} aria-hidden="true" />,
                              onClick: () => setRenamingId(item.conversationId),
                            },
                            {
                              label: '删除对话',
                              icon: <Trash2 size={12} aria-hidden="true" />,
                              danger: true,
                              onClick: () => { void mutate(item.conversationId, () => props.onDelete(item.conversationId)) },
                            },
                          ]}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function compareConversations(left: ConversationSummary, right: ConversationSummary): number {
  const pin = Number(right.pinnedAt !== undefined) - Number(left.pinnedAt !== undefined)
  return pin || timestamp(right.pinnedAt ?? right.updatedAt) - timestamp(left.pinnedAt ?? left.updatedAt)
}

function timestamp(value: string | undefined): number {
  const parsed = value === undefined ? 0 : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

function ageInDays(value: string | undefined): number {
  const time = timestamp(value)
  return time === 0 ? Number.NaN : Math.round((startOfDay(new Date()) - startOfDay(new Date(time))) / 86_400_000)
}

function historyGroupOf(item: ConversationSummary): HistoryGroupKey {
  if (item.pinnedAt !== undefined) return 'pinned'
  const days = ageInDays(item.updatedAt)
  if (Number.isNaN(days) || days > 6) return 'older'
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return 'week'
}

/** 列表已按置顶优先、时间倒序排列，分组只按出现顺序聚合，不重排。 */
function groupHistory(items: readonly ConversationSummary[]): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  const index = new Map<HistoryGroupKey, HistoryGroup>()
  for (const item of items) {
    const key = historyGroupOf(item)
    let group = index.get(key)
    if (group === undefined) {
      group = { key, label: historyGroupLabels[key], items: [] }
      index.set(key, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

function relativeDate(value: string | undefined): string {
  const time = timestamp(value)
  if (time === 0) return ''
  const date = new Date(time)
  const days = ageInDays(value)
  if (!Number.isNaN(days) && days <= 0) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (days === 1) return '昨天'
  if (!Number.isNaN(days) && days < 7) return '周' + '日一二三四五六'.charAt(date.getDay())
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === new Date().getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`
}
