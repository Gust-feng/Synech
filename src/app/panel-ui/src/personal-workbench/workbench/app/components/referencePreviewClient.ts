import { requestJson } from '../../../../api'
import type { DocumentCaptionUpdateInput, DocumentPreview, DocumentTextUpdateInput } from '../../../../../../panel-api-contracts'

export type { DocumentPreview } from '../../../../../../panel-api-contracts'

const MAX_CACHED_PREVIEWS = 64
const previewCache = new Map<string, DocumentPreview>()
const previewGeneration = new Map<string, number>()
const previewMutationInFlight = new Map<string, Promise<DocumentPreview>>()
const previewReadInFlight = new Map<string, { readonly generation: number; readonly request: Promise<DocumentPreview> }>()
const previewErrors = new Map<string, string>()
const previewListeners = new Map<string, Set<() => void>>()
const previewCacheVersions = new Map<string, number>()
const pendingPreviewNotifications = new Set<string>()
let previewNotificationTimer: ReturnType<typeof setTimeout> | undefined

export function subscribeReferencePreviewCache(listener: () => void, apiBase = '/api/spaces/references'): () => void {
  const listeners = previewListeners.get(apiBase) ?? new Set<() => void>()
  listeners.add(listener)
  previewListeners.set(apiBase, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) previewListeners.delete(apiBase)
  }
}

export function getReferencePreviewCacheVersion(apiBase = '/api/spaces/references'): number {
  return previewCacheVersions.get(apiBase) ?? 0
}

export function getReferencePreviewError(itemId: string, relativePath = '', apiBase = '/api/spaces/references'): string | undefined {
  return previewErrors.get(previewCacheKey(apiBase, itemId, relativePath))
}

export function getCachedReferencePreview(itemId: string, relativePath = '', apiBase = '/api/spaces/references'): DocumentPreview | undefined {
  const key = previewCacheKey(apiBase, itemId, relativePath)
  const value = previewCache.get(key)
  if (value !== undefined) {
    previewCache.delete(key)
    previewCache.set(key, value)
  }
  return value
}

export function invalidateDocumentPreviews(
  itemIds?: readonly string[],
  apiBase = '/api/spaces/references',
): void {
  const itemPrefixes = itemIds?.map((itemId) => `${apiBase}:${itemId}:`)
  const apiPrefix = `${apiBase}:`
  const keys = new Set([
    ...previewCache.keys(),
    ...previewGeneration.keys(),
    ...previewErrors.keys(),
  ])
  let changed = false
  let affected = false
  for (const key of keys) {
    const keyAffected = itemPrefixes === undefined
      ? key.startsWith(apiPrefix)
      : itemPrefixes.some((prefix) => key.startsWith(prefix))
    if (!keyAffected) continue
    affected = true
    changed = previewCache.delete(key) || previewErrors.delete(key) || changed
    advanceGeneration(key)
  }
  if (changed || affected) schedulePreviewNotification(apiBase)
}

