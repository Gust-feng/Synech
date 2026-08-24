import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  PersonalSpaceItemProjection,
  PersonalSpaceProjection,
} from '../../../space'
import {
  getCachedReferencePreview,
  getReferencePreviewCacheVersion,
  invalidateDocumentPreviews,
  refreshDocumentPreview,
  subscribeReferencePreviewCache,
  type DocumentPreview,
} from './referencePreviewClient'
import { subscribeWorkbenchProjectionChanges } from '@ui/workbench/projection-changes'
import { warmReferenceDirectoryPreviews } from './space-reference-preview-warmup'
import { ApiError } from '@ui/api'

/**
 * 挂载树状态收口 —— 把「引用目录的加载 / 缓存 / 展开」从 SpacePage 的分散状态
 * 收敛为单一事实源。本 Hook 只负责：
 *   - 把后端空间投影 + 动态加载的引用目录子条目合并成一棵渲染树；
 *   - 按 spaceId + 挂载身份 + 相对路径隔离目录缓存，空间之间不串数据；
 *   - 维护展开态（仅 UI）与加载去重 / 过期请求防护。
 *
 * 它不拥有选中态、拖拽排序、行内重命名等纯 UI 交互（仍留在 SpacePage），
 * 也不复制业务树到第二份长期状态源：渲染树只此一份，由本 Hook 计算。
 */

// ---------------------------------------------------------------------------
// 共享类型与纯投影
// ---------------------------------------------------------------------------

export interface SpaceItem {
  id: string
  name: string
  type: 'folder' | 'file' | 'web'
  domainKind: PersonalSpaceItemProjection['kind']
  meta?: string
  defaultExpanded?: boolean
  children?: SpaceItem[]
  openUrl?: string
  openable?: boolean
  referenceId?: string
  assetId?: string
  relativePath?: string
  externalChild?: boolean
}

/** 可挂载文件系统（工作区文件夹 / 受管文件夹）的来源种类。 */
export type FileSystemFolderKind = Extract<
  PersonalSpaceItemProjection['kind'],
  'workspace_folder' | 'managed_folder'
>

export function isFileSystemFolderKind(
  kind: PersonalSpaceItemProjection['kind'],
): kind is FileSystemFolderKind {
  return kind === 'workspace_folder' || kind === 'managed_folder'
}

type ReferencePresentationKindResolver = (
  item: PersonalSpaceItemProjection,
) => DocumentPreview['presentation']['kind'] | undefined

function cachedReferencePresentationKind(
  item: PersonalSpaceItemProjection,
): DocumentPreview['presentation']['kind'] | undefined {
  if (item.kind !== 'managed_asset') return undefined
  return getCachedReferencePreview(item.referenceId ?? item.itemId)?.presentation.kind
}

function visualItemType(
  kind: PersonalSpaceItemProjection['kind'],
  presentationKind: DocumentPreview['presentation']['kind'] | undefined,
): SpaceItem['type'] {
  switch (kind) {
    case 'folder':
    case 'workspace_folder':
    case 'managed_folder':
      return 'folder'
    case 'web_reference':
      return 'web'
    case 'managed_asset':
      return presentationKind === 'web' ? 'web' : 'file'
    default:
      return 'file'
  }
}

export function projectSpaceItem(
  item: PersonalSpaceItemProjection,
  resolvePresentationKind: ReferencePresentationKindResolver = cachedReferencePresentationKind,
): SpaceItem | undefined {
  return {
    id: item.itemId,
    name: item.title,
    type: visualItemType(item.kind, resolvePresentationKind(item)),
    domainKind: item.kind,
    meta: item.detail ?? item.updatedAtLabel,
    defaultExpanded: item.kind === 'folder',
    children: item.children
      ?.map((child) => projectSpaceItem(child, resolvePresentationKind))
      .filter((child): child is SpaceItem => child !== undefined),
    openUrl: item.openUrl,
    openable: item.openable,
    referenceId: item.referenceId,
    assetId: item.assetId,
  }
}

