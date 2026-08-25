import { ApiError, requestJson } from '@ui/api'
import type { PersonalNoteRevision } from '@panel-api/workbench'
import type { Assignment, BrainLink, BrainPage, Note, Theme } from './personalKnowledgeTypes'
import { subscribeWorkbenchProjectionChanges } from '@ui/workbench/projection-changes'

export type { Assignment, BrainLink, BrainPage, Note, PageKind, Theme } from './personalKnowledgeTypes'
export type { PersonalNoteRevision } from '@panel-api/workbench'

interface Snapshot {
  notes: Note[]
  pages: BrainPage[]
  links: BrainLink[]
  themes: Theme[]
  assignments: Assignment[]
  recentlyOpened: Record<string, number>
}

type PersonalKnowledgeResponse = {
  readonly snapshot: Snapshot
}

export type PersonalKnowledgeLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'retrying' }
  | { readonly status: 'error'; readonly message: string }

export interface PersonalKnowledgeSearchHit {
  readonly note: Omit<Note, 'bodyMarkdown'>
  readonly snippet: string
}

export type PersonalNoteRemoteState =
  | { readonly status: 'current'; readonly note: Note; readonly latestRevision?: PersonalNoteRevision }
  | { readonly status: 'deleted'; readonly latestRevision?: PersonalNoteRevision }

const EMPTY_SNAPSHOT: Snapshot = { notes: [], pages: [], links: [], themes: [], assignments: [], recentlyOpened: {} }
let snapshot: Snapshot = EMPTY_SNAPSHOT
let authoritativeSnapshot: Snapshot = snapshot
let loaded = false
let loading: Promise<void> | undefined
let refreshing: Promise<void> | undefined
let requestedRefreshRevision = 0
let appliedRefreshRevision = 0
let persistenceEnabled = false
let mutationQueue = Promise.resolve()
let lastError: string | undefined
let loadState: PersonalKnowledgeLoadState = { status: 'idle' }
const pendingMutations: PendingMutation[] = []
const pendingNotes = new Map<string, number>()
const noteErrors = new Map<string, string>()
const blockedNoteIds = new Set<string>()
const committedLocalNoteRevisions = new Map<string, number>()
const pendingKnowledgeRefs = new Map<string, number>()
const listeners = new Set<() => void>()
let projectionChangeUnsubscribe: (() => void) | undefined

export function getPersonalKnowledgeSnapshot(): Snapshot { return snapshot }
export function getPersonalKnowledgeError(): string | undefined { return lastError }
export function getPersonalKnowledgeLoadState(): PersonalKnowledgeLoadState { return loadState }
export function isPersonalKnowledgePersistenceEnabled(): boolean { return persistenceEnabled }
export function getPersonalNoteSaveState(noteId: string): string {
  const error = noteErrors.get(noteId)
  if (error !== undefined) return `error:${error}`
  return (pendingNotes.get(noteId) ?? 0) > 0 ? 'saving' : 'saved'
}
export function getCommittedLocalNoteRevision(noteId: string): number | undefined {
  return committedLocalNoteRevisions.get(noteId)
}
export function isPersonalKnowledgeMutationPending(refId: string): boolean {
  return (pendingKnowledgeRefs.get(refId) ?? 0) > 0
}
export function resolvePersonalNoteConflict(noteId: string): void {
  blockedNoteIds.delete(noteId)
  noteErrors.delete(noteId)
  emit()
}

