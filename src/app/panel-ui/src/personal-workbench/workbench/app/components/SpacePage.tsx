import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { type View } from './Sidebar'
import type {
  PersonalSpaceActions,
  PersonalSpaceProjection,
} from '../../../space'
import type { ReferencePreviewHandle } from './ReferencePreview'
import { createSpaceReferenceEntry, fetchDocumentPreview } from './referencePreviewClient'
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
import {
  ActionConfirmationDialog,
  type ActionConfirmationRequest,
} from './ActionConfirmationDialog'
import { prefetchReferencePreview, SpaceContent } from './space/space-content'
import {
  countSpaceItems,
  firstSelectableSpaceTreeItemId,
  SpaceExplorer,
} from './space/space-tree'

/** Space 组合资料树、笔记与所属对话；外部 Workspace 始终作为只读引用。 */

interface SpacePageProps {
  onNavigate: (v: View) => void
  space?: PersonalSpaceProjection
  actions?: PersonalSpaceActions
  onOpenItem?: (spaceId: string, itemId: string) => void | Promise<void>
  onOpenConversation?: (conversationId: string) => boolean | Promise<boolean>
  /** 当前正式对话的右侧工作台内容，由 Synech 组合根提供。 */
  conversationContent?: ReactNode
  /** 从空间右侧对话进入已有的全屏专注模式。 */
  onEnterFocus?: () => void
  activeConversationId?: string
  /** 宿主当前活动会话的固定 Owner；用于在右侧展示本空间的会话。 */
  activeConversationOwner?: { readonly kind: "space" | "workspace"; readonly id: string } | undefined
  /** 宿主当前活动会话标题；空间 read-model 尚未刷新时作为面板头回退。 */
  activeConversationTitle?: string | undefined
  /** Host request for presenting a Conversation in this Space context. */
  conversationSurfaceRequest?: { readonly conversationId: string; readonly spaceId: string } | null
  onRenameConversation?: (conversationId: string, title: string) => void | Promise<void>
  onToggleConversationPinned?: (conversationId: string, pinned: boolean) => void | Promise<void>
  onDeleteConversation?: (conversationId: string) => void | Promise<void>
  /** 从搜索等入口跳转时,要求空间预先选中并打开的对象 id。 */
  targetId?: string | null
}

