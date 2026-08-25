import { useEffect, useRef, useState, type RefObject } from 'react'
import { useDrag, useDrop } from 'react-dnd'
import { getEmptyImage } from 'react-dnd-html5-backend'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileImage,
  FilePlus,
  FileText,
  FileVideo,
  Folder,
  Globe,
  GripVertical,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  RefreshCw,
  Trash2,
  Unlink,
} from 'lucide-react'
import type {
  PersonalSpaceActions,
  PersonalSpaceConversationContext,
  PersonalSpaceProjection,
} from '@ui/personal-workbench/space'
import { FloatingMenu } from '@ui/components/floating-menu'
import type { Note } from '../notesStore'
import type { SpaceItem } from '../useMountedTree'
import { InlineName } from './space-actions'
import { SpaceConversationList } from './space-conversations'

const NOTE_DRAG_TYPE = 'space-note-row'

export function countSpaceItems(tree: readonly SpaceItem[]): number {
  return tree.reduce((count, item) => count + 1 + (item.children ? countSpaceItems(item.children) : 0), 0)
}

export function firstSelectableSpaceTreeItemId(items: readonly SpaceItem[]): string | null {
  return items.find((item) => item.type !== 'folder')?.id ?? null
}

export function SpaceExplorer({
  space,
  itemCount,
  actionError,
  explorerRef,
  onScroll,
  onSearch,
  notes,
  references,
  conversations,
}: {
  space: PersonalSpaceProjection | undefined
  itemCount: number
  actionError: string | null
  explorerRef: RefObject<HTMLDivElement | null>
  onScroll: (scrollTop: number) => void
  onSearch: () => void
  notes: Parameters<typeof SpaceNotesSection>[0]
  references: Parameters<typeof SpaceReferencesSection>[0]
  conversations: {
    readonly items: readonly PersonalSpaceConversationContext[]
    readonly selectedId: string | null
    readonly renamingId: string | null
    readonly onOpen: (conversationId: string) => void
    readonly onStartRename: (conversationId: string) => void
    readonly onRename: (conversationId: string, title: string) => void
    readonly onCancelRename: () => void
    readonly onTogglePinned: (conversationId: string, pinned: boolean) => void
    readonly onDelete: (conversationId: string) => void
  }
}) {
  return (
    <div
      className="shrink-0 flex flex-col"
      style={{ width: 288, borderRight: '1px solid var(--ui-border, rgba(45,40,34,0.09))' }}
    >
      <header className="px-4 pt-4 pb-3 shrink-0">
        <div className="flex items-center gap-2.5 mb-1">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: space?.color ?? '#a8c4b4' }} />
          <h1 className="text-sm font-semibold m-0 flex-1" style={{ color: 'var(--ui-text-1, #292722)' }}>
            {space?.title ?? '空间'}
          </h1>
          <button
            onClick={onSearch}
            className="p-1 rounded transition-colors hover:bg-[var(--ui-hover-tint)]"
            style={{ color: 'var(--ui-text-3, #aba39b)' }}
          >
            <Search size={13} />
          </button>
        </div>
        <p className="text-xs m-0 pl-[22px]" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
          {itemCount} 个对象
        </p>
        {actionError && <p role="alert" className="text-xs mt-2 mb-0 pl-[22px]" style={{ color: 'var(--ui-status-error, #b3543f)' }}>{actionError}</p>}
      </header>

      <div
        ref={explorerRef}
        onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto px-2 pb-3"
      >
        <SpaceNotesSection {...notes} />
        <SpaceReferencesSection {...references} />
        <SpaceConversationList
          conversations={conversations.items}
          selectedConversationId={conversations.selectedId}
          renamingConversationId={conversations.renamingId}
          onOpen={conversations.onOpen}
          onStartRename={conversations.onStartRename}
          onRename={conversations.onRename}
          onCancelRename={conversations.onCancelRename}
          onTogglePinned={conversations.onTogglePinned}
          onDelete={conversations.onDelete}
        />
      </div>
    </div>
  )
}

