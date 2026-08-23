import { useEffect, useRef, useState } from 'react'
import { Check, ChevronUp, Monitor, Moon, Settings, Sun } from 'lucide-react'
import {
  applyTheme,
  getInitialTheme,
  saveColorId,
  saveStyleId,
  type ThemeColorId,
} from '../../../../app-theme'

type AppearanceColorId = Extract<ThemeColorId, 'system' | 'light' | 'dark'>

const APPEARANCE_OPTIONS: readonly {
  readonly id: AppearanceColorId
  readonly label: string
  readonly icon: typeof Sun
}[] = [
  { id: 'light', label: '浅色', icon: Sun },
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor },
]

/**
 * 侧边栏左下角沿用导航行语法，只承载已经可用的设置和主题入口。
 * 账号、订阅等尚未存在的产品事实不在这里预留空菜单项。
 */
export function SidebarFooter({ onOpenSettings }: { readonly onOpenSettings: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeColorId, setActiveColorId] = useState<AppearanceColorId>(() => {
    const initialTheme = getInitialTheme()
    return initialTheme.styleId === 'default' && isAppearanceColor(initialTheme.colorId)
      ? initialTheme.colorId
      : 'light'
  })
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    const closeOnViewportChange = (): void => setMenuOpen(false)

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', closeOnViewportChange)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', closeOnViewportChange)
    }
  }, [menuOpen])

  function toggleMenu(): void {
    const currentTheme = getInitialTheme()
    if (currentTheme.styleId === 'default' && isAppearanceColor(currentTheme.colorId)) {
      setActiveColorId(currentTheme.colorId)
    }
    setMenuOpen((open) => !open)
  }

  function selectAppearance(colorId: AppearanceColorId): void {
    if (colorId === activeColorId && getInitialTheme().styleId === 'default') {
      setMenuOpen(false)
      return
    }
    const theme = applyTheme('default', colorId)
    saveStyleId(theme.styleId)
    saveColorId(theme.colorId)
    setActiveColorId(colorId)
    setMenuOpen(false)
  }

  function openSettings(): void {
    setMenuOpen(false)
    onOpenSettings()
  }

  return (
    <footer className="aa-sidebar-footer">
      <div ref={menuRef} className="aa-sidebar-footer-menu">
        <button
          type="button"
          onClick={toggleMenu}
          aria-label="设置与外观"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="aa-sidebar-footer__trigger"
        >
          <span className="aa-sidebar-footer__icon" aria-hidden="true">
            <Settings size={14} />
          </span>
          <span className="aa-sidebar-footer__label">设置</span>
          <ChevronUp
            className={`aa-sidebar-footer__chevron${menuOpen ? ' open' : ''}`}
            size={13}
            aria-hidden="true"
          />
        </button>

        {menuOpen && (
          <div className="aa-sidebar-footer-menu__popover" role="menu" aria-label="设置与外观">
            <div className="aa-sidebar-footer-menu__heading">主题</div>
            {APPEARANCE_OPTIONS.map((option) => {
              const Icon = option.icon
              const active = activeColorId === option.id && getInitialTheme().styleId === 'default'
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  className={`aa-sidebar-footer-menu__option${active ? ' active' : ''}`}
                  onClick={() => selectAppearance(option.id)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span className="aa-sidebar-footer-menu__copy">{option.label}</span>
                  {active && <Check size={14} aria-hidden="true" />}
                </button>
              )
            })}

            <div role="separator" className="aa-sidebar-footer-menu__separator" />

            <button
              type="button"
              role="menuitem"
              onClick={openSettings}
              className="aa-sidebar-footer-menu__item"
            >
              <Settings size={14} aria-hidden="true" />
              <span>打开设置</span>
            </button>
          </div>
        )}
      </div>
    </footer>
  )
}

function isAppearanceColor(value: ThemeColorId): value is AppearanceColorId {
  return value === 'system' || value === 'light' || value === 'dark'
}
