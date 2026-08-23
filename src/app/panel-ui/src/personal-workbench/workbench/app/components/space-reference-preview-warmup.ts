import type { PersonalSpaceItemProjection, PersonalSpaceProjection } from '../../../space'
import { prefetchDocumentSurface } from './documentPreviewWarmup'
import { fetchDocumentPreview, getCachedReferencePreview, type DocumentPreview } from './referencePreviewClient'

const MAX_STARTUP_FILE_PREVIEWS = 12
const MAX_STARTUP_FOLDERS = 4
const MAX_FOLDER_FILE_PREVIEWS = 32
const MAX_CONCURRENT_PREVIEWS = 2

type ReferencePreviewTarget = {
  readonly referenceId: string
  readonly relativePath: string
}

type StartupPreviewPlan = {
  readonly fileTargets: readonly ReferencePreviewTarget[]
  readonly folderTargets: readonly ReferencePreviewTarget[]
}

type ReferenceDirectoryEntry = {
  readonly name: string
  readonly relativePath: string
  readonly kind: 'file' | 'directory' | 'other'
}

/**
 * Selects a small startup working set from the authoritative Space projection.
 * File-system folders are expanded only one level after their root preview is
 * read, so a large workspace never turns application startup into a full scan.
 */
export function collectStartupReferencePreviewPlan(
  spaces: readonly PersonalSpaceProjection[],
): StartupPreviewPlan {
  const fileTargets: ReferencePreviewTarget[] = []
  const folderTargets: ReferencePreviewTarget[] = []
  const filePriorities = new Map<string, number>()
  const seen = new Set<string>()

  const add = (targets: ReferencePreviewTarget[], item: PersonalSpaceItemProjection, priority?: number) => {
    const target = { referenceId: item.referenceId ?? item.itemId, relativePath: '' }
    const key = `${target.referenceId}\u0000${target.relativePath}`
    if (seen.has(key)) return
    seen.add(key)
    if (priority !== undefined) filePriorities.set(key, priority)
    targets.push(target)
  }

  const visit = (items: readonly PersonalSpaceItemProjection[]) => {
    for (const item of items) {
      if (item.kind === 'folder') {
        if (item.children !== undefined) visit(item.children)
        continue
      }
      if (item.openable === false || item.kind === 'generated_artifact') continue
      if (item.kind === 'workspace_folder' || item.kind === 'managed_folder') {
        if (folderTargets.length < MAX_STARTUP_FOLDERS) add(folderTargets, item)
        continue
      }
      if (fileTargets.length < MAX_STARTUP_FILE_PREVIEWS) add(fileTargets, item, previewPriority(item.title))
    }
  }

  spaces.forEach((space) => visit(space.items))
  fileTargets.sort((left, right) => (
    (filePriorities.get(`${left.referenceId}\u0000${left.relativePath}`) ?? 4)
    - (filePriorities.get(`${right.referenceId}\u0000${right.relativePath}`) ?? 4)
  ))
  return { fileTargets, folderTargets }
}

/**
 * Begins after the Space projection reaches the Workbench. The returned
 * disposer stops future queue work when a newer projection supersedes it.
 */
export function warmStartupReferencePreviews(
  spaces: readonly PersonalSpaceProjection[],
): () => void {
  const plan = collectStartupReferencePreviewPlan(spaces)
  if (plan.fileTargets.length === 0 && plan.folderTargets.length === 0) return () => undefined

  let stopped = false
  const timer = window.setTimeout(() => {
    void warmPlan(plan, () => stopped)
  }, 0)

  return () => {
    stopped = true
    window.clearTimeout(timer)
  }
}

export function warmReferenceDirectoryPreviews(
  referenceId: string,
  entries: readonly ReferenceDirectoryEntry[],
): void {
  const targets = collectReferenceDirectoryTargets(referenceId, entries, MAX_FOLDER_FILE_PREVIEWS)
  void runPreviewQueue(targets, () => false)
}

async function warmPlan(plan: StartupPreviewPlan, isStopped: () => boolean): Promise<void> {
  await runPreviewQueue(plan.fileTargets, isStopped)
  if (isStopped()) return

  const folders = await runPreviewQueue(plan.folderTargets, isStopped)
  if (isStopped()) return

  const childTargets = collectFolderFileTargets(folders)
  await runPreviewQueue(childTargets, isStopped)
}

async function runPreviewQueue(
  targets: readonly ReferencePreviewTarget[],
  isStopped: () => boolean,
): Promise<DocumentPreview[]> {
  const previews: DocumentPreview[] = []
  let cursor = 0

  const worker = async () => {
    while (!isStopped()) {
      const target = targets[cursor]
      cursor += 1
      if (target === undefined) return
      const preview = await warmPreview(target).catch(() => undefined)
      if (preview !== undefined) previews.push(preview)
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_PREVIEWS, targets.length) },
    () => worker(),
  ))
  return previews
}

function collectFolderFileTargets(previews: readonly DocumentPreview[]): ReferencePreviewTarget[] {
  const targets: ReferencePreviewTarget[] = []
  const seen = new Set<string>()

  for (const preview of previews) {
    if (preview.content.kind !== 'directory') continue
    for (const target of collectReferenceDirectoryTargets(
      preview.itemId,
      preview.content.entries,
      MAX_FOLDER_FILE_PREVIEWS - targets.length,
    )) {
      const key = `${target.referenceId}\u0000${target.relativePath}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push(target)
    }
    if (targets.length === MAX_FOLDER_FILE_PREVIEWS) break
  }

  return targets
}

function collectReferenceDirectoryTargets(
  referenceId: string,
  entries: readonly ReferenceDirectoryEntry[],
  limit: number,
): ReferencePreviewTarget[] {
  return entries
    .filter((entry) => entry.kind === 'file')
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => previewPriority(left.entry.name) - previewPriority(right.entry.name) || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map(({ entry }) => ({ referenceId, relativePath: entry.relativePath }))
}

function previewPriority(name: string): number {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (['mp4', 'webm', 'mov', 'm4v'].includes(extension)) return 0
  if (extension === 'pdf') return 1
  if (['docx', 'xlsx'].includes(extension)) return 2
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(extension)) return 3
  return 4
}

async function warmPreview(target: ReferencePreviewTarget): Promise<DocumentPreview> {
  const preview = getCachedReferencePreview(target.referenceId, target.relativePath)
    ?? await fetchDocumentPreview(target.referenceId, target.relativePath)
  prefetchDocumentSurface(preview)
  return preview
}
