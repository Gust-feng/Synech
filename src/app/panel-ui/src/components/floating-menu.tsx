import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import '../styles/floating-menu.css'

export interface FloatingMenuAction {
  readonly label: string
  readonly icon?: ReactNode
  readonly danger?: boolean
  readonly onClick: () => void
}

interface FloatingMenuPlacement {
  readonly rect: DOMRect
  readonly mode: 'below' | 'above'
  readonly right?: number
  readonly left?: number
}

interface FloatingMenuProps {
  /** trigger 与菜单的无障碍名称，如「重命名xx」「xx操作」。 */
  readonly label: string
  /** 悬停/选中时是否显示 trigger；false 时 trigger 透明且不可交互。 */
  readonly visible: boolean
  readonly actions: readonly FloatingMenuAction[]
  /** 自定义 trigger 内容，默认「⋯」图标。 */
  readonly trigger?: ReactNode
  /** 菜单对齐方式，默认右对齐 trigger 右缘。 */
  readonly align?: 'left' | 'right'
}

/**
 * 行尾「⋯」操作菜单。菜单通过 portal 渲染到 body 并固定定位，
 * 不受父级 overflow 滚动容器裁剪；窗口空间不足时自动向上翻转。
 * 滚动/缩放/外部点击/Escape 都会关闭菜单。
 */
export function FloatingMenu({ label, visible, actions, trigger, align = 'right' }: FloatingMenuProps) {
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<FloatingMenuPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const popoverId = useId()
  const shown = visible || open
  const gap = 4

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && triggerRef.current?.contains(target)) return
      if (target instanceof Node && popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const closeOnViewportChange = (): void => setOpen(false)
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', closeOnViewportChange, { capture: true })
    window.addEventListener('resize', closeOnViewportChange)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', closeOnViewportChange, { capture: true })
      window.removeEventListener('resize', closeOnViewportChange)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const triggerEl = triggerRef.current
    if (triggerEl === null) return
    const rect = triggerEl.getBoundingClientRect()
    setPlacement({
      rect,
      mode: 'below',
      right: align === 'right' ? Math.max(8, window.innerWidth - rect.right) : undefined,
      left: align === 'left' ? Math.max(8, rect.left) : undefined,
    })
  }, [open, align])

  useLayoutEffect(() => {
    if (!open || placement === null || placement.mode !== 'below') return
    const popoverEl = popoverRef.current
    if (popoverEl === null) return
    const menuHeight = popoverEl.offsetHeight
    const fitsBelow = placement.rect.bottom + gap + menuHeight <= window.innerHeight
    const fitsAbove = placement.rect.top - gap - menuHeight >= 0
    if (fitsBelow || !fitsAbove) return
    setPlacement((current) => (current === null ? current : { ...current, mode: 'above' }))
  }, [open, placement])

  const popoverStyle: CSSProperties = { position: 'fixed', zIndex: 300 }
  if (placement !== null) {
    if (placement.mode === 'below') popoverStyle.top = placement.rect.bottom + gap
    else popoverStyle.bottom = window.innerHeight - placement.rect.top + gap
    if (placement.right !== undefined) popoverStyle.right = placement.right
    if (placement.left !== undefined) popoverStyle.left = placement.left
  }

  const select = (action: FloatingMenuAction): void => {
    setOpen(false)
    action.onClick()
  }

  return (
    <span className="aa-floating-menu" onClick={(event) => event.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        tabIndex={shown ? 0 : -1}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
        }}
        className="aa-floating-menu__trigger"
        style={{ opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none' }}
      >
        {trigger ?? <MoreHorizontal size={14} />}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          role="menu"
          aria-label={label}
          className="aa-floating-menu__popover"
          style={popoverStyle}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              onClick={() => select(action)}
              className={action.danger === true ? 'aa-floating-menu__item aa-floating-menu__item--danger' : 'aa-floating-menu__item'}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )
}
