import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import { FloatingMenu, type FloatingMenuAction } from '../../../../components/floating-menu'
import { SidebarInlineRenameField } from './SidebarInlineRenameField'

export interface SidebarNavRowProps {
  readonly active: boolean
  readonly onClick: () => void
  readonly labelsVisible: boolean
  readonly collapsed: boolean
  readonly icon: ReactNode
  readonly label: string
  readonly meta?: ReactNode
}

/** Fixed-geometry navigation row used by the workbench rail. */
export function SidebarNavRow({ active, onClick, labelsVisible, collapsed, icon, label, meta }: SidebarNavRowProps) {
  const [hovered, setHovered] = useState(false)

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative w-full text-sm"
      style={{
        display: 'block',
        height: 32,
        transition: 'color 120ms ease',
        color: active ? 'var(--aa-accent)' : hovered ? 'var(--aa-text-1)' : 'var(--aa-text-2)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: collapsed ? 40 : '100%',
          borderRadius: 8,
          background: active ? 'var(--aa-accent-bg)' : hovered ? 'rgba(45,40,34,0.04)' : 'transparent',
          transition: 'background 120ms ease, width 240ms cubic-bezier(0.4,0,0.2,1)',
        }}
      />

      {active && (
        <span aria-hidden="true" style={{
          position: 'absolute',
          left: 3,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 3,
          height: 14,
          borderRadius: 2,
          background: 'var(--aa-accent)',
          zIndex: 1,
        }}/>
      )}

      <span style={{
        position: 'absolute',
        left: 10,
        top: '50%',
        transform: 'translateY(-50%)',
        width: 20,
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {icon}
      </span>

      <span style={{
        position: 'absolute',
        left: 38,
        right: 10,
        top: '50%',
        transform: labelsVisible ? 'translateY(-50%)' : 'translateY(-50%) translateX(-6px)',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        opacity: labelsVisible ? 1 : 0,
        transition: 'opacity 160ms ease, transform 160ms ease',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        minWidth: 0,
        pointerEvents: labelsVisible ? 'auto' : 'none',
      }}>
        <span className="flex-1 text-left truncate">{label}</span>
        {meta && <span style={{ flexShrink: 0 }}>{meta}</span>}
      </span>
    </button>
  )
}

export interface SidebarListRowProps {
  readonly active: boolean
  readonly onClick: () => void
  readonly dot: string
  /** 标识形状：会话用圆角方块，空间/工作区用圆形（默认）。 */
  readonly dotShape?: 'circle' | 'square'
  readonly label: string
  readonly meta?: ReactNode
  /** 行尾运行状态标志（处理中 / 需要确认 / 失败 / 完成）。悬停时保持可见，
   *  不参与 meta 的淡出；存在时替代打开中的临时 spinner，避免两个转圈。 */
  readonly status?: ReactNode
  readonly editing: boolean
  readonly editSelectAll?: boolean
  readonly onRename: (value: string) => void
  readonly onCancelRename: () => void
  readonly actions: readonly FloatingMenuAction[]
  readonly pending?: boolean
}

/** Conversation and space row with stable geometry and delayed actions. */
export function SidebarListRow({ active, onClick, dot, dotShape = 'circle', label, meta, status, editing, editSelectAll, onRename, onCancelRename, actions, pending = false }: SidebarListRowProps) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      role="button"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => { if (!editing && !pending) onClick() }}
      className="group/row relative flex items-center gap-2 rounded-lg cursor-pointer text-sm"
      style={{
        height: 32,
        paddingLeft: 12,
        paddingRight: 8,
        color: active ? 'var(--aa-accent)' : 'var(--aa-text-2)',
        background: active ? 'var(--aa-accent-bg)' : hovered ? 'rgba(45,40,34,0.04)' : 'transparent',
        transition: 'background 120ms ease, color 120ms ease',
      }}
    >
      <span style={{
        width: 8,
        height: 8,
        borderRadius: dotShape === 'square' ? 2 : '50%',
        background: dot,
        flexShrink: 0,
      }}/>
      {editing ? (
        <SidebarInlineRenameField value={label} onCommit={onRename} onCancel={onCancelRename} selectAll={editSelectAll}/>
      ) : (
        <span className="flex-1 text-left truncate">{label}</span>
      )}
      {!editing && status !== undefined && (
        <span style={{ flexShrink: 0, opacity: hovered && actions.length > 0 ? 0.65 : 1, transition: 'opacity 120ms ease' }}>
          {status}
        </span>
      )}
      {!editing && pending && status === undefined && (
        <LoaderCircle aria-label="处理中" size={13} className="animate-spin shrink-0" />
      )}
      {!editing && !pending && (
        <>
          {meta && (
            <span style={{ flexShrink: 0, opacity: hovered && actions.length > 0 ? 0 : 1 }}>
              {meta}
            </span>
          )}
          {actions.length > 0 && (
            <span className="absolute right-2" style={{ top: '50%', transform: 'translateY(-50%)' }}>
              <FloatingMenu label={`${label}操作`} visible={hovered} actions={actions} />
            </span>
          )}
        </>
      )}
    </div>
  )
}

