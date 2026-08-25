import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Home,
  Layers,
  Library,
  BookOpen,
  Pencil,
  Trash2,
  Plus,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
  FolderOpen,
  Pin,
  PinOff,
} from 'lucide-react'
import { SidebarAnimation } from './SidebarAnimation'
import { SidebarFooter } from './SidebarFooter'
import {
  SidebarConversationScrollArea,
  SidebarListRow,
  SidebarNavRow,
  SidebarSectionLabel,
} from './SidebarRows'
import { ActionConfirmationDialog } from './ActionConfirmationDialog'
import { conversationStatusMarker } from '@ui/features/conversations/conversation-status-marker'
import type { ConversationSummary } from '@ui/contracts/conversation'
import type { PersonalSpaceProjection } from '../../../space'
import type { PersonalWorkspaceProjection } from '../../../workspace'

/**
 * 所有会话统一进入空间右侧对话面板。
 */
export type View = 'home' | 'space' | 'search' | 'brain' | 'memory'

interface SidebarProps {
  view: View
  onNavigate: (v: View) => void
  onOpenSettings: () => void
  collapsed: boolean
  conversations: readonly ConversationSummary[]
  spaces: readonly PersonalSpaceProjection[]
  spaceLoadState?: {
    readonly loading: boolean
    readonly mutationPending?: boolean
    readonly error?: string
    readonly onRetry: () => void | Promise<void>
  }
  workspaces?: readonly PersonalWorkspaceProjection[]
  workspaceLoadState?: {
    readonly loading: boolean
    readonly mutationPending?: boolean
    readonly error?: string
    readonly onRetry: () => void | Promise<void>
  }
  onAddWorkspace?: () => void | Promise<void>
  /** 仅移出侧栏；外部文件、Space 引用与历史对话保留。 */
  onHideWorkspace?: (workspaceId: string) => void | Promise<void>
  onReconnectWorkspace?: (workspaceId: string) => void | Promise<void>
  activeSpaceId: string | null
  activeConversationId?: string
  onOpenConversation: (conversationId: string) => boolean | Promise<boolean>
  pendingConversationIds: ReadonlySet<string>
  onRenameConversation: (conversationId: string, title: string) => void | Promise<void>
  onToggleConversationPinned: (conversationId: string, pinned: boolean) => void | Promise<void>
  onDeleteConversation: (conversationId: string) => void | Promise<void>
  onOpenSpace?: (spaceId: string) => void | Promise<void>
  onActiveSpaceChange: (spaceId: string) => void
  onCreateSpace?: (title: string) => void | Promise<void>
  onRenameSpace?: (spaceId: string, title: string) => void | Promise<void>
  onDeleteSpace?: (spaceId: string) => void | Promise<void>
}

const SIDEBAR_W           = 236
const SIDEBAR_COLLAPSED_W = 0

const CONVERSATION_DOT_PALETTE = ['#6865a7', '#6f9279', '#c18a42', '#6f84a5', '#a66f66'] as const
const SPACE_DOT_FALLBACK = '#a8c4b4'

