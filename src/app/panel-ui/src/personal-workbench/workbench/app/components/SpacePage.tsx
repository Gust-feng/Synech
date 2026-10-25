import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import type { WorkbenchView as View } from '../../../../workbench/navigation-state'
import type {
  PersonalSpaceActions,
  PersonalSpaceProjection,
} from '../../../space'
import type { ReferencePreviewHandle } from './ReferencePreview'
import {
  createSpaceReferenceEntry,
  deleteSpaceReferenceEntry,
  fetchDocumentPreview,
  renameSpaceReferenceEntry,
} from './referencePreviewClient'
import {
  useMountedTree,
  getItem,
  referenceChildId,
  isFileSystemFolderKind,
  actionErrorMessage,
  isReferenceRemovedError,
  type SpaceItem,
} from './useMountedTree'
import { useNotes } from './notesStore'
import { WorkbenchExplorer } from './WorkbenchExplorer'
import {
  ActionConfirmationDialog,
  type ActionConfirmationRequest,
} from './ActionConfirmationDialog'
import { prefetchReferencePreview, SpaceContent } from './space/space-content'
import {
  countSpaceItems,
  SpaceExplorer,
} from './space/space-tree'

/** Space owns the resource explorer and reader; Collaboration owns conversation navigation. */

interface SpacePageProps {
  onNavigate: (v: View) => void
  space?: PersonalSpaceProjection
  actions?: PersonalSpaceActions
  onOpenItem?: (spaceId: string, itemId: string) => void | Promise<void>
  explorerCollapsed: boolean
  onActivateReading: () => void
  onOpenPreview: () => void
  /** 从搜索等入口跳转时,要求空间预先选中并打开的对象 id。 */
  targetId?: string | null
}

interface SpaceViewMemory {
  expandedIds: ReadonlySet<string>
  scrollTop: number
}

type PendingSpaceConfirmation = {
  readonly request: ActionConfirmationRequest
  readonly action: () => void | Promise<void>
}

const spaceViewMemory = new Map<string, SpaceViewMemory>()

