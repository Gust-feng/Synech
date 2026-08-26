import { Fragment, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  CircleAlert,
  Pin,
  PinOff,
  Pencil,
  Trash2,
} from 'lucide-react'
import type { ConversationSummary } from '@ui/contracts/conversation'
import type { PersonalWorkspaceProjection } from '../../../workspace'
import { conversationStatusMarker } from '@ui/features/conversations/conversation-status-marker'
import { SidebarConversationScrollArea, SidebarListRow } from './SidebarRows'

const WORKSPACE_DOT = '#8a7fa8'
const CONVERSATION_DOT_PALETTE = ['#6865a7', '#6f9279', '#c18a42', '#6f84a5', '#a66f66'] as const

export function WorkspaceSidebarLoadingRows() {
  return (
    <div className="space-y-2 px-3 py-1" role="status" aria-label="正在加载工作区">
      <span className="block h-2.5 w-24 animate-pulse rounded" style={{ background: 'var(--ui-surface-hover)' }} />
      <span className="block h-2.5 w-16 animate-pulse rounded" style={{ background: 'var(--ui-surface-hover)' }} />
    </div>
  )
}

export function WorkspaceSidebarRow(props: {
  readonly workspace: PersonalWorkspaceProjection
  readonly onDelete: () => void
  readonly onReconnect: () => void
  readonly conversations: readonly ConversationSummary[]
  readonly activeConversationId?: string
  readonly openConversation: (conversationId: string) => void
  readonly pendingConversationIds: ReadonlySet<string>
  readonly renamingConversationId: string | null
  readonly onStartRenameConversation: (conversationId: string) => void
  readonly onRenameConversation: (conversationId: string, title: string) => void
  readonly onCancelRenameConversation: () => void
  readonly onToggleConversationPinned: (conversationId: string, pinned: boolean) => void
  readonly onDeleteConversation: (conversationId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const pinnedCount = props.conversations.reduce(
    (count, conversation) => count + (conversation.pinnedAt !== undefined ? 1 : 0),
    0,
  )
  return (
    <div className="space-y-0.5">
      <SidebarListRow
        active={false}
        onClick={() => setExpanded((current) => !current)}
        dot={WORKSPACE_DOT}
        label={props.workspace.title}
        editing={false}
        onRename={() => undefined}
        onCancelRename={() => undefined}
        actions={[
          ...(props.workspace.status === 'disconnected' ? [{ label: '重新连接', icon: <AlertCircle size={12}/>, onClick: props.onReconnect }] : []),
          { label: '移除工作区', icon: <Trash2 size={12}/>, danger: true, onClick: props.onDelete },
        ]}
        meta={
          <span className="flex items-center gap-1">
            {props.workspace.status === 'disconnected' && (
              <AlertCircle size={9} style={{ color: 'var(--ui-status-warning)' }} />
            )}
            <ChevronRight
              size={11}
              style={{
                color: 'var(--ui-text-3)',
                transform: expanded ? 'rotate(90deg)' : undefined,
                transition: 'transform 160ms ease',
              }}
            />
          </span>
        }
      />
      {expanded && (
        <SidebarConversationScrollArea maxHeight={220}>
          {props.conversations.length === 0 && (
            <div className="px-3 py-1.5 text-[11px]" style={{ color: 'var(--ui-text-3)' }}>
              暂无对话
            </div>
          )}
          <div className="pl-3 space-y-0.5">
            {props.conversations.map((conversation, index) => (
              <Fragment key={conversation.conversationId}>
                <SidebarListRow
                  active={props.activeConversationId === conversation.conversationId}
                  onClick={() => props.openConversation(conversation.conversationId)}
                  dot={CONVERSATION_DOT_PALETTE[index % CONVERSATION_DOT_PALETTE.length] ?? CONVERSATION_DOT_PALETTE[0]}
                  dotShape="square"
                  label={conversation.title}
                  status={<ConversationStatusIndicator conversation={conversation} />}
                  editing={props.renamingConversationId === conversation.conversationId}
                  editSelectAll={false}
                  onRename={(title) => {
                    props.onRenameConversation(conversation.conversationId, title)
                    props.onCancelRenameConversation()
                  }}
                  onCancelRename={props.onCancelRenameConversation}
                  actions={[
                    {
                      label: conversation.pinnedAt !== undefined ? '取消置顶' : '置顶',
                      icon: conversation.pinnedAt !== undefined ? <PinOff size={12}/> : <Pin size={12}/>,
                      onClick: () => void props.onToggleConversationPinned(
                        conversation.conversationId,
                        conversation.pinnedAt === undefined,
                      ),
                    },
                    { label: '重命名', icon: <Pencil size={12}/>, onClick: () => props.onStartRenameConversation(conversation.conversationId) },
                    { label: '删除', icon: <Trash2 size={12}/>, danger: true, onClick: () => void props.onDeleteConversation(conversation.conversationId) },
                  ]}
                  pending={props.pendingConversationIds.has(conversation.conversationId)}
                />
                {index === pinnedCount - 1
                  && pinnedCount > 0
                  && pinnedCount < props.conversations.length && (
                  <div
                    className="ui-conversation-divider my-1 border-t"
                    style={{ borderColor: 'var(--ui-border)' }}
                    aria-hidden="true"
                  />
                )}
              </Fragment>
            ))}
          </div>
        </SidebarConversationScrollArea>
      )}
    </div>
  )
}

function ConversationStatusIndicator({ conversation }: { readonly conversation: ConversationSummary }) {
  const marker = conversationStatusMarker(conversation)
  if (marker === undefined) return null
  const content = marker.kind === 'working' ? (
    <span aria-hidden="true" className="block animate-spin" style={{ width: 11, height: 11, borderRadius: '50%', border: '1.5px solid var(--ui-accent, #6865a7)', borderTopColor: 'transparent' }} />
  ) : marker.kind === 'attention' ? (
    <span aria-hidden="true" className="block" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ui-status-wait, #D49020)' }} />
  ) : marker.kind === 'failed' ? (
    <AlertTriangle size={12} aria-hidden="true" style={{ color: 'var(--ui-status-error, #C84040)' }} />
  ) : (
    <span aria-hidden="true" className="block" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--ui-text-3, #aba39b)' }} />
  )
  return (
    <span role="img" aria-label={marker.label}>
      {content}
    </span>
  )
}