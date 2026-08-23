import { useEffect, useRef, useState } from 'react'

export interface SidebarInlineRenameFieldProps {
  readonly value: string
  readonly onCommit: (value: string) => void
  readonly onCancel: () => void
  readonly selectAll?: boolean
}

/** Inline rename control shared by sidebar rows and the space manager. */
export function SidebarInlineRenameField({ value, onCommit, onCancel, selectAll }: SidebarInlineRenameFieldProps) {
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    if (selectAll) {
      input.select()
      return
    }
    const length = input.value.length
    input.setSelectionRange(length, length)
  }, [selectAll])

  function commit() {
    const trimmed = draft.trim()
    if (trimmed) onCommit(trimmed)
    else onCancel()
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') onCancel()
      }}
      onBlur={commit}
      spellCheck={false}
      className="flex-1 min-w-0 text-sm bg-transparent outline-none"
      style={{
        color: 'var(--aa-text-1)',
        borderBottom: '1px solid rgba(45,40,34,0.25)',
        paddingBottom: 1,
      }}
    />
  )
}
