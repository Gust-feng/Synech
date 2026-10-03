import { Settings } from 'lucide-react'

/** 侧边栏左下角是全局设置的直接入口。 */
export function SidebarFooter({ onOpenSettings }: { readonly onOpenSettings: () => void }) {
  return (
    <footer className="ui-sidebar-footer">
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="设置"
        className="ui-sidebar-footer__trigger"
      >
        <span className="ui-sidebar-footer__icon" aria-hidden="true">
          <Settings size={14} />
        </span>
        <span className="ui-sidebar-footer__label">设置</span>
      </button>
    </footer>
  )
}