function SpaceNotesSection({
  notes,
  selectedId,
  creatingNoteId,
  onCreate,
  onSelect,
  onRename,
  onCreateCommit,
  onCreateCancel,
  onDelete,
  onMove,
  onDrop,
}: {
  notes: readonly Note[]
  selectedId: string | null
  creatingNoteId: string | null
  onCreate: () => void
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onCreateCommit: (id: string, title: string) => void
  onCreateCancel: (id: string) => void
  onDelete: (id: string) => void
  onMove: (from: number, to: number) => void
  onDrop: () => void
}) {
  return (
    <>
      <div className="flex items-center justify-between px-2.5 mt-1 mb-1">
        <span className="text-xs font-medium" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
          我的笔记
        </span>
        <button
          onClick={onCreate}
          aria-label="新建笔记"
          className="p-0.5 rounded transition-colors hover:bg-[var(--ui-hover-tint)]"
          style={{ color: 'var(--ui-text-3, #aba39b)' }}
        >
          <Plus size={13} />
        </button>
      </div>

      {notes.length === 0 && (
        <button
          onClick={onCreate}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm text-left transition-colors hover:bg-[var(--ui-hover-tint)]"
          style={{ color: 'var(--ui-text-3, #aba39b)' }}
        >
          <span style={{ width: 12 }} />
          <NotebookPen size={13} />
          <span>写下第一篇笔记</span>
        </button>
      )}

      {notes.map((note, index) => (
        <NoteRow
          key={note.id}
          index={index}
          title={note.title}
          selected={selectedId === note.id}
          creating={creatingNoteId === note.id}
          onSelect={() => onSelect(note.id)}
          onRename={(title) => onRename(note.id, title)}
          onCreateCommit={(title) => onCreateCommit(note.id, title)}
          onCreateCancel={() => onCreateCancel(note.id)}
          onDelete={() => onDelete(note.id)}
          onMove={onMove}
          onDrop={onDrop}
        />
      ))}
    </>
  )
}

