import { ChevronLeft, Maximize2, Search, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
import { DesktopWindowControls } from './DesktopWindowControls'
import type { WorkbenchView as View } from '../../../../workbench/navigation-state'
import {
  visibleConversationHeaderState,
  type LiveConversationState,
  type VisibleConversationHeaderState,
} from './conversation-surface-state'
import './top-bar.css'

interface TopBarProps {
  view: View
  onNavigate: (v: View) => void
  onSearch: () => void
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  surfaceTitle?: string
  /** 对话固定 Owner 徽标，如“空间 · 产品规划”。 */
  surfaceOwner?: string
  conversationState?: LiveConversationState
  onEnterFocus?: () => void
  // 知识库路径面包屑:打开的文件标题(无则在知识库根部);点根部回到知识库列表。
  brainFileTitle: string | null
  onBrainRoot: () => void
}

// 有自己完整 header 的视图 → TopBar 只保留返回 + 标题。
const MINIMAL_VIEWS: View[] = ['space']

export function TopBar({
  view,
  onNavigate,
  onSearch,
  sidebarCollapsed,
  onToggleSidebar,
  surfaceTitle,
  surfaceOwner,
  conversationState,
  onEnterFocus,
  brainFileTitle,
  onBrainRoot,
}: TopBarProps) {
  const isMinimal = MINIMAL_VIEWS.includes(view)
  const desktopShell = typeof window !== 'undefined' && window.desktopHost !== undefined
  const conversationStatus = visibleConversationHeaderState(conversationState)

  return (
    <header
      className="topbar-shell flex items-center justify-between px-3 shrink-0"
      data-desktop-shell={desktopShell ? 'true' : 'false'}
      style={{ height: 44, background: 'transparent' }}
    >
      {/* 左 */}
      <div className="flex items-center gap-2 min-w-0">
        {/* 收起 / 展开 始终是同一个按钮、同一个位置 —— 点击前后不产生任何位移。 */}
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-expanded={!sidebarCollapsed}
          className="topbar-nav-button shrink-0"
        >
          {sidebarCollapsed
            ? <PanelLeftOpen size={15} strokeWidth={1.75} />
            : <PanelLeftClose size={15} strokeWidth={1.75} />}
        </button>
        {view !== 'search' && (
          <button
            type="button"
            aria-label="搜索内容与文件"
            aria-keyshortcuts="Control+K Meta+K"
            onClick={onSearch}
            className="topbar-search-trigger shrink-0"
            style={{ color: 'var(--ui-text-3)' }}
          >
            <Search className="topbar-search-icon" size={14} aria-hidden="true" />
            <span className="topbar-search-details" aria-hidden="true">
              <span className="topbar-search-label">搜索内容与文件</span>
              <kbd className="topbar-search-shortcut">{searchShortcutLabel()}</kbd>
            </span>
          </button>
        )}
        {view === 'home' ? null : view === 'brain' ? (
          /* 知识库:走真正的路径面包屑「知识库 › 文件」,不再是「首页」返回。
             复用与其它视图完全一致的按钮 / 标题样式,只是把返回目标换成知识库根部。 */
          <>
            <button
              type="button"
              onClick={onBrainRoot}
              className="topbar-nav-button topbar-back-button shrink-0"
            >
              <ChevronLeft size={15} />
              <span className="text-xs" style={{ color: 'var(--ui-text-3)' }}>
                知识库
              </span>
            </button>
            {brainFileTitle && (
              <span
                className="text-xs truncate max-w-[200px] -ml-1"
                style={{ color: 'var(--ui-text-3)' }}
              >
                {brainFileTitle}
              </span>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              aria-label="返回首页"
              onClick={() => onNavigate('home')}
              className="topbar-nav-button topbar-back-button shrink-0"
            >
              <ChevronLeft size={15} />
              {!isMinimal && (
                <span className="text-xs" style={{ color: 'var(--ui-text-3)' }}>
                  {topBarSectionLabel(view)}
                </span>
              )}
            </button>

            {/* minimal 视图：在 TopBar 展示当前页标题作为路径标记 */}
            {isMinimal && surfaceTitle && (
              <span className="topbar-surface-context">
                <span className="topbar-surface-title">{surfaceTitle}</span>
                {surfaceOwner !== undefined && (
                  <span className="topbar-surface-owner" title={surfaceOwner}>
                    {surfaceOwner}
                  </span>
                )}
                {conversationStatus !== undefined && (
                  <ConversationHeaderStatus state={conversationStatus} />
                )}
                {onEnterFocus !== undefined && (
                  <button
                    type="button"
                    onClick={onEnterFocus}
                    aria-label="专注阅读"
                    className="topbar-focus-button"
                  >
                    <Maximize2 size={13} aria-hidden="true" />
                  </button>
                )}
              </span>
            )}
          </>
        )}

        {/* 非对话视图：运行中 / 待确认仍全局可见，但不劫持用户导航。
            用户显式选择了首页 / 知识库 / 搜索时，只提醒、不强制回到对话页。 */}
        {!isMinimal && conversationStatus !== undefined && (
          <ConversationHeaderStatus state={conversationStatus} />
        )}
      </div>

      <div className="topbar-drag-region flex-1 self-stretch" data-desktop-drag-region aria-hidden="true" />
      <DesktopWindowControls />
    </header>
  )
}

function topBarSectionLabel(view: View): string {
  if (view === 'search' || view === 'memory') return view === 'search' ? '搜索' : '记忆'
  return '首页'
}

function ConversationHeaderStatus({ state }: { readonly state: VisibleConversationHeaderState }) {
  return (
    <span className="topbar-conversation-status" data-state={state} role="status">
      <span className="topbar-conversation-status__dot" aria-hidden="true" />
      {state === 'working' ? '处理中' : '需要确认'}
    </span>
  )
}

function searchShortcutLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K'
  return /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? '⌘K' : 'Ctrl K'
}
