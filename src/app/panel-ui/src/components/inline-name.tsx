import { useEffect, useRef, useState } from 'react'

/** 行内名称编辑：回车或失焦提交，Escape 取消。 */
export function InlineName({
  value,
  label,
  onCommit,
  onCancel,
}: {
  value: string
  label: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const settledRef = useRef(false)
  const blurTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.focus()
    const length = element.value.length
    element.setSelectionRange(length, length)
  }, [])

  useEffect(() => () => {
    if (blurTimerRef.current !== undefined) window.clearTimeout(blurTimerRef.current)
  }, [])

  function cancel() {
    if (settledRef.current) return
    settledRef.current = true
    onCancel()
  }

  function commit() {
    if (settledRef.current) return
    settledRef.current = true
    const title = draft.trim()
    if (title) onCommit(title)
    else onCancel()
  }

  function scheduleBlurCommit() {
    if (blurTimerRef.current !== undefined) window.clearTimeout(blurTimerRef.current)
    blurTimerRef.current = window.setTimeout(() => {
      blurTimerRef.current = undefined
      if (document.activeElement !== ref.current) commit()
    }, 0)
  }

  return (
    <input
      ref={ref}
      aria-label={label}
      spellCheck={false}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onFocus={() => {
        if (blurTimerRef.current !== undefined) window.clearTimeout(blurTimerRef.current)
        blurTimerRef.current = undefined
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        }
      }}
      onBlur={scheduleBlurCommit}
      className="flex-1 min-w-0 text-sm bg-transparent outline-none"
      style={{
        height: 20,
        lineHeight: '19px',
        boxSizing: 'border-box',
        color: 'var(--ui-text-1, #292722)',
        borderBottom: '1px solid var(--ui-border, rgba(45,40,34,0.25))',
        padding: 0,
      }}
    />
  )
}