/** 用户主动关闭个人知识错误提示；下一次失败仍会重新出现。 */
export function clearPersonalKnowledgeError(): void {
  if (lastError === undefined) return
  lastError = undefined
  emit()
}
export function subscribePersonalKnowledge(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setPersonalKnowledgePersistenceEnabled(enabled: boolean): void {
  if (persistenceEnabled === enabled) {
    if (enabled) ensureProjectionChangeSubscription()
    return
  }
  persistenceEnabled = enabled
  if (enabled) ensureProjectionChangeSubscription()
  else {
    projectionChangeUnsubscribe?.()
    projectionChangeUnsubscribe = undefined
  }
  loadState = enabled ? (loaded ? { status: 'ready' } : { status: 'idle' }) : { status: 'ready' }
  emit()
}

export async function searchPersonalKnowledge(
  query: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<readonly PersonalKnowledgeSearchHit[]> {
  const normalized = query.trim().toLowerCase()
  if (normalized.length === 0) return []
  if (!persistenceEnabled) {
    return snapshot.notes
      .filter((note) => `${note.title} ${note.bodyMarkdown}`.toLowerCase().includes(normalized))
      .slice(0, limit)
      .map(({ bodyMarkdown, ...note }) => ({ note, snippet: noteSnippet(bodyMarkdown, normalized) }))
  }
  const response = await requestJson<{ results: readonly PersonalKnowledgeSearchHit[] }>(
    `/api/personal-knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    { signal },
  )
  return response.results
}

export async function fetchPersonalNoteRemoteState(noteId: string, signal?: AbortSignal): Promise<PersonalNoteRemoteState> {
  if (!persistenceEnabled) {
    const note = snapshot.notes.find((candidate) => candidate.id === noteId)
    return note === undefined ? { status: 'deleted' } : { status: 'current', note }
  }
  const revisionsPromise = requestJson<{ revisions: readonly PersonalNoteRevision[] }>(
    `/api/personal-knowledge/notes/${encodeURIComponent(noteId)}/revisions?limit=1`,
    { signal },
  )
  try {
    const [noteResponse, revisionsResponse] = await Promise.all([
      requestJson<{ note: Note }>(
        `/api/personal-knowledge/notes/${encodeURIComponent(noteId)}`,
        { signal },
      ),
      revisionsPromise,
    ])
    return { status: 'current', note: noteResponse.note, latestRevision: revisionsResponse.revisions[0] }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      const revisions = await revisionsPromise.catch(() => ({ revisions: [] as readonly PersonalNoteRevision[] }))
      return { status: 'deleted', latestRevision: revisions.revisions[0] }
    }
    throw error
  }
}

export function initializePersonalKnowledge(): Promise<void> {
  if (!persistenceEnabled) {
    loadState = { status: 'ready' }
    emit()
    return Promise.resolve()
  }
  if (loaded) {
    if (loadState.status !== 'ready') {
      loadState = { status: 'ready' }
      emit()
    }
    return Promise.resolve()
  }
  if (loading !== undefined) return loading
  loadState = { status: loadState.status === 'error' ? 'retrying' : 'loading' }
  emit()
  loading = (async () => {
    await refreshPersonalKnowledge()
    loaded = true
    loadState = { status: 'ready' }
    emit()
  })().catch((error: unknown) => {
    const message = messageOf(error)
    lastError = message
    loadState = { status: 'error', message }
    emit()
    throw error
  }).finally(() => { loading = undefined })
  return loading
}

export function refreshPersonalKnowledge(): Promise<void> {
  requestedRefreshRevision += 1
  if (refreshing !== undefined) return refreshing
  refreshing = (async () => {
    while (appliedRefreshRevision < requestedRefreshRevision) {
      const revision = requestedRefreshRevision
      await mutationQueue
      authoritativeSnapshot = await fetchPersonalKnowledgeSnapshot()
      replayPendingMutations()
      appliedRefreshRevision = revision
      lastError = undefined
      emit()
    }
  })().finally(() => { refreshing = undefined })
  return refreshing
}

export function mutatePersonalKnowledge(
  optimistic: (current: Snapshot) => Snapshot,
  request: (authoritative: Snapshot) => Promise<unknown>,
  noteId?: string,
  knowledgeRefId?: string,
): void {
  if (!persistenceEnabled) {
    snapshot = optimistic(snapshot)
    authoritativeSnapshot = snapshot
    lastError = undefined
    emit()
    return
  }
  const mutation: PendingMutation = { optimistic, request, noteId, knowledgeRefId }
  pendingMutations.push(mutation)
  replayPendingMutations()
  if (noteId !== undefined) {
    pendingNotes.set(noteId, (pendingNotes.get(noteId) ?? 0) + 1)
    noteErrors.delete(noteId)
  }
  if (knowledgeRefId !== undefined) pendingKnowledgeRefs.set(knowledgeRefId, (pendingKnowledgeRefs.get(knowledgeRefId) ?? 0) + 1)
  emit()
  mutationQueue = mutationQueue.then(() => executeMutation(mutation))
}

export function createPersonalNote(init?: Partial<Pick<Note, 'spaceId' | 'title' | 'bodyMarkdown'>>): Note {
  const now = Date.now()
  const note: Note = {
    id: crypto.randomUUID(),
    title: '',
    bodyMarkdown: '',
    createdAt: now,
    updatedAt: now,
    revision: 1,
    ...init,
  }
  mutatePersonalKnowledge(
    (current) => ({ ...current, notes: [note, ...current.notes] }),
    () => requestJson('/api/personal-knowledge/notes', {
      method: 'POST',
      body: JSON.stringify({
        id: note.id,
        ...(note.spaceId === undefined ? {} : { spaceId: note.spaceId }),
        title: note.title,
        bodyMarkdown: note.bodyMarkdown,
      }),
    }),
    note.id,
  )
  return note
}

export function updatePersonalNote(id: string, patch: Partial<Pick<Note, 'title' | 'bodyMarkdown'>>): void {
  const current = snapshot.notes.find((note) => note.id === id)
  if (current === undefined) return
  const updatedAt = Date.now()
  mutatePersonalKnowledge(
    (value) => ({ ...value, notes: value.notes.map((note) => note.id === id ? { ...note, ...patch, updatedAt, revision: note.revision + 1 } : note) }),
    (authoritative) => {
      const note = authoritative.notes.find((candidate) => candidate.id === id)
      if (note === undefined) return Promise.reject(new Error('笔记已不存在，无法保存更改。'))
      return requestJson(`/api/personal-knowledge/notes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: note.revision, ...(patch.title === undefined ? {} : { title: patch.title }), ...(patch.bodyMarkdown === undefined ? {} : { bodyMarkdown: patch.bodyMarkdown }) }),
      })
    },
    id,
  )
}