// ── Sidebar ──────────────────────────────────────────────────────────────────
export function Sidebar({
  view,
  onNavigate,
  onOpenSettings,
  collapsed,
  conversations,
  spaces,
  spaceLoadState,
  workspaces = [],
  workspaceLoadState,
  onAddWorkspace,
  onHideWorkspace,
  onReconnectWorkspace,
  activeSpaceId,
  activeConversationId,
  onOpenConversation,
  pendingConversationIds,
  onRenameConversation,
  onToggleConversationPinned,
  onDeleteConversation,
  onOpenSpace,
  onActiveSpaceChange,
  onCreateSpace,
  onRenameSpace,
  onDeleteSpace,
}: SidebarProps) {
  // Structural state changes are intentionally atomic. The previous staged
  // label/width timers left the sidebar in a visible in-between geometry, which
  // read as horizontal drift. Only the contained mist mark retains motion.
  const labelsVisible = !collapsed

  const projectedSpaces = useMemo(() => spaces.map((space) => ({
    id: space.spaceId,
    label: space.title,
    dot: space.color ?? SPACE_DOT_FALLBACK,
  })), [spaces])
  const orderedConversations = useMemo(
    () => [...conversations].sort(compareConversations),
    [conversations],
  )
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameSelectAll, setRenameSelectAll] = useState(false)
  const pendingSpaceIdsRef = useRef<Set<string> | null>(null)
  const [openingConversationId, setOpeningConversationId] = useState<string | null>(null)
  const conversationOpenRequestRef = useRef(0)
  const [pendingSpaceDeletion, setPendingSpaceDeletion] = useState<{ readonly id: string; readonly label: string } | null>(null)
  const [pendingWorkspaceRemoval, setPendingWorkspaceRemoval] = useState<{ readonly id: string; readonly label: string } | null>(null)

  async function openConversation(conversationId: string) {
    if (openingConversationId === conversationId || pendingConversationIds.has(conversationId)) return
    const requestId = ++conversationOpenRequestRef.current
    setOpeningConversationId(conversationId)
    try {
      const opened = await onOpenConversation(conversationId)
      if (conversationOpenRequestRef.current !== requestId) return
      // The host opens the loaded Conversation in its current Synech surface.
      if (opened !== false) onNavigate('space')
    } catch {
      // The runtime owns the visible load error; the sidebar only prevents a false navigation.
    } finally {
      if (conversationOpenRequestRef.current === requestId) {
        setOpeningConversationId((current) => current === conversationId ? null : current)
      }
    }
  }

  // Conversation metadata becomes active before historical runs finish
  // loading. Navigate on that authoritative state change instead of keeping
  // the previous surface mounted until the full load promise settles.
  // The host owns the target surface while the Sidebar mirrors the loaded Conversation.
  useEffect(() => {
    if (openingConversationId === null || activeConversationId !== openingConversationId) return
    onNavigate('space')
    setOpeningConversationId(null)
  }, [activeConversationId, onNavigate, openingConversationId])

  useEffect(() => {
    const previousIds = pendingSpaceIdsRef.current
    if (previousIds === null) return
    const created = projectedSpaces.find((space) => !previousIds.has(space.id))
    if (created === undefined) return
    pendingSpaceIdsRef.current = null
    setRenamingId(created.id)
    setRenameSelectAll(true)
  }, [projectedSpaces])

  function finishRename() {
    setRenamingId(null)
    setRenameSelectAll(false)
  }

  function selectSpace(id: string) {
    onActiveSpaceChange(id)
    onNavigate('space')
    void onOpenSpace?.(id)
  }
  function renameSpace(id: string, label: string) {
    void Promise.resolve().then(() => onRenameSpace?.(id, label)).catch(() => undefined)
  }
  function addSpace() {
    if (onCreateSpace === undefined) return
    pendingSpaceIdsRef.current = new Set(projectedSpaces.map((space) => space.id))
    void Promise.resolve().then(() => onCreateSpace('新空间')).catch(() => {
      pendingSpaceIdsRef.current = null
    })
  }

  function confirmSpaceDeletion(): void {
    const pending = pendingSpaceDeletion
    if (pending === null || onDeleteSpace === undefined) return
    setPendingSpaceDeletion(null)
    try {
      const result = onDeleteSpace(pending.id)
      void Promise.resolve(result).catch(() => undefined)
    } catch {
      // The owner projects the mutation error; the sidebar only closes its confirmation surface.
    }
  }

  function confirmWorkspaceRemoval(): void {
    const pending = pendingWorkspaceRemoval
    if (pending === null || onHideWorkspace === undefined) return
    setPendingWorkspaceRemoval(null)
    try {
      const result = onHideWorkspace(pending.id)
      void Promise.resolve(result).catch(() => undefined)
    } catch {
      // The owner projects the mutation error; the sidebar only closes its confirmation surface.
    }
  }

  return (
    <aside
      className="relative h-full shrink-0 select-none overflow-hidden"
      style={{
        width:    collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W,
        minWidth: collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W,
        background:  'var(--ui-surface)',
        // 收起后连边框都不留,做到真正意义上的「消失」。
        borderRight: collapsed ? 'none' : '1px solid var(--ui-border)',
        // Only the outer rail width animates. The inner column stays a fixed
        // width and is simply clipped, so no descendant ever reflows / drifts
        // while the rail glides between states.
        transition: 'width 260ms cubic-bezier(0.4,0,0.2,1), min-width 260ms cubic-bezier(0.4,0,0.2,1)',
      }}
    >
      <style>{`
        .ui-conversation-scroll { scrollbar-width: none; -ms-overflow-style: none; }
        .ui-conversation-scroll::-webkit-scrollbar { display: none; }
      `}</style>
      {/* Full-height line-art backdrop — sits behind everything (山雾远岫 · 水月孤舟).
          Kept faint so nav labels stay legible; clipped by the rail when collapsed. */}
      <SidebarAnimation collapsed={collapsed} />

      {/* 收起 / 展开 的开关统一放在 TopBar 里(同一位置,点击前后无位移),
          这里不再自带按钮。 */}

      {/* Fixed-width inner column — never resizes, so nothing inside can be
          compressed or pushed around during the collapse animation. Sits above
          the line-art backdrop. */}
      <div
        className="relative flex flex-col h-full"
        style={{ width: SIDEBAR_W, minWidth: SIDEBAR_W, zIndex: 1 }}
      >
      {/* ── Open sky ── */}
      {/* Empty header space so the moon + upper sky of the backdrop read clearly
          and the nav starts below them; also keeps nav from shifting on toggle. */}
      <div style={{
        height: 128,
        flexShrink: 0,
      }} />

      {/* ── Navigation ── */}
      {/* Collapsed: the whole nav column is hidden (fade out). Kept mounted so
          it can be restored instantly if we decide to bring it back. */}
      <nav
        className="flex-1 overflow-y-auto py-2 px-2"
        style={{
          scrollbarWidth: 'none',
          opacity: collapsed ? 0 : 1,
          pointerEvents: collapsed ? 'none' : 'auto',
          transition: collapsed
            ? 'opacity 120ms ease'
            : 'opacity 260ms ease 160ms',
        }}
      >
        {/* Home */}
        <div className="space-y-0.5">
          <SidebarNavRow
            active={view === 'home'}
            onClick={() => onNavigate('home')}
            labelsVisible={labelsVisible}
            collapsed={collapsed}
            icon={<Home size={14}/>}
            label="首页"
          />
        </div>

        {/* Spaces */}
        <div className="group/spaces">
        <SidebarSectionLabel
          label="空间"
          labelsVisible={labelsVisible}
          leadingIcon={<Layers size={12}/>}
          action={
            <button
              type="button"
              onClick={addSpace}
              disabled={onCreateSpace === undefined || spaceLoadState?.mutationPending === true}
              aria-label="新建空间"
              className="flex items-center justify-center rounded transition-opacity hover:bg-[var(--ui-hover-tint)] opacity-0 group-hover/spaces:opacity-50 hover:!opacity-100"
              style={{ width: 18, height: 18, color: 'var(--ui-text-3)', marginRight: -3 }}
            >
              <Plus size={12}/>
            </button>
          }
        />
        <div className="space-y-0.5">
          {spaceLoadState?.loading === true && projectedSpaces.length === 0 && <SpaceLoadingRows />}
          {projectedSpaces.map((s) => (
            <SidebarListRow
              key={s.id}
              active={view === 'space' && activeSpaceId === s.id}
              onClick={() => selectSpace(s.id)}
              dot={s.dot}
              label={s.label}
              editing={renamingId === s.id}
              editSelectAll={renamingId === s.id && renameSelectAll}
              onRename={(t) => { renameSpace(s.id, t); finishRename() }}
              onCancelRename={finishRename}
              actions={[
                { label: '重命名', icon: <Pencil size={12}/>, onClick: () => { setRenameSelectAll(false); setRenamingId(s.id) } },
                { label: '删除', icon: <Trash2 size={12}/>, danger: true, onClick: () => setPendingSpaceDeletion({ id: s.id, label: s.label }) },
              ]}
            />
          ))}
          {spaceLoadState?.error !== undefined && (
            <SpaceLoadFailure message={spaceLoadState.error} onRetry={spaceLoadState.onRetry} />
          )}
        </div>
        </div>

        {/* Workspaces */}
        <div className="group/workspaces">
        <SidebarSectionLabel
          label="工作区"
          labelsVisible={labelsVisible}
          leadingIcon={<FolderOpen size={12}/>}
          action={
            <button
              type="button"
              onClick={() => void onAddWorkspace?.()}
              disabled={onAddWorkspace === undefined || workspaceLoadState?.mutationPending === true}
              aria-label="添加工作区"
              className="flex items-center justify-center rounded transition-opacity hover:bg-[var(--ui-hover-tint)] opacity-0 group-hover/workspaces:opacity-50 hover:!opacity-100"
              style={{ width: 18, height: 18, color: 'var(--ui-text-3)', marginRight: -3 }}
            >
              <Plus size={12}/>
            </button>
          }
        />
        <div className="space-y-0.5">
          {workspaceLoadState?.loading === true && workspaces.length === 0 && <WorkspaceLoadingRows />}
          {workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.workspaceId}
              workspace={workspace}
              onDelete={() => setPendingWorkspaceRemoval({ id: workspace.workspaceId, label: workspace.title })}
              onReconnect={() => { void onReconnectWorkspace?.(workspace.workspaceId) }}
              conversations={orderedConversations.filter((conversation) =>
                conversation.owner?.kind === 'workspace' && conversation.owner.id === workspace.workspaceId)}
              activeConversationId={activeConversationId}
              view={view}
              openConversation={openConversation}
              pendingConversationIds={pendingConversationIds}
              renamingConversationId={renamingId}
              onStartRenameConversation={(conversationId) => { setRenameSelectAll(false); setRenamingId(conversationId) }}
              onRenameConversation={(conversationId, title) => {
                void onRenameConversation(conversationId, title)
                finishRename()
              }}
              onCancelRenameConversation={finishRename}
              onToggleConversationPinned={(conversationId, pinned) => void onToggleConversationPinned(conversationId, pinned)}
              onDeleteConversation={(conversationId) => void onDeleteConversation(conversationId)}
            />
          ))}
          {workspaceLoadState?.error !== undefined && (
            <SpaceLoadFailure message={workspaceLoadState.error} onRetry={workspaceLoadState.onRetry} />
          )}
        </div>
        </div>

        {/* 知识库 */}
        <div className="space-y-0.5 mt-4">
          <SidebarNavRow
            active={view === 'brain'}
            onClick={() => onNavigate('brain')}
            labelsVisible={labelsVisible}
            collapsed={collapsed}
            icon={<Library size={14}/>}
            label="知识库"
          />
          <SidebarNavRow
            active={view === 'memory'}
            onClick={() => onNavigate('memory')}
            labelsVisible={labelsVisible}
            collapsed={collapsed}
            icon={<BookOpen size={14}/>}
            label="记忆"
          />
        </div>
      </nav>

      <SidebarFooter onOpenSettings={onOpenSettings} />
      </div>

      <ActionConfirmationDialog
        request={pendingSpaceDeletion === null ? undefined : {
          eyebrow: '空间操作',
          title: `删除空间“${pendingSpaceDeletion.label}”`,
          description: '空间内的引用将被移除。',
          consequence: '原文件、文件夹和对话不会被删除。',
          confirmLabel: '删除空间',
        }}
        onCancel={() => setPendingSpaceDeletion(null)}
        onConfirm={confirmSpaceDeletion}
      />

      <ActionConfirmationDialog
        request={pendingWorkspaceRemoval === null ? undefined : {
          eyebrow: '工作区操作',
          title: `将“${pendingWorkspaceRemoval.label}”移出侧栏`,
          description: '真实目录、空间引用和历史对话都会保留；重新添加同一目录即可恢复。',
          consequence: '这不会删除电脑上的任何文件。',
          confirmLabel: '移除工作区',
        }}
        onCancel={() => setPendingWorkspaceRemoval(null)}
        onConfirm={confirmWorkspaceRemoval}
      />

    </aside>
  )
}