export function SpacePage({
  onNavigate,
  targetId,
  space,
  actions,
  onOpenItem,
  explorerCollapsed,
  onActivateReading,
  onOpenPreview,
}: SpacePageProps) {
  const noteStore = useNotes()
  const spaceId = space?.spaceId
  const notes = useMemo(
    () => spaceId === undefined ? noteStore.notes : noteStore.notes.filter((note) => note.spaceId === spaceId),
    [noteStore.notes, spaceId],
  )
  const { create, update, remove, reorder } = noteStore

  // 拖动期间才保留临时顺序，落下后立即写回笔记 Store。
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const dragOrderRef = useRef<string[] | null>(null)
  const orderedNotes = useMemo(() => {
    const notesById = new Map(notes.map((note) => [note.id, note]))
    const orderedNoteIds = dragOrder ?? notes.map((note) => note.id)
    return orderedNoteIds.flatMap((id) => notesById.get(id) ?? [])
  }, [dragOrder, notes])
  const moveNote = (from: number, to: number) => {
    const previous = dragOrderRef.current ?? notes.map((note) => note.id)
    const next = [...previous]
    const [moved] = next.splice(from, 1)
    if (moved === undefined) return
    next.splice(to, 0, moved)
    dragOrderRef.current = next
    setDragOrder(next)
  }
  const commitOrder = () => {
    const next = dragOrderRef.current
    if (next === null) return
    reorder(next)
    dragOrderRef.current = null
    setDragOrder(null)
  }

  const [creatingNoteId, setCreatingNoteId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [creatingReferenceFile, setCreatingReferenceFile] = useState<{ referenceId: string; parentId: string; parentPath: string } | null>(null)
  const referenceCreationRequestRef = useRef(0)
  const [pendingSpaceConfirmation, setPendingSpaceConfirmation] = useState<PendingSpaceConfirmation | null>(null)
  const explorerRef = useRef<HTMLDivElement>(null)
  const referencePreviewRef = useRef<ReferencePreviewHandle>(null)
  const memoryKey = spaceId ?? 'prototype-space'
  const rememberedView = spaceViewMemory.get(memoryKey)
  const mountedTree = useMountedTree({
    spaceId: memoryKey,
    space,
    initialExpandedIds: rememberedView?.expandedIds,
    onError: setActionError,
  })
  const { tree, projectedTree, expandedIds } = mountedTree
  // Space entry shows the landing scene unless navigation names a specific item.
  const [selectedId, setSelectedId] = useState<string | null>(targetId ?? null)
  const selectedStillExists = selectedId !== null
    && (notes.some((note) => note.id === selectedId) || getItem(tree, selectedId) !== undefined)

  function selectItem(id: string) {
    onOpenPreview()
    setActionError(null)
    setSelectedId(id)
  }

  function prefetchTreeItem(item: SpaceItem) {
    if (item.type === 'folder') {
      void mountedTree.loadDirectory(item)
      return
    }
    const referenceId = item.referenceId ?? item.id
    const relativePath = item.relativePath ?? ''
    void prefetchReferencePreview(referenceId, relativePath).catch(() => undefined)
  }

  function selectTreeItem(id: string) {
    const item = getItem(tree, id)
    if (item === undefined || item.type === 'folder') {
      setSelectedId(id)
      return
    }
    const referenceId = item.referenceId ?? item.id
    const relativePath = item.relativePath ?? ''
    void prefetchReferencePreview(referenceId, relativePath).catch((error: unknown) => {
      // 引用刚被移除、投影尚未刷新时的点击不算失败：节点马上会消失。
      if (!isReferenceRemovedError(error)) setActionError(actionErrorMessage(error))
    })
    selectItem(id)
  }

  function toggleExpanded(id: string) {
    // 展开 / 加载 / 缓存收口到 useMountedTree；这里只把 id 解析成条目后委派。
    const item = getItem(tree, id)
    if (item !== undefined) mountedTree.toggleExpand(item)
  }

  useEffect(() => {
    const current = spaceViewMemory.get(memoryKey)
    spaceViewMemory.set(memoryKey, {
      expandedIds,
      scrollTop: current?.scrollTop ?? 0,
    })
  }, [expandedIds, memoryKey])
  useEffect(() => {
    if (targetId !== null && targetId !== undefined) return
    if (selectedId === null) return
    if (selectedStillExists) return
    setSelectedId(null)
  }, [selectedId, selectedStillExists, targetId])
  useLayoutEffect(() => {
    const explorer = explorerRef.current
    if (explorer !== null) explorer.scrollTop = spaceViewMemory.get(memoryKey)?.scrollTop ?? 0
  }, [memoryKey])

  useEffect(() => {
    if (targetId) {
      setSelectedId(targetId)
    }
  }, [targetId])

  const selectedNote = notes.find((n) => n.id === selectedId)
  const selectedItem = selectedId ? getItem(tree, selectedId) : null
  const selectedReferenceRoot = selectedItem?.referenceId === undefined ? undefined : getItem(tree, selectedItem.referenceId)
  const itemCount = notes.length + (space?.itemCount ?? countSpaceItems(projectedTree))
  function handleCreateNote() {
    onOpenPreview()
    if (notes.length === 0) {
      const note = create({ spaceId, title: '写下第一篇笔记' })
      setSelectedId(note.id)
      return
    }

    const note = create({ spaceId })
    openNameDraft(note.id)
  }

  function openNameDraft(id: string) {
    setSelectedId(id)
    setCreatingNoteId(id)
  }

  function finishCreatedNote(id: string, title: string) {
    update(id, { title })
    setCreatingNoteId((current) => current === id ? null : current)
  }

  function handleDeleteNote(id: string) {
    remove(id)
    if (dragOrderRef.current !== null) {
      const next = dragOrderRef.current.filter((noteId) => noteId !== id)
      dragOrderRef.current = next
      setDragOrder(next)
    }
    setSelectedId((prev) => (prev === id ? null : prev))
  }

  function handleRenameItem(item: SpaceItem, name: string) {
    if (item.externalChild) {
      const referenceId = item.referenceId
      const relativePath = item.relativePath
      if (referenceId === undefined || relativePath === undefined) return
      void runSpaceAction(async () => {
        const renamedRelativePath = await renameSpaceReferenceEntry(referenceId, relativePath, name)
        mountedTree.discardReferenceSubtree(referenceId, relativePath)
        await mountedTree.refreshParentOf(referenceId, renamedRelativePath)
        setSelectedId((current) => remapReferenceSubtreeSelection(
          current,
          referenceId,
          relativePath,
          renamedRelativePath,
        ))
      })
      return
    }
    const rename = actions?.rename
    if (rename === undefined) return
    void runSpaceAction(() => rename({ kind: 'reference', id: item.id }, name))
  }
  function requestSpaceConfirmation(request: ActionConfirmationRequest, action: () => void | Promise<void>): void {
    setPendingSpaceConfirmation({ request, action })
  }

  function confirmPendingSpaceAction(): void {
    const pending = pendingSpaceConfirmation
    if (pending === null) return
    setPendingSpaceConfirmation(null)
    void runSpaceAction(pending.action)
  }

  function handleDeleteItem(item: SpaceItem) {
    if (item.externalChild) {
      const referenceId = item.referenceId
      const relativePath = item.relativePath
      if (referenceId === undefined || relativePath === undefined) return
      const deletesFolder = item.type === 'folder'
      requestSpaceConfirmation({
        eyebrow: '已挂载资料',
        title: deletesFolder
          ? `删除“${item.name}”及其中的所有内容`
          : `删除“${item.name}”`,
        description: deletesFolder
          ? '这会从磁盘递归删除该文件夹及其中的所有内容。'
          : '这会从磁盘物理删除该文件。',
        consequence: '此操作不可撤销。',
        confirmLabel: deletesFolder ? '删除文件夹' : '删除文件',
      }, async () => {
        await deleteSpaceReferenceEntry(referenceId, relativePath)
        mountedTree.discardReferenceSubtree(referenceId, relativePath)
        await mountedTree.refreshParentOf(referenceId, relativePath)
        setSelectedId((current) => isReferenceSubtreeSelection(current, referenceId, relativePath) ? null : current)
      })
      return
    }
    if (item.domainKind === 'local_file' || item.domainKind === 'workspace' || item.domainKind === 'web_reference' || item.domainKind === 'generated_artifact') return
    if (item.domainKind === 'managed_folder') {
      const removeReference = actions?.removeReference
      if (removeReference === undefined) return
      requestSpaceConfirmation({
        eyebrow: '软件存储',
        title: `删除“${item.name}”及其中的所有文件`,
        description: '这会从软件存储中物理删除整个文件夹。',
        consequence: '此操作不可撤销。',
        confirmLabel: '删除文件夹',
      }, async () => {
        await removeReference(item.id)
        setSelectedId((prev) => (prev === item.id ? null : prev))
      })
      return
    }
    const removeReference = actions?.removeReference
    if (removeReference === undefined) return
    const deletesOwnedSubtree = item.domainKind === 'folder'
    requestSpaceConfirmation({
      eyebrow: deletesOwnedSubtree ? '空间资料' : '空间链接',
      title: deletesOwnedSubtree
          ? `删除“${item.name}”及其所有子项`
          : `取消“${item.name}”与当前空间的链接`,
      description: deletesOwnedSubtree
          ? '其中本地文件和软件自建文件夹会从磁盘删除，其他内容仅取消链接。'
          : '空间将不再引用此内容。',
      consequence: deletesOwnedSubtree
        ? '请确认你了解这项操作对空间内容的影响。'
        : '磁盘内容不会被删除。',
      confirmLabel: deletesOwnedSubtree
          ? '删除文件夹'
          : '取消链接',
      destructive: deletesOwnedSubtree ? undefined : false,
    }, async () => {
      await removeReference(item.id)
      setSelectedId((prev) => (prev === item.id ? null : prev))
    })
  }

  function handleUnlinkItem(item: SpaceItem) {
    if (actions?.unlinkReference === undefined) return
    void runSpaceAction(async () => {
      await actions.unlinkReference!(item.id)
      setSelectedId((current) => current === item.id ? null : current)
    })
  }

  function handleReconnectWorkspace(item: SpaceItem) {
    if (actions?.reconnectWorkspace === undefined) return
    void runSpaceAction(() => actions.reconnectWorkspace!(item.id))
  }

  async function handleOpenReference(item: SpaceItem) {
    if (space !== undefined && onOpenItem !== undefined) {
      await onOpenItem(space.spaceId, item.id)
      return
    }
    if (item.openUrl !== undefined) window.open(item.openUrl, '_blank', 'noopener,noreferrer')
  }

  async function runSpaceAction(operation: () => void | Promise<void>) {
    setActionError(null)
    try {
      await operation()
    } catch (error) {
      setActionError(actionErrorMessage(error))
    }
  }

  function handleCreateFolder(title: string) {
    setCreatingFolder(false)
    if (space === undefined || actions?.createManagedFolder === undefined) return
    void runSpaceAction(() => actions.createManagedFolder!(space.spaceId, title))
  }

  function beginCreateReferenceFile(targetItem?: SpaceItem) {
    const sourceReferenceId = targetItem?.referenceId
    const root = sourceReferenceId === undefined
      ? tree.find((item) => isFileSystemFolderKind(item.domainKind) && item.referenceId !== undefined)
      : getItem(tree, sourceReferenceId)
    if (root === undefined) return
    onActivateReading()
    let parent = root
    if (targetItem !== undefined && sourceReferenceId !== undefined) {
      if (targetItem.type === 'folder') parent = targetItem
      else if (targetItem.relativePath !== undefined) {
        const separator = targetItem.relativePath.lastIndexOf('/')
        const parentPath = separator < 0 ? '' : targetItem.relativePath.slice(0, separator)
        parent = parentPath.length === 0 ? root : getItem(tree, referenceChildId(sourceReferenceId, parentPath)) ?? root
      }
    }
    const referenceId = parent.referenceId ?? parent.id
    mountedTree.expandItem(parent)
    referenceCreationRequestRef.current += 1
    setCreatingReferenceFile({ referenceId, parentId: parent.id, parentPath: parent.relativePath ?? '' })
  }

  async function finishCreateReferenceFile(name: string) {
    const target = creatingReferenceFile
    if (target === null) return
    const requestId = ++referenceCreationRequestRef.current
    const selectedIdAtStart = selectedId
    setCreatingReferenceFile(null)
    setActionError(null)
    try {
      const relativePath = await createSpaceReferenceEntry(target.referenceId, target.parentPath, name)
      await mountedTree.refreshByReference(target.referenceId, target.parentPath)
      await fetchDocumentPreview(target.referenceId, relativePath)
      if (referenceCreationRequestRef.current !== requestId) return
      setSelectedId((current) => current === selectedIdAtStart
        ? referenceChildId(target.referenceId, relativePath)
        : current)
    } catch (error) {
      if (referenceCreationRequestRef.current !== requestId) return
      setActionError(actionErrorMessage(error))
    }
  }

  return (
    <DndProvider backend={HTML5Backend}>
      <section className="personal-space-surface relative flex min-w-0 flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        <WorkbenchExplorer collapsed={explorerCollapsed}>
        <SpaceExplorer
          space={space}
          itemCount={itemCount}
          actionError={actionError}
          explorerRef={explorerRef}
          onSearch={() => onNavigate('search')}
          onScroll={(scrollTop) => {
            const current = spaceViewMemory.get(memoryKey)
            spaceViewMemory.set(memoryKey, {
              expandedIds: current?.expandedIds ?? expandedIds,
              scrollTop,
            })
          }}
          notes={{
            notes: orderedNotes,
            selectedId,
            creatingNoteId,
            onCreate: handleCreateNote,
            onSelect: selectItem,
            onRename: (id, title) => update(id, { title }),
            onCreateCommit: finishCreatedNote,
            onCreateCancel: (id) => finishCreatedNote(id, '无标题'),
            onDelete: handleDeleteNote,
            onMove: moveNote,
            onDrop: commitOrder,
          }}
          references={{
            space,
            actions,
            tree,
            selectedId,
            creatingFolder,
            creatingEntry: creatingReferenceFile ?? undefined,
            expandedIds,
            onStartCreateFolder: () => setCreatingFolder(true),
            onCreateFolder: handleCreateFolder,
            onCancelCreateFolder: () => setCreatingFolder(false),
            onRunAction: (operation) => { void runSpaceAction(operation) },
            onSelect: selectTreeItem,
            onRename: (item, name) => { void handleRenameItem(item, name) },
            onUnlink: handleUnlinkItem,
            onReconnectWorkspace: handleReconnectWorkspace,
            onDelete: handleDeleteItem,
            onCreateEntry: beginCreateReferenceFile,
            onToggleExpand: toggleExpanded,
            onPrefetch: prefetchTreeItem,
            onCreateEntryCommit: (name) => { void finishCreateReferenceFile(name) },
            onCreateEntryCancel: () => {
              referenceCreationRequestRef.current += 1
              setCreatingReferenceFile(null)
            },
          }}
        />
        </WorkbenchExplorer>

        <SpaceContent
          selectedNote={selectedNote}
          onSaveNote={update}
          onCloseNote={() => setSelectedId(null)}
          onRestoreNote={(draft) => {
            const restored = create({ title: draft.title.trim() || '无标题', bodyMarkdown: draft.bodyMarkdown })
            setSelectedId(restored.id)
          }}
          selectedItem={selectedItem}
          selectedReferenceRoot={selectedReferenceRoot}
          referencePreviewRef={referencePreviewRef}
          onOpenReference={(item) => { void handleOpenReference(item) }}
        />
      </section>
      <ActionConfirmationDialog
        request={pendingSpaceConfirmation?.request}
        onCancel={() => setPendingSpaceConfirmation(null)}
        onConfirm={confirmPendingSpaceAction}
      />
    </DndProvider>
  )
}

function isReferenceSubtreeSelection(
  selectedId: string | null,
  referenceId: string,
  relativePath: string,
): boolean {
  if (selectedId === null) return false
  const entryId = referenceChildId(referenceId, relativePath)
  return selectedId === entryId || selectedId.startsWith(referenceChildId(referenceId, `${relativePath}/`))
}

function remapReferenceSubtreeSelection(
  selectedId: string | null,
  referenceId: string,
  previousRelativePath: string,
  nextRelativePath: string,
): string | null {
  if (selectedId === null) return null
  const previousEntryId = referenceChildId(referenceId, previousRelativePath)
  if (selectedId === previousEntryId) return referenceChildId(referenceId, nextRelativePath)
  const previousPrefix = referenceChildId(referenceId, `${previousRelativePath}/`)
  if (!selectedId.startsWith(previousPrefix)) return selectedId
  return `${referenceChildId(referenceId, `${nextRelativePath}/`)}${selectedId.slice(previousPrefix.length)}`
}