export function deletePersonalNote(id: string): void {
  const note = snapshot.notes.find((candidate) => candidate.id === id)
  if (note === undefined) return
  mutatePersonalKnowledge(
    (value) => ({
      ...value,
      notes: value.notes.filter((candidate) => candidate.id !== id),
      pages: value.pages.filter((page) => page.refId !== id),
      links: value.links.filter((link) => link.from !== id && link.to !== id),
      assignments: value.assignments.filter((assignment) => assignment.refId !== id),
    }),
    (authoritative) => {
      const current = authoritative.notes.find((candidate) => candidate.id === id)
      if (current === undefined) return Promise.reject(new Error('笔记已不存在，无法删除。'))
      return requestJson(`/api/personal-knowledge/notes/${encodeURIComponent(id)}?expectedRevision=${current.revision}`, { method: 'DELETE' })
    },
    id,
  )
}

export function reorderPersonalNotes(orderedIds: string[]): void {
  mutatePersonalKnowledge(
    (value) => {
      const byId = new Map(value.notes.map((note) => [note.id, note]))
      const ordered = orderedIds.flatMap((id) => { const note = byId.get(id); byId.delete(id); return note === undefined ? [] : [note] })
      return { ...value, notes: [...ordered, ...value.notes.filter((note) => byId.has(note.id))] }
    },
    () => requestJson('/api/personal-knowledge/notes/reorder', { method: 'POST', body: JSON.stringify({ orderedIds }) }),
  )
}

export function executePersonalKnowledgeCommand(
  optimistic: (current: Snapshot) => Snapshot,
  command: Record<string, unknown>,
  knowledgeRefId?: string,
): void {
  mutatePersonalKnowledge(optimistic, () => requestJson('/api/personal-knowledge/commands', { method: 'POST', body: JSON.stringify(command) }), undefined, knowledgeRefId)
}

export function spaceReferenceSourceKey(referenceId: string, relativePath = ''): string {
  return `space-reference:${referenceId}:${normalizeSpaceReferenceRelativePath(relativePath)}`
}

export function collectManagedSpaceReference(referenceId: string, relativePath = ''): void {
  const normalizedRelativePath = normalizeSpaceReferenceRelativePath(relativePath)
  const sourceKey = spaceReferenceSourceKey(referenceId, normalizedRelativePath)
  if (!persistenceEnabled) {
    const page: BrainPage = { refId: sourceKey, kind: 'space_reference', collectedAt: Date.now() }
    snapshot = upsertKnowledgePage(snapshot, page)
    authoritativeSnapshot = snapshot
    emit()
    return
  }
  let managedPage: BrainPage | undefined
  mutatePersonalKnowledge(
    (current) => managedPage === undefined ? current : upsertKnowledgePage(current, managedPage),
    async () => {
      const response = await requestJson<{ page: BrainPage }>('/api/personal-knowledge/collect-space-reference', {
        method: 'POST',
        body: JSON.stringify({ referenceId, relativePath: normalizedRelativePath }),
      })
      managedPage = response.page
    },
    undefined,
    sourceKey,
  )
}