function SpaceReferencesSection({
  space,
  actions,
  tree,
  selectedId,
  creatingFolder,
  creatingEntry,
  expandedIds,
  onStartCreateFolder,
  onCreateFolder,
  onCancelCreateFolder,
  onRunAction,
  onSelect,
  onRename,
  onUnlink,
  onReconnectWorkspace,
  onDelete,
  onCreateEntry,
  onToggleExpand,
  onPrefetch,
  onCreateEntryCommit,
  onCreateEntryCancel,
}: {
  space: PersonalSpaceProjection | undefined
  actions: PersonalSpaceActions | undefined
  tree: readonly SpaceItem[]
  selectedId: string | null
  creatingFolder: boolean
  creatingEntry?: { readonly parentId: string }
  expandedIds: ReadonlySet<string>
  onStartCreateFolder: () => void
  onCreateFolder: (title: string) => void
  onCancelCreateFolder: () => void
  onRunAction: (operation: () => void | Promise<void>) => void
  onSelect: (id: string) => void
  onRename: (item: SpaceItem, name: string) => void
  onUnlink: (item: SpaceItem) => void
  onReconnectWorkspace: (item: SpaceItem) => void
  onDelete: (item: SpaceItem) => void
  onCreateEntry: (item: SpaceItem) => void
  onToggleExpand: (id: string) => void
  onPrefetch: (item: SpaceItem) => void
  onCreateEntryCommit: (name: string) => void
  onCreateEntryCancel: () => void
}) {
  return (
    <>
      <div className="flex items-center justify-between px-2.5 mt-4 mb-1">
        <span className="text-xs font-medium" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
          资料
        </span>
        {space !== undefined && hasItemCreateAction(actions) && (
          <FloatingMenu
            label="添加资料"
            visible
            trigger={<Plus size={13} />}
            actions={[
              ...(actions?.createManagedFolder === undefined ? [] : [{
                label: '新建文件夹',
                icon: <Folder size={12} />,
                onClick: onStartCreateFolder,
              }]),
              ...(actions?.addLocalFile === undefined ? [] : [{
                label: '添加本地文件',
                icon: <FileText size={12} />,
                onClick: () => onRunAction(() => actions.addLocalFile!(space.spaceId)),
              }]),
              ...(actions?.addWorkspaceFolder === undefined ? [] : [{
                label: '添加工作区文件夹',
                icon: <Folder size={12} />,
                onClick: () => onRunAction(() => actions.addWorkspaceFolder!(space.spaceId)),
              }]),
            ]}
          />
        )}
      </div>
      {creatingFolder && (
        <div className="flex items-center gap-2 rounded-md" style={{ padding: '5px 8px 5px 32px' }}>
          <Folder size={13} style={{ color: 'var(--ui-accent, #6865a7)' }} />
          <InlineName
            value=""
            label="文件夹名称"
            onCommit={onCreateFolder}
            onCancel={onCancelCreateFolder}
          />
        </div>
      )}
      <div role="tree" aria-label={`${space?.title ?? '空间'}资料`}>
        {tree.map((item) => (
          <TreeNode
            key={item.id}
            item={item}
            depth={0}
            onSelect={onSelect}
            selectedId={selectedId}
            onRename={onRename}
            onUnlink={onUnlink}
            onReconnectWorkspace={onReconnectWorkspace}
            onDelete={onDelete}
            onCreateEntry={onCreateEntry}
            renameEnabled={actions?.rename !== undefined}
            unlinkEnabled={actions?.unlinkReference !== undefined}
            removeEnabled={actions?.removeReference !== undefined}
            removeManagedFolderEnabled={actions?.removeReference !== undefined}
            isExpanded={(id) => expandedIds.has(id)}
            onToggleExpand={onToggleExpand}
            onPrefetch={onPrefetch}
            creatingEntry={creatingEntry}
            onCreateEntryCommit={onCreateEntryCommit}
            onCreateEntryCancel={onCreateEntryCancel}
          />
        ))}
      </div>
    </>
  )
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
    return <FileText size={size} style={{ color: 'var(--ui-text-2, #87827c)' }} />
  }
  return <File size={size} style={{ color: 'var(--ui-text-2, #87827c)' }} />
}