function projectSpaceTree(space: PersonalSpaceProjection | undefined): SpaceItem[] {
  if (space === undefined) return []
  return space.items
    .map((item) => projectSpaceItem(item))
    .filter((item): item is SpaceItem => item !== undefined)
}

/** 外部引用条目的稳定 id：`referenceId::<encoded relativePath>`。 */
export function referenceChildId(referenceId: string, relativePath: string): string {
  return `${referenceId}::${encodeURIComponent(relativePath)}`
}

function projectReferenceChildren(
  referenceId: string,
  sourceKind: FileSystemFolderKind,
  entries: readonly {
    readonly name: string
    readonly relativePath: string
    readonly kind: 'file' | 'directory' | 'other'
  }[],
): SpaceItem[] {
  return entries.map((entry) => ({
    id: referenceChildId(referenceId, entry.relativePath),
    name: entry.name,
    type: entry.kind === 'directory' ? 'folder' : 'file',
    domainKind: entry.kind === 'directory' ? sourceKind : 'local_file',
    referenceId,
    relativePath: entry.relativePath,
    externalChild: true,
  }))
}

export function getItem(tree: SpaceItem[], id: string): SpaceItem | undefined {
  for (const item of tree) {
    if (item.id === id) return item
    if (item.children !== undefined) {
      const found = getItem(item.children, id)
      if (found) return found
    }
  }
  return undefined
}

export function collectDefaultExpanded(
  tree: SpaceItem[],
  result = new Set<string>(),
): Set<string> {
  for (const item of tree) {
    if (item.type === 'folder' && item.defaultExpanded) result.add(item.id)
    if (item.children !== undefined) collectDefaultExpanded(item.children, result)
  }
  return result
}

/** 把动态加载的目录子条目叠加到静态投影树上（不改写投影来源）。 */
function attachReferenceChildren(
  tree: SpaceItem[],
  childrenById: ReadonlyMap<string, SpaceItem[]>,
): SpaceItem[] {
  return tree.map((item) => {
    const children = childrenById.get(item.id) ?? item.children
    return {
      ...item,
      children:
        children === undefined ? undefined : attachReferenceChildren(children, childrenById),
    }
  })
}

export function actionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : '空间操作没有完成，请重试。'
}

/**
 * 引用已经不存在（多为用户刚取消引用、树投影尚未刷新完成的窗口）。
 * 这是投影收敛过程中的正常事实，不是加载失败，不应作为操作错误呈现。
 */
export function isReferenceRemovedError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'space_reference_not_found'
}

// ---------------------------------------------------------------------------
// 缓存状态
// ---------------------------------------------------------------------------

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error'

interface DirectoryState {
  spaceId: string
  status: LoadStatus
  entries: SpaceItem[]
  error?: string
  /** 每次刷新递增；过期请求的响应会被丢弃，避免覆盖到错误目录。 */
  revision: number
  /** 与渲染树 item.id 对齐的挂载键，用于叠加到投影树。 */
  directoryId: string
}

/** 只有工作区 / 受管文件夹才有可加载的真实目录。 */
function isLoadableFolder(item: SpaceItem): boolean {
  return (
    item.type === 'folder' &&
    item.referenceId !== undefined &&
    isFileSystemFolderKind(item.domainKind)
  )
}

/** 目录的渲染键：根目录即 referenceId，子目录为 referenceChildId。 */
function directoryIdOf(item: SpaceItem): string {
  const referenceId = item.referenceId
  if (referenceId === undefined) return item.id
  const relativePath = item.relativePath ?? ''
  return relativePath === '' ? referenceId : referenceChildId(referenceId, relativePath)
}

/** 缓存键显式包含 spaceId，按空间 + 挂载身份 + 相对路径隔离。 */
function directoryCacheKey(spaceId: string, directoryId: string): string {
  return `${spaceId}::${directoryId}`
}

