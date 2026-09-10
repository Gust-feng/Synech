import { AlertCircle, Trash2 } from 'lucide-react'
import type { PersonalWorkspaceProjection } from '../../../workspace'
import { SidebarListRow } from './SidebarRows'

const WORKSPACE_DOT = '#8a7fa8'

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
  readonly active: boolean
  readonly onOpen: () => void
  readonly onDelete: () => void
  readonly onReconnect: () => void
}) {
  return (
    <SidebarListRow
      active={props.active}
      onClick={props.onOpen}
      dot={WORKSPACE_DOT}
      label={props.workspace.title}
      editing={false}
      onRename={() => undefined}
      onCancelRename={() => undefined}
      actions={[
        ...(props.workspace.status === 'disconnected' ? [{ label: '重新连接', icon: <AlertCircle size={12}/>, onClick: props.onReconnect }] : []),
        { label: '移除工作区', icon: <Trash2 size={12}/>, danger: true, onClick: props.onDelete },
      ]}
      meta={props.workspace.status === 'disconnected' ? <AlertCircle size={10} aria-label="工作区未连接" style={{ color: 'var(--ui-status-warning)' }} /> : undefined}
    />
  )
}
