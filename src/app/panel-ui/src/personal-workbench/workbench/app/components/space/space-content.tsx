import type { RefObject } from 'react'
import { NoteEditor } from '../NoteEditor'
import { SpaceLanding } from './space-landing'
import { ReferencePreview, type ReferencePreviewHandle } from '../ReferencePreview'
import { SurfaceErrorBoundary } from '../SurfaceErrorBoundary'
import { useBrain } from '../brainStore'
import type { Note } from '../notesStore'
import { prefetchDocumentSurface } from '../documentPreviewWarmup'
import { fetchDocumentPreview, getCachedReferencePreview } from '../referencePreviewClient'
import type { SpaceItem } from '../useMountedTree'
import { CollectSpaceReferenceButton, canCollectSpaceReference } from './space-actions'

export function prefetchReferencePreview(referenceId: string, relativePath: string): Promise<void> {
  const cached = getCachedReferencePreview(referenceId, relativePath)
  if (cached !== undefined) {
    prefetchDocumentSurface(cached)
    return Promise.resolve()
  }
  return fetchDocumentPreview(referenceId, relativePath).then((preview) => {
    prefetchDocumentSurface(preview)
  })
}

export function SpaceContent({
  selectedNote,
  onSaveNote,
  onCloseNote,
  onRestoreNote,
  selectedItem,
  selectedReferenceRoot,
  referencePreviewRef,
  onOpenReference,
}: {
  selectedNote: Note | undefined
  onSaveNote: (id: string, patch: { title?: string; bodyMarkdown?: string }) => void
  onCloseNote: () => void
  onRestoreNote: (draft: { title: string; bodyMarkdown: string }) => void
  selectedItem: SpaceItem | null | undefined
  selectedReferenceRoot: SpaceItem | undefined
  referencePreviewRef: RefObject<ReferencePreviewHandle | null>
  onOpenReference: (item: SpaceItem) => void
}) {
  const brain = useBrain()

  if (selectedNote !== undefined) {
    return (
      <SurfaceErrorBoundary resetKey={selectedNote.id} label="笔记编辑器暂时无法打开">
        <NoteEditor
          note={selectedNote}
          onSave={onSaveNote}
          onClose={onCloseNote}
          onRestoreAsNew={onRestoreNote}
        />
      </SurfaceErrorBoundary>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {selectedItem?.type !== 'folder' && selectedItem ? (
        <ReferencePreview
          ref={referencePreviewRef}
          itemId={selectedItem.referenceId ?? selectedItem.id}
          initialRelativePath={selectedItem.relativePath ?? ''}
          fallbackTitle={selectedReferenceRoot?.name ?? selectedItem.name}
          canOpen={selectedItem.openable === true || selectedItem.openUrl !== undefined}
          onOpen={() => onOpenReference(selectedItem)}
          actions={!canCollectSpaceReference(selectedItem)
            ? undefined
            : <CollectSpaceReferenceButton
                sourceReferenceId={selectedItem.referenceId ?? selectedItem.id}
                sourceRelativePath={selectedItem.relativePath ?? ''}
                brain={brain}
              />}
        />
      ) : (
        <SpaceLanding />
      )}
    </div>
  )
}