export function SidebarSectionLabel({
  label,
  labelsVisible,
  leadingIcon,
  action,
}: {
  readonly label: string
  readonly labelsVisible: boolean
  readonly leadingIcon?: ReactNode
  readonly action?: ReactNode
}) {
  return (
    <div
      className="flex items-center justify-between pl-3 pr-2 pt-4 pb-1"
      style={{
        opacity: labelsVisible ? 1 : 0,
        transition: 'opacity 140ms ease',
        pointerEvents: labelsVisible ? 'auto' : 'none',
      }}
    >
      <span className="flex items-center gap-1.5" style={{ color: 'var(--aa-text-3)' }}>
        {leadingIcon !== undefined && <span aria-hidden="true" className="flex items-center justify-center">{leadingIcon}</span>}
        <span className="text-[10px] font-semibold tracking-widest uppercase">
          {label}
        </span>
      </span>
      {action}
    </div>
  )
}

const CONVERSATION_FADE_TOP = 20
const CONVERSATION_FADE_BOTTOM = 24

export function SidebarConversationScrollArea({ maxHeight, children }: { readonly maxHeight: number; readonly children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [fadeTop, setFadeTop] = useState(0)
  const [fadeBottom, setFadeBottom] = useState(0)

  const measureMask = useCallback(() => {
    const element = viewportRef.current
    if (element === null) return
    const distanceFromTop = element.scrollTop
    const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop
    const easeOut = (value: number): number => 1 - Math.pow(1 - value, 2)
    setFadeTop((previous) => {
      const next = Math.round(CONVERSATION_FADE_TOP * easeOut(Math.min(distanceFromTop / CONVERSATION_FADE_TOP, 1)))
      return next === previous ? previous : next
    })
    setFadeBottom((previous) => {
      const next = Math.round(CONVERSATION_FADE_BOTTOM * easeOut(Math.min(Math.max(distanceFromBottom, 0) / CONVERSATION_FADE_BOTTOM, 1)))
      return next === previous ? previous : next
    })
  }, [])

  const animationFrameRef = useRef<number | null>(null)
  const handleScroll = useCallback(() => {
    if (animationFrameRef.current !== null) return
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null
      measureMask()
    })
  }, [measureMask])

  useEffect(() => () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current)
  }, [])

  useLayoutEffect(measureMask, [children, measureMask])

  const mask = `linear-gradient(to bottom, transparent 0px, #000 ${fadeTop}px, #000 calc(100% - ${fadeBottom}px), transparent 100%)`
  return (
    <div
      ref={viewportRef}
      onScroll={handleScroll}
      className="aa-conversation-scroll space-y-0.5 overflow-y-auto"
      style={{ maxHeight, WebkitMaskImage: mask, maskImage: mask }}
      data-conversation-scroll
    >
      {children}
    </div>
  )
}