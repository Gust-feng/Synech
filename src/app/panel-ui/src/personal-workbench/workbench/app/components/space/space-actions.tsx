import { Brain } from 'lucide-react'
import { useBrain } from '../brainStore'
import type { SpaceItem } from '../useMountedTree'

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