export interface UseMountedTreeOptions {
  spaceId: string
  space: PersonalSpaceProjection | undefined
  /** 跨会话恢复的展开集合（来自 spaceViewMemory）；缺省回退到默认展开。 */
  initialExpandedIds?: ReadonlySet<string>
  /** 目录加载失败时回调（用于把错误呈现到操作错误条）。 */
  onError?: (message: string) => void
}

export interface UseMountedTreeResult {
  /** 静态投影树（用于对象总数等后端权威投影回退）。 */
  projectedTree: SpaceItem[]
  /** 叠加动态目录后的渲染树。 */
  tree: SpaceItem[]
  /** 目录缓存（调试 / 透明化用），按缓存键隔离。 */
  directories: ReadonlyMap<string, DirectoryState>
  expandedIds: ReadonlySet<string>
  isExpanded: (id: string) => boolean
  /** 切换展开；展开时同步触发加载，首次点击必立即展开 + 加载。 */
  toggleExpand: (item: SpaceItem) => void
  /** 确保展开并加载（用于创建文件时强制展开父目录）。 */
  expandItem: (item: SpaceItem) => void
  /** 预取目录（已就绪 / 加载中则跳过），不抛错。 */
  loadDirectory: (item: SpaceItem) => Promise<void>
  /** 强制刷新指定目录（保留旧条目避免闪烁），失败抛错。 */
  refreshDirectory: (item: SpaceItem) => Promise<void>
  /** 按 referenceId + relativePath 强制刷新，失败抛错。 */
  refreshByReference: (referenceId: string, relativePath: string) => Promise<void>
  /** 刷新某子路径的父目录（重命名 / 删除后用），失败抛错。 */
  refreshParentOf: (referenceId: string, childRelativePath: string) => Promise<void>
  /** 重新取得所有已展开目录的快照（窗口重新聚焦时用）。 */
  refreshAllExpanded: () => void
}