function normalizeSpaceReferenceRelativePath(relativePath: string): string {
  return relativePath.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
}

function emit(): void { listeners.forEach((listener) => listener()) }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : '个人知识数据保存失败。' }

interface PendingMutation {
  readonly optimistic: (current: Snapshot) => Snapshot
  readonly request: (authoritative: Snapshot) => Promise<unknown>
  readonly noteId?: string
  readonly knowledgeRefId?: string
}

async function executeMutation(mutation: PendingMutation): Promise<void> {
  try {
    if (mutation.noteId !== undefined && blockedNoteIds.has(mutation.noteId)) return
    await mutation.request(authoritativeSnapshot)
    authoritativeSnapshot = mutation.optimistic(authoritativeSnapshot)
    lastError = undefined
    if (mutation.noteId !== undefined) {
      noteErrors.delete(mutation.noteId)
      const note = authoritativeSnapshot.notes.find((candidate) => candidate.id === mutation.noteId)
      if (note === undefined) committedLocalNoteRevisions.delete(mutation.noteId)
      else committedLocalNoteRevisions.set(mutation.noteId, note.revision)
    }
  } catch (error: unknown) {
    const message = messageOf(error)
    try { authoritativeSnapshot = await fetchPersonalKnowledgeSnapshot() } catch { /* keep the last known server state */ }
    lastError = message
    if (mutation.noteId !== undefined) {
      noteErrors.set(mutation.noteId, message)
      if (error instanceof ApiError && error.status === 409) blockedNoteIds.add(mutation.noteId)
    }
  } finally {
    const index = pendingMutations.indexOf(mutation)
    if (index >= 0) pendingMutations.splice(index, 1)
    finishNoteMutation(mutation.noteId)
    finishKnowledgeMutation(mutation.knowledgeRefId)
    replayPendingMutations()
    emit()
  }
}

function finishKnowledgeMutation(refId: string | undefined): void {
  if (refId === undefined) return
  const next = (pendingKnowledgeRefs.get(refId) ?? 1) - 1
  if (next <= 0) pendingKnowledgeRefs.delete(refId)
  else pendingKnowledgeRefs.set(refId, next)
}

function upsertKnowledgePage(value: Snapshot, page: BrainPage): Snapshot {
  return { ...value, pages: [page, ...value.pages.filter((candidate) => candidate.refId !== page.refId)] }
}

async function fetchPersonalKnowledgeSnapshot(): Promise<Snapshot> {
  const response = await requestJson<PersonalKnowledgeResponse>('/api/personal-knowledge')
  if (response.snapshot === undefined) throw new Error('个人知识响应缺少 snapshot。')
  return response.snapshot
}

function replayPendingMutations(): void {
  snapshot = pendingMutations.reduce((current, mutation) => mutation.optimistic(current), authoritativeSnapshot)
}

function finishNoteMutation(noteId: string | undefined): void {
  if (noteId === undefined) return
  const remaining = (pendingNotes.get(noteId) ?? 1) - 1
  if (remaining <= 0) pendingNotes.delete(noteId)
  else pendingNotes.set(noteId, remaining)
}

function noteSnippet(body: string, query: string): string {
  const flat = body.replace(/\s+/gu, ' ').trim()
  const index = flat.toLowerCase().indexOf(query)
  const start = index < 0 ? 0 : Math.max(0, index - 30)
  const value = flat.slice(start, start + 120)
  return `${start > 0 ? '...' : ''}${value}${start + value.length < flat.length ? '...' : ''}`
}

function ensureProjectionChangeSubscription(): void {
  if (projectionChangeUnsubscribe !== undefined) return
  projectionChangeUnsubscribe = subscribeWorkbenchProjectionChanges((change) => {
    if (!change.owners.includes('personal_knowledge')) return
    if (persistenceEnabled) void refreshPersonalKnowledge().catch(() => undefined)
  })
}
