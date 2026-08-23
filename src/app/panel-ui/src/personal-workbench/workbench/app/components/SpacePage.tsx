import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DndProvider, useDrag, useDrop } from 'react-dnd'
import { HTML5Backend, getEmptyImage } from 'react-dnd-html5-backend'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileText,
  FileImage,
  FileVideo,
  File,
  FilePlus,
  Globe,
  MessageSquare,
  Maximize2,
  Plus,
  Search,
  NotebookPen,
  Brain,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Unlink,
  GripVertical,
} from 'lucide-react'
import { type View } from './Sidebar'
import type {
  PersonalSpaceActions,
  PersonalSpaceConversationContext,
  PersonalSpaceProjection,
} from '../../../space'
import { ReferencePreview, type ReferencePreviewHandle } from './ReferencePreview'
import { NoteEditor } from './NoteEditor'
import { createSpaceReferenceEntry, deleteSpaceReferenceEntry, fetchDocumentPreview, getCachedReferencePreview, renameSpaceReferenceEntry } from './referencePreviewClient'
import { prefetchDocumentSurface } from './documentPreviewWarmup'
import { SurfaceErrorBoundary } from './SurfaceErrorBoundary'
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
import { useBrain } from './brainStore'
import {
  ActionConfirmationDialog,
  type ActionConfirmationRequest,
} from './ActionConfirmationDialog'
import { FloatingMenu } from '../../../../components/floating-menu'

/**
 * Space —— VS Code 式分栏:左侧资源管理器(软件资产 + 外部数据源),右侧书写/查看。
 * 外部 Workspace 只是只读权限引用；Space 自己维护的材料才允许编辑。
 */

/**
 * 空间里的软件资产和外部数据源。Conversation owner 由 Ordinary 保存，
 * 不作为 Space 树中的引用项。
 * (「我写的笔记」是另一类可写对象,来自 notesStore,不在这棵树里。)
 * 所有条目都来自 SpaceFeature 的真实投影；初始内容由后端首次启动初始化。
 */

function prefetchReferencePreview(referenceId: string, relativePath: string): Promise<void> {
  const cached = getCachedReferencePreview(referenceId, relativePath)
  if (cached !== undefined) {
    prefetchDocumentSurface(cached)
    return Promise.resolve()
  }
  return fetchDocumentPreview(referenceId, relativePath).then((preview) => {
    prefetchDocumentSurface(preview)
  })
}
function fileIcon(name: string, size: number) {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(extension)) {
    return <FileImage size={size} style={{ color: '#6f8778' }} />
  }
  if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(extension)) {
    return <FileVideo size={size} style={{ color: '#9a7fae' }} />
  }
  if (extension === 'pdf') {
    return <FileText size={size} style={{ color: '#c25b45' }} />
  }
  if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(extension)) {
    return <FileText size={size} style={{ color: 'var(--aa-text-2, #87827c)' }} />
  }
  return <File size={size} style={{ color: 'var(--aa-text-2, #87827c)' }} />
}

function itemIcon(item: SpaceItem, size = 13) {
  switch (item.type) {
    case 'folder':
      return <Folder size={size} style={{ color: 'var(--aa-accent, #6865a7)' }} />
    case 'file':
      return fileIcon(item.name, size)
    case 'web':
      return <Globe size={size} style={{ color: '#a8c4b4' }} />
  }
}

