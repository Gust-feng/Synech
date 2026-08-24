import type { ReactNode, RefObject } from 'react'
import { NoteEditor } from '../NoteEditor'
import { ReferencePreview, type ReferencePreviewHandle } from '../ReferencePreview'
import { SurfaceErrorBoundary } from '../SurfaceErrorBoundary'
import { useBrain } from '../brainStore'
import type { Note } from '../notesStore'
import { prefetchDocumentSurface } from '../documentPreviewWarmup'
import { fetchDocumentPreview, getCachedReferencePreview } from '../referencePreviewClient'
import type { SpaceItem } from '../useMountedTree'
import { CollectSpaceReferenceButton, canCollectSpaceReference } from './space-actions'
import { SpaceConversationSurface } from './space-conversations'

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
  conversationVisible,
  conversationTitle,
  conversationContent,
  onEnterFocus,
  selectedNote,
  onSaveNote,
  onCloseNote,
  onRestoreNote,
  selectedItem,
  selectedReferenceRoot,
  referencePreviewRef,
  onOpenReference,
}: {
  conversationVisible: boolean
  conversationTitle: string
  conversationContent: ReactNode
  onEnterFocus?: () => void
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

  if (conversationVisible) {
    return (
      <SpaceConversationSurface
        title={conversationTitle}
        content={conversationContent}
        onEnterFocus={onEnterFocus}
      />
    )
  }

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
        <CenteredCard>
          <p className="text-xs leading-relaxed text-center" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
            从左侧选择一篇笔记或材料
            <br />
            即可在此书写或查看
          </p>
        </CenteredCard>
      )}
    </div>
  )
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">{children}</div>
  )
}