export async function fetchDocumentPreview(
  itemId: string,
  relativePath = '',
  signal?: AbortSignal,
  apiBase = '/api/spaces/references',
): Promise<DocumentPreview> {
  const key = previewCacheKey(apiBase, itemId, relativePath)
  const mutation = previewMutationInFlight.get(key)
  if (mutation !== undefined) {
    try { return await mutation } catch { /* read the authoritative source after a failed write */ }
  }
  if (!previewGeneration.has(key)) previewGeneration.set(key, 0)
  const generation = previewGeneration.get(key)!
  const inFlight = previewReadInFlight.get(key)
  if (inFlight?.generation === generation) return await withAbort(inFlight.request, signal)
  const query = relativePath.length === 0 ? '' : `?path=${encodeURIComponent(relativePath)}`
  let request!: Promise<DocumentPreview>
  request = (async () => {
    const response = await requestJson<{ preview: DocumentPreview }>(
      `${apiBase}/${encodeURIComponent(itemId)}/preview${query}`,
      { headers: { accept: 'application/json' } },
    )
    if ((previewGeneration.get(key) ?? 0) !== generation) {
      const currentMutation = previewMutationInFlight.get(key)
      if (currentMutation !== undefined) {
        try { return await currentMutation } catch { /* fall through */ }
      }
      const newerRead = previewReadInFlight.get(key)
      if (newerRead !== undefined && newerRead.request !== request) return await newerRead.request
      return getCachedReferencePreview(itemId, relativePath, apiBase)
        ?? await fetchDocumentPreview(itemId, relativePath, signal, apiBase)
    }
    setCachedPreview(apiBase, key, response.preview)
    return response.preview
  })().catch((error: unknown) => {
    if (!isAbortError(error)) {
      const message = error instanceof Error ? error.message : '预览读取失败。'
      if (previewErrors.get(key) !== message) {
        previewErrors.set(key, message)
        schedulePreviewNotification(apiBase)
      }
    }
    throw error
  }).finally(() => {
    if (previewReadInFlight.get(key)?.request === request) previewReadInFlight.delete(key)
  })
  previewReadInFlight.set(key, { generation, request })
  return await withAbort(request, signal)
}

export async function refreshDocumentPreview(itemId: string, relativePath = '', signal?: AbortSignal, apiBase = '/api/spaces/references'): Promise<DocumentPreview> {
  invalidatePreviewKey(apiBase, itemId, relativePath)
  return await fetchDocumentPreview(itemId, relativePath, signal, apiBase)
}

export function primeReferencePreviewCache(previews: readonly DocumentPreview[], apiBase = '/api/spaces/references'): void {
  for (const preview of previews) {
    setCachedPreview(apiBase, previewCacheKey(apiBase, preview.itemId, ''), preview)
  }
}

export async function saveDocumentText(
  itemId: string,
  input: DocumentTextUpdateInput,
  apiBase = '/api/spaces/references',
): Promise<DocumentPreview> {
  const relativePath = input.relativePath ?? ''
  const key = previewCacheKey(apiBase, itemId, relativePath)
  const generation = advanceGeneration(key)
  let request!: Promise<DocumentPreview>
  request = requestJson<{ preview: DocumentPreview }>(
    `${apiBase}/${encodeURIComponent(itemId)}/content`,
    {
      method: 'PUT',
      headers: { accept: 'application/json' },
      body: JSON.stringify(input),
    },
  ).then((response) => {
    if ((previewGeneration.get(key) ?? 0) === generation) setCachedPreview(apiBase, key, response.preview)
    return response.preview
  }).finally(() => {
    if (previewMutationInFlight.get(key) === request) previewMutationInFlight.delete(key)
  })
  previewMutationInFlight.set(key, request)
  return await request
}

export async function saveDocumentCaption(
  itemId: string,
  input: DocumentCaptionUpdateInput,
  apiBase = '/api/spaces/references',
): Promise<DocumentPreview> {
  const relativePath = input.relativePath ?? ''
  const key = previewCacheKey(apiBase, itemId, relativePath)
  const generation = advanceGeneration(key)
  let request!: Promise<DocumentPreview>
  request = requestJson<{ preview: DocumentPreview }>(
    `${apiBase}/${encodeURIComponent(itemId)}/caption`,
    {
      method: 'PUT',
      headers: { accept: 'application/json' },
      body: JSON.stringify(input),
    },
  ).then((response) => {
    if ((previewGeneration.get(key) ?? 0) === generation) setCachedPreview(apiBase, key, response.preview)
    return response.preview
  }).finally(() => {
    if (previewMutationInFlight.get(key) === request) previewMutationInFlight.delete(key)
  })
  previewMutationInFlight.set(key, request)
  return await request
}

