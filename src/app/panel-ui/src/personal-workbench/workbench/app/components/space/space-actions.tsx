import { useEffect, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import { useBrain } from '../brainStore'
import type { SpaceItem } from '../useMountedTree'

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

export function canCollectSpaceReference(item: SpaceItem): boolean {
  return item.domainKind === 'local_file'
    || item.domainKind === 'workspace'
    || item.domainKind === 'managed_folder'
}

/** 将空间中的本地引用复制为知识库中的托管副本。 */
export function CollectSpaceReferenceButton({
  brain,
  sourceReferenceId,
  sourceRelativePath = '',
}: {
  brain: ReturnType<typeof useBrain>
  sourceReferenceId: string
  sourceRelativePath?: string
}) {
  const sourcePage = brain.findCollectedSpaceReference(sourceReferenceId, sourceRelativePath)
  const collected = sourcePage !== undefined
  const pendingKey = brain.spaceReferenceSourceKey(sourceReferenceId, sourceRelativePath)
  const pending = brain.isPending(pendingKey)

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (sourcePage !== undefined) brain.uncollect(sourcePage.refId, pendingKey)
        else brain.collectSpaceReference(sourceReferenceId, sourceRelativePath)
      }}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--ui-hover-tint)]"
      style={{ color: collected ? 'var(--ui-accent, #6865a7)' : 'var(--ui-text-2, #87827c)' }}
    >
      <Brain size={12} />
      {pending ? (collected ? '正在取消…' : '正在收藏…') : collected ? '已收藏' : '收藏'}
    </button>
  )
}