function TreeNode({
  item,
  depth,
  onSelect,
  selectedId,
  onRename,
  onUnlink,
  onDelete,
  onCreateEntry,
  renameEnabled,
  unlinkEnabled,
  removeEnabled,
  removeManagedFolderEnabled,
  isExpanded,
  onToggleExpand,
  onPrefetch,
  creatingEntry,
  onCreateEntryCommit,
  onCreateEntryCancel,
}: {
  item: SpaceItem
  depth: number
  onSelect: (id: string) => void
  selectedId: string | null
  onRename: (item: SpaceItem, name: string) => void
  onUnlink: (item: SpaceItem) => void
  onDelete: (item: SpaceItem) => void
  onCreateEntry: (item: SpaceItem) => void
  renameEnabled: boolean
  unlinkEnabled: boolean
  removeEnabled: boolean
  removeManagedFolderEnabled: boolean
  isExpanded: (id: string) => boolean
  onToggleExpand: (id: string) => void
  onPrefetch: (item: SpaceItem) => void
  creatingEntry?: { readonly parentId: string }
  onCreateEntryCommit: (name: string) => void
  onCreateEntryCancel: () => void
}) {
  const expanded = isExpanded(item.id)
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const selected = selectedId === item.id
  const isManagedFolder = !item.externalChild && item.domainKind === 'managed_folder'
  // 外部 Workspace 是只读数据源：不能在其目录内创建、重命名或删除文件。
  const canCreateExternalEntry = !item.externalChild
    && item.type === 'folder'
    && item.referenceId !== undefined
    && item.domainKind === 'managed_folder'
  const canRename = !item.externalChild
    && item.domainKind !== 'workspace_folder'
    && renameEnabled
  // 外部数据源只允许移除当前 Space 的引用；Conversation owner 不属于普通引用操作。
  const canUnlink = !item.externalChild
    && (item.domainKind === 'workspace_folder' || item.domainKind === 'local_file' || item.domainKind === 'web_reference' || item.domainKind === 'generated_artifact')
    && unlinkEnabled
  const canRemove = (isManagedFolder && removeManagedFolderEnabled
    || (!item.externalChild && item.domainKind === 'folder' && removeEnabled))
  const pl = 10 + depth * 14

  return (
    <div>
      <div
        className="group/row flex items-center gap-2 rounded-md cursor-pointer transition-colors"
        style={{
          height: 30,
          paddingLeft: pl,
          paddingRight: 8,
          background: selected
            ? 'var(--aa-surface-active, #e5e1db)'
            : hovered
            ? 'var(--aa-surface-hover, #eeebe6)'
            : 'transparent',
        }}
        onMouseEnter={() => {
          setHovered(true)
          onPrefetch(item)
        }}
        onMouseLeave={() => setHovered(false)}
        onClick={() => {
          if (editing) return
          if (item.type === 'folder') {
            onToggleExpand(item.id)
            return
          }
          onSelect(item.id)
        }}
      >
        {item.type === 'folder' ? (
          <span style={{ color: 'var(--aa-text-3, #aba39b)', width: 12, flexShrink: 0 }}>
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}

        {itemIcon(item)}

        {editing ? (
          <InlineName
            value={item.name}
            label={`重命名${item.name}`}
            onCommit={(t) => {
              onRename(item, t)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span
            className="flex-1 text-sm truncate"
            style={{ color: 'var(--aa-text-1, #292722)' }}
          >
            {item.name}
          </span>
        )}

        {!editing && (canCreateExternalEntry || canRename || canUnlink || canRemove) && (
          <FloatingMenu
            label={`${item.name}操作`}
            visible={hovered}
            actions={[
              ...(canCreateExternalEntry ? [{ label: '新建文件', icon: <FilePlus size={12} />, onClick: () => onCreateEntry(item) }] : []),
              ...(canRename ? [{ label: '重命名', icon: <Pencil size={12} />, onClick: () => setEditing(true) }] : []),
              ...(canUnlink ? [{ label: '移除引用', icon: <Unlink size={12} />, onClick: () => onUnlink(item) }] : []),
              ...(canRemove ? [{ label: deleteLabelFor(item), icon: <Trash2 size={12} />, danger: true, onClick: () => onDelete(item) }] : []),
            ]}
          />
        )}
        {editing && <span style={{ width: 20, flexShrink: 0 }} />}
      </div>

      {creatingEntry?.parentId === item.id && (
        <div className="flex items-center gap-2" style={{ height: 30, paddingLeft: 10 + (depth + 1) * 14, paddingRight: 8 }}>
          <span style={{ width: 12, flexShrink: 0 }} />
          <FileText size={13} style={{ color: 'var(--aa-text-2, #87827c)' }} />
          <InlineName value="" label="文件名称" onCommit={onCreateEntryCommit} onCancel={onCreateEntryCancel} />
          <span style={{ width: 20, flexShrink: 0 }} />
        </div>
      )}

      {item.type === 'folder' && expanded && item.children && (
        <div role="group">
          {item.children.map((child) => (
            <TreeNode
              key={child.id}
              item={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedId={selectedId}
              onRename={onRename}
              onUnlink={onUnlink}
              onDelete={onDelete}
              onCreateEntry={onCreateEntry}
              renameEnabled={renameEnabled}
              unlinkEnabled={unlinkEnabled}
              removeEnabled={removeEnabled}
              removeManagedFolderEnabled={removeManagedFolderEnabled}
              isExpanded={isExpanded}
              onToggleExpand={onToggleExpand}
              onPrefetch={onPrefetch}
              creatingEntry={creatingEntry}
              onCreateEntryCommit={onCreateEntryCommit}
              onCreateEntryCancel={onCreateEntryCancel}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function countItems(tree: SpaceItem[]): number {
  return tree.reduce((n, item) => n + 1 + (item.children ? countItems(item.children) : 0), 0)
}

function firstSelectableTreeItemId(items: readonly SpaceItem[]): string | null {
  return items.find((item) => item.type !== 'folder')?.id ?? null
}

function deleteLabelFor(item: SpaceItem): string {
  if (item.externalChild) return item.type === 'folder' ? '删除文件夹' : '删除'
  if (item.domainKind === 'folder' || item.domainKind === 'managed_folder') return '删除文件夹'
  return item.domainKind === 'local_file' ? '删除文件' : '删除'
}

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
  /** 宿主当前活动会话的固定 owner（ADR-0035）；用于「本空间自己的会话在右侧面板展示」。 */
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
  /** Old versions stored inferred default selections; do not restore them. */
  selectionMemoryVersion?: 1
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
  const brain = useBrain()

  // Store order is the normal render source. A separate order exists only
  // during a drag gesture; keeping a permanent duplicate made creation render
  // against two different snapshots and visibly moved the selection.
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

  // 书写为中心:默认打开最近编辑的笔记(有 targetId 则优先)。
  const [creatingNoteId, setCreatingNoteId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null)
  // 置顶会话优先，置顶组内部按置顶时间倒序；其余按最近更新倒序，与工作区列表一致。
  const orderedSpaceConversations = useMemo(
    () => [...(space?.conversations ?? [])].sort(compareSpaceConversations),
    [space],
  )
  const pinnedSpaceConversationCount = orderedSpaceConversations.reduce(
    (count, conversation) => count + (conversation.pinnedAt !== undefined ? 1 : 0),
    0,
  )
  const [openConversationId, setOpenConversationId] = useState<string | null>(() => (
    activeConversationId !== undefined
      && space?.conversations?.some((conversation) => conversation.conversationId === activeConversationId)
      ? activeConversationId
      : null
  ))
  // Keep the currently visible surface mounted while the host loads the next
  // conversation.  Clearing the open id first lets the note fallback render
  // for one or more frames (the host also loads historical runs in the
  // background), which is the visible "flash back to notes" during switching.
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
  const rememberedSelectedId = rememberedView?.selectionMemoryVersion === 1
    && rememberedSelectionId !== undefined
    && (notes.some((note) => note.id === rememberedSelectionId)
      || rememberedItem !== undefined && rememberedItem.type !== 'folder')
    ? rememberedSelectionId
    : undefined
  // 首次进入空间不推断用户选择；只有明确目标或已保存的选择才打开内容。
  const [selectedId, setSelectedId] = useState<string | null>(() => (
    targetId ?? rememberedSelectedId ?? null
  ))
  const selectedStillExists = selectedId !== null
    && (notes.some((note) => note.id === selectedId) || getItem(tree, selectedId) !== undefined)
  const previousMemoryKeyRef = useRef(memoryKey)

  // SpacePage stays mounted while the selected Space changes. Reset only the
  // 用户在本空间停留期间显式选择了笔记/材料 → 右侧面板让位给内容浏览；
  // 切换空间（memoryKey 变化）或重新进入空间（组件重挂载）时重置，
  // 宿主活动会话重新接管面板 —— 与「从空间行打开会话后会话优先」口径一致。
  const explicitItemSelectionRef = useRef(false)
  // space-bound transient UI before paint so the workbench does not flash an
  // empty page or rebuild the whole surface between two already-known Spaces.
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
      selectionMemoryVersion: 1,
      expandedIds,
      scrollTop: current?.scrollTop ?? 0,
    })
  }, [expandedIds, memoryKey, selectedId])
  useEffect(() => {
    if (targetId !== null && targetId !== undefined) return
    if (openConversationId !== null || pendingConversationId !== null) return
    // A null selection is an intentional empty state, not a missing item.
    if (selectedId === null) return
    if (selectedStillExists) return
    const nextId = notes[0]?.id ?? firstSelectableTreeItemId(tree)
    setSelectedId(nextId)
  }, [openConversationId, pendingConversationId, selectedId, selectedStillExists, targetId, notes, tree])
  useLayoutEffect(() => {
    const explorer = explorerRef.current
    if (explorer !== null) explorer.scrollTop = spaceViewMemory.get(memoryKey)?.scrollTop ?? 0
  }, [memoryKey])

  // 外部要求打开某个对象(搜索跳转)。
  useEffect(() => {
    if (targetId) {
      conversationSwitchRequestRef.current += 1
      setPendingConversationId(null)
      setOpenConversationId(null)
      setSelectedId(targetId)
    }
  }, [targetId])

  // The host updates activeConversationId as soon as the conversation
  // metadata is available, before historical run loading finishes. Commit
  // the local selection at that point so the right pane never falls through
  // to the note/item branch while the rest of the conversation hydrates.
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
  const itemCount = notes.length + (space?.itemCount ?? countItems(projectedTree))
  /**
   * Conditions for presenting the active Conversation in this Space context:
   * 1) 本空间行打开并提交的会话（openConversationId 匹配宿主活动会话）；
   * 2) 打开中的会话（pending 等待宿主确认）；
   * 3) 宿主活动会话为「本空间自己的会话」或「宿主显式请求在此空间承载的会话」
   *    （首页创建 / 侧栏与搜索打开 / 启动恢复），且用户未在本停留期间显式选择笔记/材料。
   * 分支 3 不要求会话已出现在空间 conversations 投影，避免 read-model 刷新竞态期间闪回内容页。
   */
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
    // The note is already inserted by the store before this selection update.
    // Normal rendering reads that same store order, so the selection never
    // renders against a stale list position.
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
    // 只在删的正是当前打开项时才清空右侧,避免误关别的。
    setSelectedId((prev) => (prev === id ? null : prev))
  }

  // Space feature owns mutations; this page only translates prototype intent.
  async function handleRenameItem(item: SpaceItem, name: string) {
    // Workspace descendants are a read-only view of an external source. Their
    // file mutations must go through the normal Agent file-tool contract, not
    // through Space item actions.
    if (item.externalChild) return
    if (item.externalChild && item.referenceId !== undefined && item.relativePath !== undefined) {
      setActionError(null)
      try {
        if (selectedId === item.id) await referencePreviewRef.current?.flush()
        const nextRelativePath = await renameSpaceReferenceEntry(item.referenceId, item.relativePath, name)
        await mountedTree.refreshParentOf(item.referenceId, item.relativePath)
        await fetchDocumentPreview(item.referenceId, nextRelativePath)
        setSelectedId((current) => current === item.id ? referenceChildId(item.referenceId!, nextRelativePath) : current)
      } catch (error) {
        setActionError(actionErrorMessage(error))
      }
      return
    }
    if (actions?.rename === undefined) return
    setActionError(null)
    try {
      await actions.rename({ kind: 'reference', id: item.id }, name)
    } catch (error) {
      setActionError(actionErrorMessage(error))
    }
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
    // Never expose a physical-delete path for files shown inside an external
    // Workspace reference. The row menu already hides this action; this guard
    // keeps stale UI events from bypassing the read-only projection.
    if (item.externalChild) return
    if (item.domainKind === 'local_file' || item.domainKind === 'workspace_folder' || item.domainKind === 'web_reference' || item.domainKind === 'generated_artifact') return
    if (item.externalChild && item.referenceId !== undefined && item.relativePath !== undefined) {
      const referenceId = item.referenceId
      const relativePath = item.relativePath
      requestSpaceConfirmation({
        eyebrow: item.type === 'folder' ? '文件夹操作' : '文件操作',
        title: `删除“${item.name}”`,
        description: `这会删除磁盘上的${item.type === 'folder' ? '文件夹及其内容' : '文件'}。`,
        consequence: '此操作不可撤销。',
        confirmLabel: item.type === 'folder' ? '删除文件夹' : '删除文件',
      }, async () => {
        if (selectedId === item.id) referencePreviewRef.current?.discard()
        await deleteSpaceReferenceEntry(referenceId, relativePath)
        await mountedTree.refreshParentOf(referenceId, relativePath)
        setSelectedId((current) => current === item.id ? null : current)
      })
      return
    }
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
  // 目录加载 / 缓存 / 展开已收口到 useMountedTree；这里只剩读写动作与对外导航。

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
      {/* 左侧资源管理器 */}
      <div
        className="shrink-0 flex flex-col"
        style={{ width: 288, borderRight: '1px solid var(--aa-border, rgba(45,40,34,0.09))' }}
      >
        {/* 空间头 */}
        <header className="px-4 pt-4 pb-3 shrink-0">
          <div className="flex items-center gap-2.5 mb-1">
            <span className="w-3 h-3 rounded-full shrink-0" style={{ background: space?.color ?? '#a8c4b4' }} />
            <h1 className="text-sm font-semibold m-0 flex-1" style={{ color: 'var(--aa-text-1, #292722)' }}>
              {space?.title ?? '空间'}
            </h1>
            <button
              onClick={() => onNavigate('search')}
              className="p-1 rounded transition-colors hover:bg-[var(--aa-hover-tint)]"
              style={{ color: 'var(--aa-text-3, #aba39b)' }}
            >
              <Search size={13} />
            </button>
          </div>
          <p className="text-xs m-0 pl-[22px]" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
            {itemCount} 个对象
          </p>
          {actionError && <p role="alert" className="text-xs mt-2 mb-0 pl-[22px]" style={{ color: 'var(--aa-status-error, #b3543f)' }}>{actionError}</p>}
        </header>

        <div
          ref={explorerRef}
          onScroll={(event) => {
            const current = spaceViewMemory.get(memoryKey)
            spaceViewMemory.set(memoryKey, {
              selectedId: current?.selectedId ?? selectedId,
              selectionMemoryVersion: 1,
              expandedIds: current?.expandedIds ?? expandedIds,
              scrollTop: event.currentTarget.scrollTop,
            })
          }}
          className="flex-1 overflow-y-auto px-2 pb-3"
        >
          {/* 我的笔记(可写) */}
          <div className="flex items-center justify-between px-2.5 mt-1 mb-1">
            <span className="text-xs font-medium" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
              我的笔记
            </span>
            <button
              onClick={handleCreateNote}
              aria-label="新建笔记"
              className="p-0.5 rounded transition-colors hover:bg-[var(--aa-hover-tint)]"
              style={{ color: 'var(--aa-text-3, #aba39b)' }}
            >
              <Plus size={13} />
            </button>
          </div>

          {notes.length === 0 && (
            <button
              onClick={handleCreateNote}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm text-left transition-colors hover:bg-[var(--aa-hover-tint)]"
              style={{ color: 'var(--aa-text-3, #aba39b)' }}
            >
              <span style={{ width: 12 }} />
              <NotebookPen size={13} />
              <span>写下第一篇笔记</span>
            </button>
          )}

          {orderedNotes.map((note, i) => (
            <NoteRow
              key={note.id}
              index={i}
              title={note.title}
              selected={selectedId === note.id}
              creating={creatingNoteId === note.id}
              onSelect={() => selectItem(note.id)}
              onRename={(t) => update(note.id, { title: t })}
              onCreateCommit={(title) => finishCreatedNote(note.id, title)}
              onCreateCancel={() => finishCreatedNote(note.id, '无标题')}
              onDelete={() => handleDeleteNote(note.id)}
              onMove={moveNote}
              onDrop={commitOrder}
            />
          ))}

          {/* 外部资料引用 */}
          <div className="flex items-center justify-between px-2.5 mt-4 mb-1">
            <span className="text-xs font-medium" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
              资料
            </span>
            {space !== undefined && hasSpaceItemCreateAction(actions) && (
              <FloatingMenu
                label="添加资料"
                visible
                trigger={<Plus size={13} />}
                actions={[
                  ...(actions?.createManagedFolder === undefined ? [] : [{
                    label: '新建文件夹',
                    icon: <Folder size={12} />,
                    onClick: () => setCreatingFolder(true),
                  }]),
                  ...(actions?.addLocalFile === undefined ? [] : [{
                    label: '添加本地文件',
                    icon: <FileText size={12} />,
                    onClick: () => void runSpaceAction(() => actions.addLocalFile!(space.spaceId)),
                  }]),
                  ...(actions?.addWorkspaceFolder === undefined ? [] : [{
                    label: '添加工作区文件夹',
                    icon: <Folder size={12} />,
                    onClick: () => void runSpaceAction(() => actions.addWorkspaceFolder!(space.spaceId)),
                  }]),
                ]}
              />
            )}
          </div>
          {creatingFolder && (
            <div className="flex items-center gap-2 rounded-md" style={{ padding: '5px 8px 5px 32px' }}>
              <Folder size={13} style={{ color: 'var(--aa-accent, #6865a7)' }} />
              <InlineName
                value=""
                label="文件夹名称"
                onCommit={handleCreateFolder}
                onCancel={() => setCreatingFolder(false)}
              />
            </div>
          )}
          <div role="tree" aria-label={`${space?.title ?? '空间'}资料`}>
            {tree.map((item) => (
              <TreeNode
                key={item.id}
                item={item}
                depth={0}
                onSelect={selectTreeItem}
                selectedId={selectedId}
                onRename={handleRenameItem}
                onUnlink={handleUnlinkItem}
                onDelete={handleDeleteItem}
                onCreateEntry={beginCreateReferenceFile}
                renameEnabled={actions?.rename !== undefined}
                unlinkEnabled={actions?.unlinkReference !== undefined}
                removeEnabled={actions?.removeReference !== undefined}
                removeManagedFolderEnabled={actions?.removeReference !== undefined}
                isExpanded={(id) => expandedIds.has(id)}
                onToggleExpand={toggleExpanded}
                onPrefetch={prefetchTreeItem}
                creatingEntry={creatingReferenceFile ?? undefined}
                onCreateEntryCommit={(name) => void finishCreateReferenceFile(name)}
                onCreateEntryCancel={() => {
                  referenceCreationRequestRef.current += 1
                  setCreatingReferenceFile(null)
                }}
              />
            ))}
          </div>

          {/* 对话（owner read-model，ADR-0035 §8.1） */}
          <div className="flex items-center justify-between px-2.5 mt-4 mb-1">
            <span className="text-xs font-medium" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
              对话
            </span>
          </div>
          {(space?.conversations?.length ?? 0) === 0 ? (
            <div className="px-3 py-1 text-[11px]" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
              暂无对话
            </div>
          ) : (
            <div
              className="space-y-0.5 overflow-y-auto"
              style={{ maxHeight: 260, scrollbarWidth: 'none' }}
            >
              {orderedSpaceConversations.map((conversation, index) => (
                <Fragment key={conversation.conversationId}>
                  <SpaceConversationRow
                    conversation={conversation}
                    dot={SPACE_CONVERSATION_DOT_PALETTE[index % SPACE_CONVERSATION_DOT_PALETTE.length] ?? SPACE_CONVERSATION_DOT_PALETTE[0]}
                    selected={(pendingConversationId ?? openConversationId) === conversation.conversationId}
                    renaming={renamingConversationId === conversation.conversationId}
                    onOpen={() => void openConversation(conversation.conversationId)}
                    onStartRename={() => setRenamingConversationId(conversation.conversationId)}
                    onRename={(title) => {
                      void onRenameConversation?.(conversation.conversationId, title)
                      setRenamingConversationId(null)
                    }}
                    onCancelRename={() => setRenamingConversationId(null)}
                    onTogglePinned={(pinned) => void onToggleConversationPinned?.(conversation.conversationId, pinned)}
                    onDelete={() => void onDeleteConversation?.(conversation.conversationId)}
                  />
                  {index === pinnedSpaceConversationCount - 1
                    && pinnedSpaceConversationCount > 0
                    && pinnedSpaceConversationCount < orderedSpaceConversations.length && (
                    <div
                      className="aa-conversation-divider mx-2 my-1 border-t"
                      style={{ borderColor: 'var(--aa-border, rgba(45,40,34,0.09))' }}
                      aria-hidden="true"
                    />
                  )}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Space resources and the active Conversation context. */}
      {conversationSurfaceVisible ? (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden" data-space-conversation>
          <header
            className="flex h-11 shrink-0 items-center justify-between border-b px-5"
            style={{ borderColor: 'var(--aa-border, rgba(45,40,34,0.09))' }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <MessageSquare size={14} style={{ color: 'var(--aa-text-3, #aba39b)' }} aria-hidden="true" />
              <span className="truncate text-xs font-medium" style={{ color: 'var(--aa-text-2, #5f5a53)' }}>
                {visibleConversationTitle}
              </span>
            </div>
            {onEnterFocus !== undefined && (
              <button
                type="button"
                onClick={onEnterFocus}
                aria-label="专注阅读"
                title="专注阅读"
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors hover:bg-[var(--aa-hover-tint)] focus-visible:outline-none focus-visible:ring-2"
                style={{
                  borderColor: 'var(--aa-border, rgba(45,40,34,0.09))',
                  color: 'var(--aa-text-3, #aba39b)',
                }}
              >
                <Maximize2 size={12} aria-hidden="true" />
                <span>专注阅读</span>
              </button>
            )}
          </header>
          <div className="flex min-w-0 flex-1 overflow-hidden">
            {conversationContent}
          </div>
        </div>
      ) : selectedNote ? (
        <SurfaceErrorBoundary resetKey={selectedNote.id} label="笔记编辑器暂时无法打开">
            <NoteEditor
              note={selectedNote}
              onSave={update}
              onClose={() => setSelectedId(null)}
              onRestoreAsNew={(draft) => {
                const restored = create({ title: draft.title.trim() || '无标题', bodyMarkdown: draft.bodyMarkdown })
                setSelectedId(restored.id)
              }}
            />
        </SurfaceErrorBoundary>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {selectedItem?.type !== 'folder' && selectedItem ? (
            <ReferencePreview
              ref={referencePreviewRef}
              itemId={selectedItem.referenceId ?? selectedItem.id}
              initialRelativePath={selectedItem.relativePath ?? ''}
              fallbackTitle={selectedReferenceRoot?.name ?? selectedItem.name}
              canOpen={selectedItem.openable === true || selectedItem.openUrl !== undefined}
              onOpen={() => void handleOpenReference(selectedItem)}
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
              <p className="text-xs leading-relaxed text-center" style={{ color: 'var(--aa-text-3, #aba39b)' }}>
                从左侧选择一篇笔记或材料
                <br />
                即可在此书写或查看
              </p>
            </CenteredCard>
          )}
        </div>
      )}
    </section>
    <ActionConfirmationDialog
      request={pendingSpaceConfirmation?.request}
      onCancel={() => setPendingSpaceConfirmation(null)}
      onConfirm={confirmPendingSpaceAction}
    />
    </DndProvider>
  )
}

const DND_NOTE = 'space-note-row'

function NoteRow({
  index,
  title,
  selected,
  creating = false,
  onSelect,
  onRename,
  onCreateCommit,
  onCreateCancel,
  onDelete,
  onMove,
  onDrop,
}: {
  index: number
  title: string
  selected: boolean
  creating?: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onCreateCommit?: (title: string) => void
  onCreateCancel?: () => void
  onDelete: () => void
  onMove: (from: number, to: number) => void
  onDrop: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(creating)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (creating) setEditing(true)
  }, [creating])

  const [{ isDragging }, drag, preview] = useDrag({
    type: DND_NOTE,
    item: { index },
    canDrag: !editing,
    collect: (m) => ({ isDragging: m.isDragging() }),
    end: () => onDrop(), // 松手落盘
  })
  // 隐藏浏览器默认的半透明拖影(那个「原生图标」很难看);拖动反馈改由本行自身
  // 变淡(opacity)来体现,更贴合整体质感。
  useEffect(() => {
    preview(getEmptyImage(), { captureDraggingState: true })
  }, [preview])
  const [, drop] = useDrop<{ index: number }>({
    accept: DND_NOTE,
    hover(item, monitor) {
      if (!ref.current || item.index === index) return
      const rect = ref.current.getBoundingClientRect()
      const midY = (rect.bottom - rect.top) / 2
      const offset = monitor.getClientOffset()
      if (!offset) return
      const y = offset.y - rect.top
      if (item.index < index && y < midY) return
      if (item.index > index && y > midY) return
      onMove(item.index, index)
      item.index = index // 记住新位置,避免抖动
    },
  })
  drop(ref)

  return (
    <div
      ref={ref}
      data-note-row
      className="group/note flex items-center gap-2 rounded-md cursor-pointer"
      style={{
        paddingLeft: 10,
        paddingRight: 8,
        // Draft and ordinary rows share one box size. A height change while
        // the focused title commits can move the user's click to another row.
        paddingTop: 6,
        paddingBottom: 6,
        opacity: isDragging ? 0.4 : 1,
        background: selected
          ? 'var(--aa-surface-active, #e5e1db)'
          : hovered
          ? 'var(--aa-surface-hover, #eeebe6)'
          : 'transparent',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (!editing) onSelect()
      }}
      onDoubleClick={() => setEditing(true)}
    >
      {/* 拖拽手柄:在图标左侧,悬停时浮现,按住即可上下拖动排序。 */}
      <span
        ref={(node) => { drag(node) }}
        onClick={(e) => e.stopPropagation()}
        className="flex items-center justify-center shrink-0 cursor-move"
        style={{ width: 12, color: 'var(--aa-text-3, #aba39b)', opacity: hovered && !editing ? 1 : 0 }}
      >
        <GripVertical size={12} />
      </span>
      <NotebookPen size={13} style={{ color: '#6f8778' }} />
      {editing ? (
        <InlineName
          value={title}
          label={creating ? '笔记名称' : `重命名${title}`}
          onCommit={(t) => {
            if (creating) onCreateCommit?.(t)
            else onRename(t)
            setEditing(false)
          }}
          onCancel={() => {
            if (creating) onCreateCancel?.()
            setEditing(false)
          }}
        />
      ) : (
        <span className="flex-1 text-sm truncate" style={{ color: 'var(--aa-text-1, #292722)' }}>
          {title}
        </span>
      )}
      {!editing && (
        <FloatingMenu
          label={`${title}操作`}
          visible={hovered}
          actions={[
            { label: '重命名', icon: <Pencil size={12} />, onClick: () => setEditing(true) },
            { label: '删除', icon: <Trash2 size={12} />, danger: true, onClick: onDelete },
          ]}
        />
      )}
    </div>
  )
}

/** 行内重命名输入:回车/失焦提交,Esc 取消。 */
function InlineName({
  value,
  label,
  onCommit,
  onCancel,
}: {
  value: string
  label: string
  onCommit: (v: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const settledRef = useRef(false)
  const blurTimerRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // 不再 select() 全选 —— 那会出现难看的蓝色原生选中块。
    // 改为把光标停在末尾,进入即可直接续写。
    const len = el.value.length
    el.setSelectionRange(len, len)
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
    const t = draft.trim()
    if (t) onCommit(t)
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
      onChange={(e) => setDraft(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onFocus={() => {
        if (blurTimerRef.current !== undefined) window.clearTimeout(blurTimerRef.current)
        blurTimerRef.current = undefined
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      onBlur={scheduleBlurCommit}
      className="flex-1 min-w-0 text-sm bg-transparent outline-none"
      style={{
        height: 20,
        lineHeight: '19px',
        boxSizing: 'border-box',
        color: 'var(--aa-text-1, #292722)',
        // 只用一条淡淡的下划线示意「正在编辑」,不再整体套一个蓝框。
        borderBottom: '1px solid var(--aa-border, rgba(45,40,34,0.25))',
        padding: 0,
      }}
    />
  )
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">{children}</div>
  )
}

const SPACE_CONVERSATION_DOT_PALETTE = ['#6865a7', '#6f9279', '#c18a42', '#6f84a5', '#a66f66'] as const

/** 空间页左侧"对话"Section 的会话行：随机色点标识 + 行内重命名 + hover 操作。 */
function SpaceConversationRow(props: {
  readonly conversation: PersonalSpaceConversationContext
  readonly dot: string
  readonly selected: boolean
  readonly renaming: boolean
  readonly onOpen: () => void
  readonly onStartRename: () => void
  readonly onRename: (title: string) => void
  readonly onCancelRename: () => void
  readonly onTogglePinned: (pinned: boolean) => void
  readonly onDelete: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const pinned = props.conversation.pinnedAt !== undefined
  return (
    <div
      role="button"
      className="group/row flex items-center gap-2 rounded-lg cursor-pointer text-sm transition-colors"
      style={{
        height: 30,
        paddingLeft: 10,
        paddingRight: 8,
        color: 'var(--aa-text-2, #6b655d)',
        background: props.selected || hovered ? 'var(--aa-surface-hover, #eeebe6)' : 'transparent',
      }}
      aria-current={props.selected ? 'true' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => { if (!props.renaming) props.onOpen() }}
    >
      <span style={{
        width: 8,
        height: 8,
        borderRadius: 2,
        background: props.dot,
        flexShrink: 0,
      }} />
      {props.renaming ? (
        <InlineName
          value={props.conversation.title}
          label={`重命名${props.conversation.title}`}
          onCommit={(title) => props.onRename(title)}
          onCancel={props.onCancelRename}
        />
      ) : (
        <span className="flex-1 truncate">{props.conversation.title}</span>
      )}
      {!props.renaming && (
        <FloatingMenu
          label={`${props.conversation.title}操作`}
          visible={hovered}
          actions={[
            { label: pinned ? '取消置顶' : '置顶', icon: pinned ? <PinOff size={12} /> : <Pin size={12} />, onClick: () => props.onTogglePinned(!pinned) },
            { label: '重命名', icon: <Pencil size={12} />, onClick: props.onStartRename },
            { label: '删除', icon: <Trash2 size={12} />, danger: true, onClick: props.onDelete },
          ]}
        />
      )}
    </div>
  )
}

function hasSpaceItemCreateAction(actions: PersonalSpaceActions | undefined): boolean {
  return actions?.createManagedFolder !== undefined
    || actions?.addLocalFile !== undefined
    || actions?.addWorkspaceFolder !== undefined
}

function compareSpaceConversations(left: PersonalSpaceConversationContext, right: PersonalSpaceConversationContext): number {
  const leftPinned = left.pinnedAt !== undefined
  const rightPinned = right.pinnedAt !== undefined
  if (leftPinned !== rightPinned) return rightPinned ? 1 : -1
  if (leftPinned && rightPinned) {
    const pinnedOrder = timestampValue(right.pinnedAt) - timestampValue(left.pinnedAt)
    if (pinnedOrder !== 0) return pinnedOrder
  }
  return timestampValue(right.updatedAt) - timestampValue(left.updatedAt)
}

function timestampValue(value: string | undefined): number {
  if (value === undefined) return 0
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

/**
 * 收藏进知识库 —— 把眼前这个对象从「空间里用得上」升格为「值得长期留下」。
 * 已收藏则显示为已入库状态,再点则移出。
 */
function canCollectSpaceReference(item: SpaceItem): boolean {
  return item.domainKind === 'local_file'
    || item.domainKind === 'workspace_folder'
    || item.domainKind === 'managed_folder'
}

/** 将空间中的本地引用复制为知识库中的托管副本。 */
function CollectSpaceReferenceButton({
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
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--aa-hover-tint)]"
      style={{ color: collected ? 'var(--aa-accent, #6865a7)' : 'var(--aa-text-2, #87827c)' }}
    >
      <Brain size={12} />
      {pending ? (collected ? '正在取消…' : '正在收藏…') : collected ? '已收藏' : '收藏'}
    </button>
  )
}