export function useMountedTree(options: UseMountedTreeOptions): UseMountedTreeResult {
  const { spaceId, space, initialExpandedIds, onError } = options

  const previewCacheVersion = useSyncExternalStore(
    subscribeReferencePreviewCache,
    getReferencePreviewCacheVersion,
    getReferencePreviewCacheVersion,
  )
  const projectedTree = useMemo(() => projectSpaceTree(space), [previewCacheVersion, space])

  const [directories, setDirectories] = useState<Map<string, DirectoryState>>(new Map())
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(initialExpandedIds ?? collectDefaultExpanded(projectedTree)),
  )

  // ref 镜像，便于在事件 / 守卫里读取最新值而避免陈旧闭包。
  const directoriesRef = useRef(directories)
  useEffect(() => {
    directoriesRef.current = directories
  }, [directories])

  const inFlightRef = useRef(new Map<string, Promise<void>>())
  const revisionCounterRef = useRef(0)
  const activeSpaceIdRef = useRef(spaceId)
  activeSpaceIdRef.current = spaceId
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const sourceKindFor = (referenceId: string): FileSystemFolderKind => {
    const root = getItem(projectedTree, referenceId)
    return root !== undefined && isFileSystemFolderKind(root.domainKind)
      ? root.domainKind
      : 'workspace_folder'
  }

  // 核心：按 referenceId + relativePath 拉取目录，revision 守卫丢弃过期响应。
  function fetchByReference(
    referenceId: string,
    relativePath: string,
    mode: 'load' | 'refresh',
  ): Promise<void> {
    const directoryId =
      relativePath === '' ? referenceId : referenceChildId(referenceId, relativePath)
    const key = directoryCacheKey(spaceId, directoryId)
    // load 模式去重；refresh 模式总是重新发起，过期响应靠 revision 丢弃。
    if (mode === 'load' && inFlightRef.current.has(key)) {
      return inFlightRef.current.get(key)!
    }
    const revision = (revisionCounterRef.current += 1)
    const requestSpaceId = spaceId
    const sourceKind = sourceKindFor(referenceId)

    setDirectories((prev) => {
      const prior = prev.get(key)
      const next = new Map(prev)
      next.set(key, {
        spaceId: requestSpaceId,
        status: prior === undefined ? 'loading' : 'refreshing',
        // 刷新保留旧条目，避免整棵树闪烁 / 折叠 / 位移。
        entries: prior?.entries ?? [],
        revision,
        directoryId,
        error: undefined,
      })
      return next
    })

    const request = (async () => {
      const preview = await refreshDocumentPreview(referenceId, relativePath)
      if (activeSpaceIdRef.current !== requestSpaceId) return
      if (preview.content.kind !== 'directory') throw new Error('目标路径不再是文件夹。')
      warmReferenceDirectoryPreviews(referenceId, preview.content.entries)
      const entries = projectReferenceChildren(referenceId, sourceKind, preview.content.entries)
      setDirectories((prev) => {
        const current = prev.get(key)
        // 过期请求：已有更新的 revision 在途 / 完成，丢弃本次结果。
        if (current === undefined || current.revision !== revision) return prev
        const next = new Map(prev)
        next.set(key, { spaceId: requestSpaceId, status: 'ready', entries, revision, directoryId, error: undefined })
        return next
      })
    })()

    const handled = request.catch((error: unknown) => {
      if (activeSpaceIdRef.current !== requestSpaceId) return
      setDirectories((prev) => {
        const current = prev.get(key)
        if (current === undefined || current.revision !== revision) return prev
        const next = new Map(prev)
        if (isReferenceRemovedError(error)) {
          // 引用已被移除：清掉目录缓存，节点随后由投影刷新摘除，不保留错误态。
          next.delete(key)
          return next
        }
        next.set(key, {
          spaceId: requestSpaceId,
          status: 'error',
          entries: current.entries,
          revision,
          directoryId,
          error: actionErrorMessage(error),
        })
        return next
      })
      throw error
    }).finally(() => {
      if (inFlightRef.current.get(key) === handled) inFlightRef.current.delete(key)
    })

    inFlightRef.current.set(key, handled)
    return handled
  }

  function loadDirectory(item: SpaceItem): Promise<void> {
    if (!isLoadableFolder(item)) return Promise.resolve()
    const key = directoryCacheKey(spaceId, directoryIdOf(item))
    if (inFlightRef.current.has(key)) {
      return inFlightRef.current.get(key)!.then(
        () => undefined,
        () => undefined,
      )
    }
    const existing = directoriesRef.current.get(key)
    if (existing !== undefined && existing.status === 'ready') return Promise.resolve()
    return fetchByReference(item.referenceId!, item.relativePath ?? '', 'load').catch(
      (error: unknown) => {
        if (!isReferenceRemovedError(error)) onErrorRef.current?.(actionErrorMessage(error))
      },
    )
  }

  function refreshDirectory(item: SpaceItem): Promise<void> {
    if (!isLoadableFolder(item)) return Promise.resolve()
    return fetchByReference(item.referenceId!, item.relativePath ?? '', 'refresh')
  }

  function refreshByReference(referenceId: string, relativePath: string): Promise<void> {
    return fetchByReference(referenceId, relativePath, 'refresh')
  }

  function refreshParentOf(referenceId: string, childRelativePath: string): Promise<void> {
    const separator = childRelativePath.lastIndexOf('/')
    const parentPath = separator < 0 ? '' : childRelativePath.slice(0, separator)
    return fetchByReference(referenceId, parentPath, 'refresh')
  }

  function toggleExpand(item: SpaceItem): void {
    const opening = !expandedIds.has(item.id)
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
    if (opening && isLoadableFolder(item)) void loadDirectory(item)
  }

  function expandItem(item: SpaceItem): void {
    setExpandedIds((current) =>
      current.has(item.id) ? current : new Set(current).add(item.id),
    )
    if (isLoadableFolder(item)) void loadDirectory(item)
  }

  function refreshAllExpanded(): void {
    const visit = (items: readonly SpaceItem[]) => {
      for (const item of items) {
        if (expandedIds.has(item.id) && isLoadableFolder(item)) {
          void fetchByReference(item.referenceId!, item.relativePath ?? '', 'refresh').catch(
            (error: unknown) => {
              if (!isReferenceRemovedError(error)) onErrorRef.current?.(actionErrorMessage(error))
            },
          )
        }
        if (item.children !== undefined) visit(item.children)
      }
    }
    visit(tree)
  }

  // 合并旧三处 useEffect：把叠加了动态子条目的渲染树只算一次。
  const childrenById = useMemo(() => {
    const map = new Map<string, SpaceItem[]>()
    for (const state of directories.values()) {
      if (state.spaceId !== spaceId) continue
      // ready / refreshing 都要呈现；空目录（ready 但 0 条）也保留以显示空展开。
      if (
        state.entries.length > 0 ||
        state.status === 'ready' ||
        state.status === 'refreshing'
      ) {
        map.set(state.directoryId, state.entries)
      }
    }
    return map
  }, [directories, spaceId])

  // Space identity is part of the rendered tree contract. Clear the previous
  // space's mounted directories before the browser paints; using a passive
  // effect here leaves one frame where the old tree can still be visible.
  useLayoutEffect(() => {
    const nextDirectories = new Map<string, DirectoryState>()
    directoriesRef.current = nextDirectories
    inFlightRef.current.clear()
    setDirectories(nextDirectories)
    setExpandedIds(new Set(initialExpandedIds ?? collectDefaultExpanded(projectedTree)))
    // The reset is intentionally keyed only by identity. Projection updates
    // within one Space must retain mounted directory entries and expansion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId])

  const tree = useMemo(
    () => attachReferenceChildren(projectedTree, childrenById),
    [projectedTree, childrenById],
  )

  // 预取：挂载 / 投影变化时拉取顶层引用目录（与原初始加载一致）。
  useEffect(() => {
    for (const item of projectedTree) {
      if (isLoadableFolder(item)) void loadDirectory(item)
    }
    // loadDirectory 读取 ref，行为稳定；此处只需在投影变化时重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectedTree, spaceId])

  // 展开恢复 / 新展开：遍历渲染树，确保已展开的可加载目录都有数据。
  // 离开空间再返回时，恢复的展开节点在此重新取得目录快照（不依赖过时缓存）。
  useEffect(() => {
    const visit = (items: readonly SpaceItem[]) => {
      for (const item of items) {
        if (expandedIds.has(item.id) && isLoadableFolder(item)) void loadDirectory(item)
        if (item.children !== undefined) visit(item.children)
      }
    }
    visit(tree)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedIds, tree])

  // 窗口重新聚焦：重新取得所有已展开目录的快照。
  useEffect(() => {
    window.addEventListener('focus', refreshAllExpanded)
    return () => window.removeEventListener('focus', refreshAllExpanded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedIds, tree])

  useEffect(() => subscribeWorkbenchProjectionChanges((change) => {
    if (change.owners.includes('mounted_files')) {
      invalidateDocumentPreviews()
      refreshAllExpanded()
    }
    if (change.owners.includes('spaces') && change.referenceIds !== undefined) {
      const removed = new Set(change.referenceIds)
      setDirectories((current) => {
        const next = new Map(current)
        for (const [key, state] of next) {
          if ([...removed].some((id) => state.directoryId === id || state.directoryId.startsWith(`${id}::`))) next.delete(key)
        }
        return next.size === current.size ? current : next
      })
      setExpandedIds((current) => {
        const next = new Set([...current].filter((id) => ![...removed].some((root) => id === root || id.startsWith(`${root}::`))))
        return next.size === current.size ? current : next
      })
    }
  }), [expandedIds, refreshAllExpanded, tree])

  return {
    projectedTree,
    tree,
    directories,
    expandedIds,
    isExpanded: (id: string) => expandedIds.has(id),
    toggleExpand,
    expandItem,
    loadDirectory,
    refreshDirectory,
    refreshByReference,
    refreshParentOf,
    refreshAllExpanded,
  }
}
