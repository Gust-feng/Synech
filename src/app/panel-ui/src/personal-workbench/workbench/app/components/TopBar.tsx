import { ChevronLeft, ListTree, Maximize2, Search, PanelLeftOpen, PanelLeftClose } from 'lucide-react'
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
  explorerCollapsed: boolean
  onToggleExplorer?: () => void
  surfaceTitle?: string
  /** 对话固定 Owner 徽标，如“空间 · 产品规划”。 */
  surfaceOwner?: string
  conversationState?: LiveConversationState
  onResumeConversation?: () => void
  onEnterFocus?: () => void
  onBrainRoot: () => void
}

// 有自己完整 header 的视图 → TopBar 只保留返回 + 标题。
const MINIMAL_VIEWS: View[] = ['space', 'workspace']

export function TopBar({
  view,
  onNavigate,
  onSearch,
  sidebarCollapsed,
  onToggleSidebar,
  explorerCollapsed,
  onToggleExplorer,
  surfaceTitle,
  surfaceOwner,
  conversationState,
  onResumeConversation,
  onEnterFocus,
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
          title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          aria-expanded={!sidebarCollapsed}
          className="topbar-nav-button shrink-0"
        >
          {sidebarCollapsed
            ? <PanelLeftOpen size={15} strokeWidth={1.75} />
            : <PanelLeftClose size={15} strokeWidth={1.75} />}
        </button>
        {onToggleExplorer !== undefined && (
          <button
            type="button"
            onClick={onToggleExplorer}
            data-explorer-toggle
            aria-label={explorerCollapsed ? '展开目录' : '收起目录'}
            title={explorerCollapsed ? '展开目录' : '收起目录'}
            aria-expanded={!explorerCollapsed}
            className="topbar-nav-button shrink-0"
          >
            <ListTree size={15} aria-hidden="true" />
          </button>
        )}
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
          /* 顶栏只负责全局导航，文件路径与阅读操作留在预览头部。 */
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
                  <ConversationHeaderStatus state={conversationStatus} onClick={onResumeConversation} />
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
          <ConversationHeaderStatus state={conversationStatus} onClick={onResumeConversation} />
        )}
      </div>

      <div className="topbar-drag-region flex-1 self-stretch" data-desktop-drag-region aria-hidden="true" />
      <DesktopWindowControls />
    </header>
  )
}

function topBarSectionLabel(view: View): string {
  if (view === 'search') return '搜索'
  return '首页'
}

function ConversationHeaderStatus({
  state,
  onClick,
}: {
  readonly state: VisibleConversationHeaderState
  readonly onClick?: () => void
}) {
  const label = state === 'working' ? '处理中' : '需要确认'
  const content = (
    <>
      <span className="topbar-conversation-status__dot" aria-hidden="true" />
      {label}
    </>
  )
  if (onClick === undefined) {
    return <span className="topbar-conversation-status" data-state={state} role="status">{content}</span>
  }
  return (
    <button
      type="button"
      className="topbar-conversation-status topbar-conversation-status--action"
      data-state={state}
      aria-label={`${label}，返回当前任务`}
      onClick={onClick}
    >
      {content}
    </button>
  )
}

function searchShortcutLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K'
  return /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? '⌘K' : 'Ctrl K'
}
