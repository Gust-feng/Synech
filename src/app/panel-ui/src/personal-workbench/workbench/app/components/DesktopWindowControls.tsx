import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'

type DesktopWindowState = {
  readonly maximized: boolean
}

const DEFAULT_WINDOW_STATE: DesktopWindowState = {
  maximized: false,
}

export function DesktopWindowControls() {
  const desktop = typeof window === 'undefined' ? undefined : window.synechHost
  const [windowState, setWindowState] = useState<DesktopWindowState>(DEFAULT_WINDOW_STATE)

  useEffect(() => {
    if (desktop === undefined) return
    let mounted = true
    void desktop.getWindowState().then((nextState) => {
      if (mounted) setWindowState(nextState)
    }).catch(() => undefined)
    const unsubscribe = desktop.onWindowStateChanged(setWindowState)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [desktop])

  // 三个窗口控制 API 必须真实可用才渲染按钮；缺失时渲染会得到"看得见但点了没反应"的假按钮。
  if (
    desktop === undefined ||
    typeof desktop.minimizeWindow !== 'function' ||
    typeof desktop.toggleMaximizeWindow !== 'function' ||
    typeof desktop.closeWindow !== 'function'
  ) return null

  const maximizeLabel = windowState.maximized ? '还原窗口' : '最大化窗口'
  const MaximizeIcon = windowState.maximized ? Copy : Square

  return (
    <div className="topbar-window-controls" role="group" aria-label="窗口控制">
      <button
        type="button"
        className="topbar-window-control"
        aria-label="最小化窗口"
        onClick={() => desktop.minimizeWindow()}
      >
        <Minus size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="topbar-window-control"
        aria-label={maximizeLabel}
        aria-pressed={windowState.maximized}
        onClick={() => desktop.toggleMaximizeWindow()}
      >
        <MaximizeIcon size={11} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="topbar-window-control topbar-window-control-close"
        aria-label="关闭窗口"
        onClick={() => desktop.closeWindow()}
      >
        <X size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  )
}
