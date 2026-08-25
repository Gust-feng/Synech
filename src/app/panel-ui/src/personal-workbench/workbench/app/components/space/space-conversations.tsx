import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Maximize2, MessageSquare, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import type { PersonalSpaceConversationContext } from '@ui/personal-workbench/space'
import { FloatingMenu } from '@ui/components/floating-menu'
import { InlineName } from './space-actions'

const CONVERSATION_DOT_PALETTE = ['#6865a7', '#6f9279', '#c18a42', '#6f84a5', '#a66f66'] as const

export function SpaceConversationList({
  conversations,
  selectedConversationId,
  renamingConversationId,
  onOpen,
  onStartRename,
  onRename,
  onCancelRename,
  onTogglePinned,
  onDelete,
}: {
  conversations: readonly PersonalSpaceConversationContext[]
  selectedConversationId: string | null
  renamingConversationId: string | null
  onOpen: (conversationId: string) => void
  onStartRename: (conversationId: string) => void
  onRename: (conversationId: string, title: string) => void
  onCancelRename: () => void
  onTogglePinned: (conversationId: string, pinned: boolean) => void
  onDelete: (conversationId: string) => void
}) {
  const orderedConversations = useMemo(
    () => [...conversations].sort(compareConversations),
    [conversations],
  )
  const pinnedCount = orderedConversations.reduce(
    (count, conversation) => count + (conversation.pinnedAt !== undefined ? 1 : 0),
    0,
  )

  return (
    <>
      <div className="flex items-center justify-between px-2.5 mt-4 mb-1">
        <span className="text-xs font-medium" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
          对话
        </span>
      </div>
      {conversations.length === 0 ? (
        <div className="px-3 py-1 text-[11px]" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
          暂无对话
        </div>
      ) : (
        <div
          className="space-y-0.5 overflow-y-auto"
          style={{ maxHeight: 260, scrollbarWidth: 'none' }}
        >
          {orderedConversations.map((conversation, index) => (
            <Fragment key={conversation.conversationId}>
              <SpaceConversationRow
                conversation={conversation}
                dot={CONVERSATION_DOT_PALETTE[index % CONVERSATION_DOT_PALETTE.length] ?? CONVERSATION_DOT_PALETTE[0]}
                selected={selectedConversationId === conversation.conversationId}
                renaming={renamingConversationId === conversation.conversationId}
                onOpen={() => onOpen(conversation.conversationId)}
                onStartRename={() => onStartRename(conversation.conversationId)}
                onRename={(title) => onRename(conversation.conversationId, title)}
                onCancelRename={onCancelRename}
                onTogglePinned={(pinned) => onTogglePinned(conversation.conversationId, pinned)}
                onDelete={() => onDelete(conversation.conversationId)}
              />
              {index === pinnedCount - 1
                && pinnedCount > 0
                && pinnedCount < orderedConversations.length && (
                <div
                  className="ui-conversation-divider mx-2 my-1 border-t"
                  style={{ borderColor: 'var(--ui-border, rgba(45,40,34,0.09))' }}
                  aria-hidden="true"
                />
              )}
            </Fragment>
          ))}
        </div>
      )}
    </>
  )
}

export function SpaceConversationSurface({
  title,
  content,
  onEnterFocus,
}: {
  title: string
  content: ReactNode
  onEnterFocus?: () => void
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden" data-space-conversation>
      <header
        className="flex h-11 shrink-0 items-center justify-between border-b px-5"
        style={{ borderColor: 'var(--ui-border, rgba(45,40,34,0.09))' }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare size={14} style={{ color: 'var(--ui-text-3, #aba39b)' }} aria-hidden="true" />
          <span className="truncate text-xs font-medium" style={{ color: 'var(--ui-text-2, #5f5a53)' }}>
            {title}
          </span>
        </div>
        {onEnterFocus !== undefined && (
          <button
            type="button"
            onClick={onEnterFocus}
            aria-label="专注阅读"
            title="专注阅读"
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors hover:bg-[var(--ui-hover-tint)] focus-visible:outline-none focus-visible:ring-2"
            style={{
              borderColor: 'var(--ui-border, rgba(45,40,34,0.09))',
              color: 'var(--ui-text-3, #aba39b)',
            }}
          >
            <Maximize2 size={12} aria-hidden="true" />
            <span>专注阅读</span>
          </button>
        )}
      </header>
      <div className="flex min-w-0 flex-1 overflow-hidden">
        {content}
      </div>
    </div>
  )
}

function SpaceConversationRow(props: {
  readonly conversation: PersonalSpaceConversationContext
  readonly dot: string
  readonly selected: boolean
  readonly renaming: boolean
  readonly onOpen: () => void
  readonly onStartRename: () => void
  readonly onRename: (title: string) => void
  readonly onCancelRename: () => void
  readonly onTogglePinned: (pinned: boolean) => void
  readonly onDelete: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const pinned = props.conversation.pinnedAt !== undefined

  return (
    <div
      className="group/row flex items-center gap-2 rounded-lg text-sm transition-colors"
      style={{
        height: 30,
        paddingLeft: 10,
        paddingRight: 8,
        color: 'var(--ui-text-2, #6b655d)',
        background: props.selected || hovered ? 'var(--ui-surface-hover, #eeebe6)' : 'transparent',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(false)
      }}
    >
      <span aria-hidden="true" style={{
        width: 8,
        height: 8,
        borderRadius: 2,
        background: props.dot,
        flexShrink: 0,
      }} />
      {props.renaming ? (
        <InlineName
          value={props.conversation.title}
          label={`重命名${props.conversation.title}`}
          onCommit={props.onRename}
          onCancel={props.onCancelRename}
        />
      ) : (
        <button
          type="button"
          aria-current={props.selected ? 'page' : undefined}
          title={props.conversation.title}
          onClick={props.onOpen}
          className="min-w-0 flex-1 truncate rounded text-left"
        >
          {props.conversation.title}
        </button>
      )}
      {!props.renaming && (
        <FloatingMenu
          label={`${props.conversation.title}操作`}
          visible={hovered}
          actions={[
            { label: pinned ? '取消置顶' : '置顶', icon: pinned ? <PinOff size={12} /> : <Pin size={12} />, onClick: () => props.onTogglePinned(!pinned) },
            { label: '重命名', icon: <Pencil size={12} />, onClick: props.onStartRename },
            { label: '删除', icon: <Trash2 size={12} />, danger: true, onClick: props.onDelete },
          ]}
        />
      )}
    </div>
  )
}

function compareConversations(left: PersonalSpaceConversationContext, right: PersonalSpaceConversationContext): number {
  const leftPinned = left.pinnedAt !== undefined
  const rightPinned = right.pinnedAt !== undefined
  if (leftPinned !== rightPinned) return rightPinned ? 1 : -1
  if (leftPinned && rightPinned) {
    const pinnedOrder = timestampValue(right.pinnedAt) - timestampValue(left.pinnedAt)
    if (pinnedOrder !== 0) return pinnedOrder
  }
  return timestampValue(right.updatedAt) - timestampValue(left.updatedAt)
}

function timestampValue(value: string | undefined): number {
  if (value === undefined) return 0
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}