interface SpaceViewMemory {
  selectedId: string | null
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
  onOpenConversation,
  conversationContent,
  onEnterFocus,
  activeConversationId,
  activeConversationOwner,
  activeConversationTitle,
  conversationSurfaceRequest,
  onRenameConversation,
  onToggleConversationPinned,
  onDeleteConversation,
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
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null)
  const [openConversationId, setOpenConversationId] = useState<string | null>(() => (
    activeConversationId !== undefined
      && space?.conversations?.some((conversation) => conversation.conversationId === activeConversationId)
      ? activeConversationId
      : null
  ))
  // Host 加载下一条会话期间继续显示当前会话，避免右栏短暂回落到资料页。
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null)
  const conversationSwitchRequestRef = useRef(0)
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
  const rememberedSelectionId = rememberedView?.selectedId
  const rememberedItem = rememberedSelectionId === undefined || rememberedSelectionId === null
    ? undefined
    : getItem(projectedTree, rememberedSelectionId)
  const rememberedSelectedId = rememberedSelectionId !== undefined
    && (notes.some((note) => note.id === rememberedSelectionId)
      || rememberedItem !== undefined && rememberedItem.type !== 'folder')
    ? rememberedSelectionId
    : undefined
  const [selectedId, setSelectedId] = useState<string | null>(() => (
    targetId ?? rememberedSelectedId ?? null
  ))
  const selectedStillExists = selectedId !== null
    && (notes.some((note) => note.id === selectedId) || getItem(tree, selectedId) !== undefined)
  const previousMemoryKeyRef = useRef(memoryKey)

  // 显式资料选择优先于会话；切换空间时再交还给宿主活动会话。
  const explicitItemSelectionRef = useRef(false)
  useLayoutEffect(() => {
    if (previousMemoryKeyRef.current === memoryKey) return
    previousMemoryKeyRef.current = memoryKey
    explicitItemSelectionRef.current = false
    dragOrderRef.current = null
    conversationSwitchRequestRef.current += 1
    referenceCreationRequestRef.current += 1
    setDragOrder(null)
    setCreatingNoteId(null)
    setActionError(null)
    setRenamingConversationId(null)
    setPendingConversationId(null)
    setOpenConversationId(
      activeConversationId !== undefined && space?.conversations?.some((conversation) => conversation.conversationId === activeConversationId)
        ? activeConversationId
        : null,
    )
    setCreatingFolder(false)
    setCreatingReferenceFile(null)
    setPendingSpaceConfirmation(null)
    setSelectedId(targetId ?? rememberedSelectedId ?? null)
  }, [activeConversationId, memoryKey, notes, projectedTree, rememberedSelectedId, space?.conversations, targetId])

  function selectItem(id: string) {
    explicitItemSelectionRef.current = true
    setActionError(null)
    conversationSwitchRequestRef.current += 1
    setPendingConversationId(null)
    setOpenConversationId(null)
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
      selectItem(id)
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
      selectedId,
      expandedIds,
      scrollTop: current?.scrollTop ?? 0,
    })
  }, [expandedIds, memoryKey, selectedId])
  useEffect(() => {
    if (targetId !== null && targetId !== undefined) return
    if (openConversationId !== null || pendingConversationId !== null) return
    if (selectedId === null) return
    if (selectedStillExists) return
    const nextId = notes[0]?.id ?? firstSelectableSpaceTreeItemId(tree)
    setSelectedId(nextId)
  }, [openConversationId, pendingConversationId, selectedId, selectedStillExists, targetId, notes, tree])
  useLayoutEffect(() => {
    const explorer = explorerRef.current
    if (explorer !== null) explorer.scrollTop = spaceViewMemory.get(memoryKey)?.scrollTop ?? 0
  }, [memoryKey])

  useEffect(() => {
    if (targetId) {
      conversationSwitchRequestRef.current += 1
      setPendingConversationId(null)
      setOpenConversationId(null)
      setSelectedId(targetId)
    }
  }, [targetId])

  // Host 确认活动会话后再提交本地选择，等待期间保持原会话表面。
  useEffect(() => {
    if (pendingConversationId === null || activeConversationId !== pendingConversationId) return
    setOpenConversationId(pendingConversationId)
    setPendingConversationId(null)
  }, [activeConversationId, pendingConversationId])

  useEffect(() => {
    if (openConversationId === null) return
    if (space?.conversations?.some((conversation) => conversation.conversationId === openConversationId) === true) return
    setOpenConversationId(null)
  }, [openConversationId, space?.conversations])

  const selectedNote = notes.find((n) => n.id === selectedId)
  const selectedItem = selectedId ? getItem(tree, selectedId) : null
  const selectedReferenceRoot = selectedItem?.referenceId === undefined ? undefined : getItem(tree, selectedItem.referenceId)
  const itemCount = notes.length + (space?.itemCount ?? countSpaceItems(projectedTree))
  // 本地打开、等待 Host 确认，或 Host 明确归属本空间时展示会话；显式资料选择优先。
  const conversationSurfaceVisible = conversationContent !== undefined && (
    (openConversationId !== null && openConversationId === activeConversationId)
    || (pendingConversationId !== null && (
      openConversationId !== null || activeConversationId === pendingConversationId
    ))
    || (activeConversationId !== undefined
      && !explicitItemSelectionRef.current
      && (
        (activeConversationOwner?.kind === "space" && activeConversationOwner.id === spaceId)
        || (conversationSurfaceRequest !== null && conversationSurfaceRequest !== undefined
          && conversationSurfaceRequest.conversationId === activeConversationId
          && conversationSurfaceRequest.spaceId === spaceId)
      ))
  )
  const visibleConversationId = openConversationId ?? activeConversationId
  const visibleConversationTitle = space?.conversations?.find(
    (conversation) => conversation.conversationId === visibleConversationId,
  )?.title ?? (visibleConversationId === activeConversationId ? activeConversationTitle : undefined) ?? '对话'

  function handleCreateNote() {
    explicitItemSelectionRef.current = true
    if (notes.length === 0) {
      const note = create({ spaceId, title: '写下第一篇笔记' })
      setSelectedId(note.id)
      return
    }

    const note = create({ spaceId })
    openNameDraft(note.id)
  }

  function openNameDraft(id: string) {
    explicitItemSelectionRef.current = true
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
    const rename = actions?.rename
    if (item.externalChild || rename === undefined) return
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
    if (item.externalChild) return
    if (item.domainKind === 'local_file' || item.domainKind === 'workspace_folder' || item.domainKind === 'web_reference' || item.domainKind === 'generated_artifact') return
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

  async function handleOpenReference(item: SpaceItem) {
    if (space !== undefined && onOpenItem !== undefined) {
      await onOpenItem(space.spaceId, item.id)
      return
    }
    if (item.openUrl !== undefined) window.open(item.openUrl, '_blank', 'noopener,noreferrer')
  }

  async function openConversation(conversationId: string) {
    if (onOpenConversation === undefined) return
    setActionError(null)
    const requestId = conversationSwitchRequestRef.current + 1
    conversationSwitchRequestRef.current = requestId
    setPendingConversationId(conversationId)
    try {
      const opened = await onOpenConversation(conversationId)
      if (conversationSwitchRequestRef.current !== requestId) return
      if (opened === false) {
        setPendingConversationId(null)
        return
      }
      setOpenConversationId(conversationId)
      setPendingConversationId(null)
    } catch (error) {
      if (conversationSwitchRequestRef.current !== requestId) return
      setPendingConversationId(null)
      setActionError(actionErrorMessage(error))
    }
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
      <section className="personal-space-surface flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        <SpaceExplorer
          space={space}
          itemCount={itemCount}
          actionError={actionError}
          explorerRef={explorerRef}
          onSearch={() => onNavigate('search')}
          onScroll={(scrollTop) => {
            const current = spaceViewMemory.get(memoryKey)
            spaceViewMemory.set(memoryKey, {
              selectedId: current?.selectedId ?? selectedId,
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
          conversations={{
            items: space?.conversations ?? [],
            selectedId: pendingConversationId ?? openConversationId,
            renamingId: renamingConversationId,
            onOpen: (conversationId) => { void openConversation(conversationId) },
            onStartRename: setRenamingConversationId,
            onRename: (conversationId, title) => {
              void onRenameConversation?.(conversationId, title)
              setRenamingConversationId(null)
            },
            onCancelRename: () => setRenamingConversationId(null),
            onTogglePinned: (conversationId, pinned) => {
              void onToggleConversationPinned?.(conversationId, pinned)
            },
            onDelete: (conversationId) => { void onDeleteConversation?.(conversationId) },
          }}
        />

        <SpaceContent
          conversationVisible={conversationSurfaceVisible}
          conversationTitle={visibleConversationTitle}
          conversationContent={conversationContent}
          onEnterFocus={onEnterFocus}
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