function itemIcon(item: SpaceItem, size = 13) {
  switch (item.type) {
    case 'folder':
      return <Folder size={size} style={{ color: 'var(--ui-accent, #6865a7)' }} />
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
  onReconnectWorkspace,
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
  onReconnectWorkspace: (item: SpaceItem) => void
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
  const canCreateExternalEntry = !item.externalChild
    && item.type === 'folder'
    && item.referenceId !== undefined
    && item.domainKind === 'managed_folder'
  const canRename = !item.externalChild
    && item.domainKind !== 'workspace'
    && renameEnabled
  const canUnlink = !item.externalChild
    && (item.domainKind === 'workspace' || item.domainKind === 'local_file' || item.domainKind === 'web_reference' || item.domainKind === 'generated_artifact')
    && unlinkEnabled
  const canReconnect = !item.externalChild && item.domainKind === 'workspace' && item.workspaceStatus === 'disconnected'
  const canRemove = (isManagedFolder && removeManagedFolderEnabled
    || (!item.externalChild && item.domainKind === 'folder' && removeEnabled))
  const paddingLeft = 10 + depth * 14

  return (
    <div>
      <div
        className="group/row flex items-center gap-2 rounded-md cursor-pointer transition-colors"
        style={{
          height: 30,
          paddingLeft,
          paddingRight: 8,
          background: selected
            ? 'var(--ui-surface-active, #e5e1db)'
            : hovered
            ? 'var(--ui-surface-hover, #eeebe6)'
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
          <span style={{ color: 'var(--ui-text-3, #aba39b)', width: 12, flexShrink: 0 }}>
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
            onCommit={(title) => {
              onRename(item, title)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span
            className="flex-1 text-sm truncate"
            style={{ color: 'var(--ui-text-1, #292722)' }}
          >
            {item.name}
          </span>
        )}

        {!editing && (canCreateExternalEntry || canRename || canReconnect || canUnlink || canRemove) && (
          <FloatingMenu
            label={`${item.name}操作`}
            visible={hovered}
            actions={[
              ...(canCreateExternalEntry ? [{ label: '新建文件', icon: <FilePlus size={12} />, onClick: () => onCreateEntry(item) }] : []),
              ...(canRename ? [{ label: '重命名', icon: <Pencil size={12} />, onClick: () => setEditing(true) }] : []),
              ...(canReconnect ? [{ label: '重新连接', icon: <RefreshCw size={12} />, onClick: () => onReconnectWorkspace(item) }] : []),
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
          <FileText size={13} style={{ color: 'var(--ui-text-2, #87827c)' }} />
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
              onReconnectWorkspace={onReconnectWorkspace}
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
    type: NOTE_DRAG_TYPE,
    item: { index },
    canDrag: !editing,
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    end: onDrop,
  })
  useEffect(() => {
    preview(getEmptyImage(), { captureDraggingState: true })
  }, [preview])
  const [, drop] = useDrop<{ index: number }>({
    accept: NOTE_DRAG_TYPE,
    hover(item, monitor) {
      if (!ref.current || item.index === index) return
      const rect = ref.current.getBoundingClientRect()
      const middleY = (rect.bottom - rect.top) / 2
      const offset = monitor.getClientOffset()
      if (!offset) return
      const y = offset.y - rect.top
      if (item.index < index && y < middleY) return
      if (item.index > index && y > middleY) return
      onMove(item.index, index)
      item.index = index
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
        paddingTop: 6,
        paddingBottom: 6,
        opacity: isDragging ? 0.4 : 1,
        background: selected
          ? 'var(--ui-surface-active, #e5e1db)'
          : hovered
          ? 'var(--ui-surface-hover, #eeebe6)'
          : 'transparent',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (!editing) onSelect()
      }}
      onDoubleClick={() => setEditing(true)}
    >
      <span
        ref={(node) => { drag(node) }}
        onClick={(event) => event.stopPropagation()}
        className="flex items-center justify-center shrink-0 cursor-move"
        style={{ width: 12, color: 'var(--ui-text-3, #aba39b)', opacity: hovered && !editing ? 1 : 0 }}
      >
        <GripVertical size={12} />
      </span>
      <NotebookPen size={13} style={{ color: '#6f8778' }} />
      {editing ? (
        <InlineName
          value={title}
          label={creating ? '笔记名称' : `重命名${title}`}
          onCommit={(nextTitle) => {
            if (creating) onCreateCommit?.(nextTitle)
            else onRename(nextTitle)
            setEditing(false)
          }}
          onCancel={() => {
            if (creating) onCreateCancel?.()
            setEditing(false)
          }}
        />
      ) : (
        <span className="flex-1 text-sm truncate" style={{ color: 'var(--ui-text-1, #292722)' }}>
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

function hasItemCreateAction(actions: PersonalSpaceActions | undefined): boolean {
  return actions?.createManagedFolder !== undefined
    || actions?.addLocalFile !== undefined
    || actions?.addWorkspaceFolder !== undefined
}

function deleteLabelFor(item: SpaceItem): string {
  if (item.externalChild) return item.type === 'folder' ? '删除文件夹' : '删除'
  if (item.domainKind === 'folder' || item.domainKind === 'managed_folder') return '删除文件夹'
  return item.domainKind === 'local_file' ? '删除文件' : '删除'
}