export async function renameSpaceReferenceEntry(itemId: string, relativePath: string, name: string): Promise<string> {
  const body = await mutateReferenceEntry(itemId, 'PATCH', { relativePath, name }) as { entry?: { relativePath?: string } }
  if (body.entry?.relativePath === undefined) throw new Error('文件重命名响应无效。')
  invalidateDocumentPreviews([itemId])
  return body.entry.relativePath
}

export async function deleteSpaceReferenceEntry(itemId: string, relativePath: string): Promise<void> {
  await mutateReferenceEntry(itemId, 'DELETE', { relativePath })
  invalidateDocumentPreviews([itemId])
}

export async function createSpaceReferenceEntry(itemId: string, parentRelativePath: string, name: string, kind: 'file' | 'directory' = 'file'): Promise<string> {
  const body = await mutateReferenceEntry(itemId, 'POST', { parentRelativePath, name, kind }) as { entry?: { relativePath?: string } }
  if (body.entry?.relativePath === undefined) throw new Error('新建文件响应无效。')
  invalidateDocumentPreviews([itemId])
  return body.entry.relativePath
}

async function mutateReferenceEntry(itemId: string, method: 'POST' | 'PATCH' | 'DELETE', input: object): Promise<object> {
  return await requestJson<object>(`/api/spaces/references/${encodeURIComponent(itemId)}/entry`, {
    method,
    headers: { accept: 'application/json' },
    body: JSON.stringify(input),
  })
}

function invalidatePreviewKey(apiBase: string, itemId: string, relativePath: string): void {
  const key = previewCacheKey(apiBase, itemId, relativePath)
  if (previewCache.delete(key)) schedulePreviewNotification(apiBase)
  advanceGeneration(key)
}

function advanceGeneration(key: string): number {
  const generation = (previewGeneration.get(key) ?? 0) + 1
  previewGeneration.set(key, generation)
  return generation
}

function previewCacheKey(apiBase: string, itemId: string, relativePath: string): string {
  return `${apiBase}:${itemId}:${relativePath}`
}

function setCachedPreview(apiBase: string, key: string, preview: DocumentPreview): void {
  const hadError = previewErrors.delete(key)
  const previous = previewCache.get(key)
  if (previous !== undefined && previewsEqual(previous, preview)) {
    if (hadError) schedulePreviewNotification(apiBase)
    return
  }
  previewCache.delete(key)
  previewCache.set(key, preview)
  while (previewCache.size > MAX_CACHED_PREVIEWS) previewCache.delete(previewCache.keys().next().value!)
  schedulePreviewNotification(apiBase)
}

function previewsEqual(left: DocumentPreview, right: DocumentPreview): boolean {
  if (left.fingerprint !== right.fingerprint || left.modifiedAt !== right.modifiedAt || left.content.kind !== right.content.kind) return false
  if (left.content.kind === 'text' && right.content.kind === 'text') return left.content.text === right.content.text
  if (left.content.kind === 'directory' && right.content.kind === 'directory') {
    const rightEntries = right.content.entries
    return left.content.relativePath === right.content.relativePath
      && left.content.entries.length === right.content.entries.length
      && left.content.entries.every((entry, index) => {
        const candidate = rightEntries[index]
        return candidate?.name === entry.name && candidate.relativePath === entry.relativePath && candidate.kind === entry.kind
      })
  }
  return JSON.stringify(left.content) === JSON.stringify(right.content)
}

function schedulePreviewNotification(apiBase: string): void {
  previewCacheVersions.set(apiBase, (previewCacheVersions.get(apiBase) ?? 0) + 1)
  pendingPreviewNotifications.add(apiBase)
  if (previewNotificationTimer !== undefined) return
  previewNotificationTimer = setTimeout(() => {
    previewNotificationTimer = undefined
    const apiBases = [...pendingPreviewNotifications]
    pendingPreviewNotifications.clear()
    apiBases.forEach((base) => previewListeners.get(base)?.forEach((listener) => listener()))
  }, 16)
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
