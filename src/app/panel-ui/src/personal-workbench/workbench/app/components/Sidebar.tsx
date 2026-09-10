import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Home,
  Layers,
  Library,
  Pencil,
  Trash2,
  Plus,
  AlertCircle,
  RotateCcw,
  FolderOpen,
} from 'lucide-react'
import { SidebarAnimation } from './SidebarAnimation'
import { SidebarFooter } from './SidebarFooter'
import {
  SidebarListRow,
  SidebarNavRow,
  SidebarSectionLabel,
} from './SidebarRows'
import { ActionConfirmationDialog } from './ActionConfirmationDialog'
import type { PersonalSpaceProjection } from '../../../space'
import type { PersonalWorkspaceProjection } from '../../../workspace'
import { WorkspaceSidebarLoadingRows, WorkspaceSidebarRow } from './WorkspaceSidebarRow'
import type { WorkbenchView } from '../../../../workbench/navigation-state'

/** Global navigation selects resource contexts; conversation navigation belongs to the right pane. */
export type View = WorkbenchView

interface SidebarProps {
  view: View
  onNavigate: (v: View) => void
  onOpenSettings: () => void
  collapsed: boolean
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
  activeWorkspaceId: string | null
  onOpenSpace?: (spaceId: string) => void | Promise<void>
  onActiveSpaceChange: (spaceId: string) => void
  onActiveWorkspaceChange: (workspaceId: string) => void
  onCreateSpace?: (title: string) => void | Promise<void>
  onRenameSpace?: (spaceId: string, title: string) => void | Promise<void>
  onDeleteSpace?: (spaceId: string) => void | Promise<void>
}

const SIDEBAR_W           = 236
const SIDEBAR_COLLAPSED_W = 0

const SPACE_DOT_FALLBACK = '#a8c4b4'

// ── Sidebar ──────────────────────────────────────────────────────────────────
export function Sidebar({
  view,
  onNavigate,
  onOpenSettings,
  collapsed,
  spaces,
  spaceLoadState,
  workspaces = [],
  workspaceLoadState,
  onAddWorkspace,
  onHideWorkspace,
  onReconnectWorkspace,
  activeSpaceId,
  activeWorkspaceId,
  onOpenSpace,
  onActiveSpaceChange,
  onActiveWorkspaceChange,
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
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameSelectAll, setRenameSelectAll] = useState(false)
  const pendingSpaceIdsRef = useRef<Set<string> | null>(null)
  const [pendingSpaceDeletion, setPendingSpaceDeletion] = useState<{ readonly id: string; readonly label: string } | null>(null)
  const [pendingWorkspaceRemoval, setPendingWorkspaceRemoval] = useState<{ readonly id: string; readonly label: string } | null>(null)

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
          {workspaceLoadState?.loading === true && workspaces.length === 0 && <WorkspaceSidebarLoadingRows />}
          {workspaces.map((workspace) => (
            <WorkspaceSidebarRow
              key={workspace.workspaceId}
              workspace={workspace}
              active={view === 'workspace' && activeWorkspaceId === workspace.workspaceId}
              onOpen={() => onActiveWorkspaceChange(workspace.workspaceId)}
              onDelete={() => setPendingWorkspaceRemoval({ id: workspace.workspaceId, label: workspace.title })}
              onReconnect={() => { void onReconnectWorkspace?.(workspace.workspaceId) }}
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
