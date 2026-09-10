import type { PersonalWorkspaceProjection } from '../../../workspace'
import { WorkbenchExplorer } from './WorkbenchExplorer'

/** Workspace metadata stays in the directory column; its conversations live in the right pane. */
export function WorkspacePage(props: {
  readonly workspace?: PersonalWorkspaceProjection
  readonly explorerCollapsed: boolean
  readonly onReconnectWorkspace?: (workspaceId: string) => void | Promise<void>
}) {
  const workspace = props.workspace
  return (
    <WorkbenchExplorer collapsed={props.explorerCollapsed}>
      <div className="flex min-h-0 flex-1 flex-col border-r px-4 py-4" style={{ borderColor: 'var(--ui-border)' }}>
        <h1 className="m-0 truncate text-sm font-semibold" style={{ color: 'var(--ui-text-1)' }}>{workspace?.title ?? '工作区'}</h1>
        <p className="mt-2 break-all text-xs leading-relaxed" style={{ color: 'var(--ui-text-3)' }}>{workspace?.rootPath ?? '尚未连接本地目录'}</p>
        {workspace?.status === 'disconnected' && <button
          type="button"
          className="ui-workbench-text-button self-start"
          onClick={() => { void props.onReconnectWorkspace?.(workspace.workspaceId) }}
        >重新连接目录</button>}
      </div>
    </WorkbenchExplorer>
  )
}
