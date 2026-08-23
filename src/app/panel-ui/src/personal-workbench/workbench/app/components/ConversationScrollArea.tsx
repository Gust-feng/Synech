import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'

const BOTTOM_THRESHOLD_PX = 48
/** 每帧向目标收敛的比例：约 110ms 内平滑到达底部，不随内容增长累积滞后。 */
const SMOOTH_FOLLOW_EASING = 0.28

export function ConversationScrollArea(props: {
  readonly scrollKey: string
  readonly contentClassName: string
  readonly children?: ReactNode
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  /** 程序性平滑滚动进行中：期间忽略 scroll 事件，避免跟随被打断或按钮闪烁。 */
  const smoothingRef = useRef(false)
  const frameRef = useRef<number | undefined>(undefined)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)

  const measurePosition = useCallback(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const distanceFromBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
    const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD_PX
    followLatestRef.current = atBottom
    setShowJumpToLatest(!atBottom)
  }, [])

  const stopSmoothing = useCallback(() => {
    if (frameRef.current !== undefined) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = undefined
    }
    smoothingRef.current = false
  }, [])

  const smoothScrollToLatest = useCallback(() => {
    const viewport = viewportRef.current
    if (viewport === null || frameRef.current !== undefined) return
    smoothingRef.current = true
    let running = true
    const finish = (): void => {
      running = false
      smoothingRef.current = false
      frameRef.current = undefined
      setShowJumpToLatest(false)
    }
    const tick = (): void => {
      if (!running) return
      if (viewport.scrollHeight <= viewport.clientHeight) {
        viewport.scrollTop = 0
        finish()
        return
      }
      const target = viewport.scrollHeight - viewport.clientHeight
      const diff = target - viewport.scrollTop
      if (Math.abs(diff) <= 1) {
        viewport.scrollTop = target
        finish()
        return
      }
      viewport.scrollTop += diff * SMOOTH_FOLLOW_EASING
      // 同步帧环境（测试 stub）下，requestAnimationFrame 会立即递归执行 tick；
      // 若收敛后的 finish 已复位 frameRef，外层赋值必须让位，否则会残留过期句柄。
      const nextHandle = requestAnimationFrame(tick)
      if (running) frameRef.current = nextHandle
    }
    tick()
  }, [])

  const jumpToLatest = useCallback(() => {
    followLatestRef.current = true
    smoothScrollToLatest()
  }, [smoothScrollToLatest])

  useLayoutEffect(() => {
    followLatestRef.current = true
    setShowJumpToLatest(false)
    const frame = requestAnimationFrame(jumpToLatest)
    return () => cancelAnimationFrame(frame)
  }, [jumpToLatest, props.scrollKey])

  useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (viewport === null || content === null) return

    const handleResize = () => {
      if (followLatestRef.current) {
        smoothScrollToLatest()
        return
      }
      measurePosition()
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(handleResize)
    observer?.observe(content)
    observer?.observe(viewport)

    const handleScroll = () => {
      if (smoothingRef.current) return
      measurePosition()
    }
    const handleWheel = () => {
      // 用户主动滚动：立即交还控制权，停止平滑跟随并测量真实位置。
      stopSmoothing()
      measurePosition()
    }
    viewport.addEventListener('scroll', handleScroll, { passive: true })
    viewport.addEventListener('wheel', handleWheel, { passive: true })

    return () => {
      observer?.disconnect()
      viewport.removeEventListener('scroll', handleScroll)
      viewport.removeEventListener('wheel', handleWheel)
      stopSmoothing()
    }
  }, [measurePosition, smoothScrollToLatest, stopSmoothing])

  return (
    <div className="aa-conversation-scroll-shell relative min-h-0 flex-1">
      <div
        ref={viewportRef}
        className="aa-conversation-scroll-viewport h-full overflow-y-auto"
        data-conversation-scroll="viewport"
      >
        <div
          ref={contentRef}
          className={`aa-conversation-scroll-content ${props.contentClassName}`}
          style={{ maxWidth: 'var(--reading-width)' }}
        >
          {props.children}
        </div>
      </div>
      {showJumpToLatest && (
        <button
          type="button"
          className="aa-conversation-jump-to-latest"
          onClick={jumpToLatest}
          aria-label="跳到最新回答"
        >
          <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}