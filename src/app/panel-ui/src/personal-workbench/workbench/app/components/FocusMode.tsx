import { type ReactNode } from 'react'
import { Minimize2 } from 'lucide-react'
import { DesktopWindowControls } from './DesktopWindowControls'
import {
  visibleConversationHeaderState,
  type LiveConversationState,
} from './conversation-surface-state'

export interface FocusModeHeaderProps {
  readonly title: string
  readonly state: LiveConversationState
  readonly onExit: () => void
}

export function FocusModeHeader(props: FocusModeHeaderProps) {
  const status = focusStatus(props.state)
  const desktopShell = typeof window !== 'undefined' && window.desktopHost !== undefined

  return (
    <header
      className="ui-focus-header flex shrink-0 items-center justify-between"
      data-desktop-shell={desktopShell ? 'true' : 'false'}
    >
      <span className="ui-focus-header__title truncate text-sm font-medium" style={{ color: 'var(--ui-text-2)' }}>
        {props.title}
      </span>
      <div className="ui-focus-drag-region flex-1 self-stretch" data-desktop-drag-region aria-hidden="true" />
      <div className="flex shrink-0 items-center gap-1.5">
        {status !== undefined && (
          <span className="flex items-center gap-1 text-xs font-medium" style={{ color: status.color }}>
            {status.icon}
            {status.label}
          </span>
        )}
        <button
          type="button"
          onClick={props.onExit}
          className="ml-1 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--ui-hover-tint)]"
          style={{ background: 'var(--ui-surface-hover)', color: 'var(--ui-text-1)' }}
        >
          <Minimize2 size={11} />
          退出专注
        </button>
      </div>
      <DesktopWindowControls />
    </header>
  )
}

function focusStatus(state: LiveConversationState): { readonly label: string; readonly color: string; readonly icon: ReactNode } | undefined {
  const visibleState = visibleConversationHeaderState(state)
  if (visibleState === 'working') {
    return {
      label: '处理中',
      color: 'var(--ui-accent)',
      icon: <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor', animation: 'pulse 1.5s infinite' }} />,
    }
  }
  if (visibleState === 'attention') {
    return { label: '需要确认', color: 'var(--ui-status-wait)', icon: <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} /> }
  }
  return undefined
}