function SpaceLoadingRows() {
  return (
    <div className="space-y-2 px-3 py-1" role="status" aria-label="正在加载空间">
      <span className="block h-2.5 w-24 animate-pulse rounded" style={{ background: 'var(--ui-surface-hover)' }} />
      <span className="block h-2.5 w-16 animate-pulse rounded" style={{ background: 'var(--ui-surface-hover)' }} />
    </div>
  )
}

function WorkspaceLoadingRows() {
  return (
    <div className="space-y-2 px-3 py-1" role="status" aria-label="正在加载工作区">
      <span className="block h-2.5 w-24 animate-pulse rounded" style={{ background: 'var(--ui-surface-hover)' }} />
      <span className="block h-2.5 w-16 animate-pulse rounded" style={{ background: 'var(--ui-surface-hover)' }} />
    </div>
  )
}

const WORKSPACE_DOT = '#8a7fa8'

function WorkspaceRow(props: {
  readonly workspace: PersonalWorkspaceProjection
  readonly onDelete: () => void
  readonly onReconnect: () => void
  readonly conversations: readonly ConversationSummary[]
  readonly activeConversationId?: string
  readonly view: View
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
                key={conversation.conversationId}
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

function SpaceLoadFailure(props: {
  readonly message: string
  readonly onRetry: () => void | Promise<void>
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5" role="alert" title={props.message}>
      <AlertCircle size={12} className="shrink-0" style={{ color: 'var(--ui-status-error)' }} />
      <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: 'var(--ui-text-3)' }}>空间同步失败</span>
      <button
        type="button"
        aria-label="重新加载空间"
        onClick={() => void props.onRetry()}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--ui-hover-tint)]"
        style={{ color: 'var(--ui-text-3)' }}
      >
        <RotateCcw size={11} />
      </button>
    </div>
  )
}

/**
 * 会话行尾的运行状态标志：处理中/排队用循环圆环，等待用户决定用强调点，
 * 失败用三角感叹号，完成用安静小圆点。idle 与用户主动取消不显示任何标志。
 * 只消费后端 read-model 的 ConversationSummary 状态，不本地猜测。
 */
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

function compareConversations(left: ConversationSummary, right: ConversationSummary): number {
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
