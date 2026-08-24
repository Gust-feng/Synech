import { panelStorageKey } from './local-preferences'

export type ResponsivenessIncident = {
  readonly id: string
  readonly occurredAt: string
  readonly durationMs: number
  readonly context: string
}

const STORAGE_KEY = panelStorageKey('diagnostics.responsiveness-incidents')
const LONG_TASK_THRESHOLD_MS = 100
const MAX_INCIDENTS = 32

let incidents = readStoredIncidents()
let observer: PerformanceObserver | undefined
let nextIncidentId = 0
let nextContextId = 0
const listeners = new Set<() => void>()
const contexts: Array<{ readonly id: number; readonly label: string }> = []

export function startPanelResponsivenessDiagnostics(): () => void {
  if (observer !== undefined || typeof PerformanceObserver === 'undefined') return () => undefined
  observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < LONG_TASK_THRESHOLD_MS) continue
      recordResponsivenessIncident(entry.duration, currentResponsivenessContext())
    }
  })
  try {
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    observer.disconnect()
    observer = undefined
  }
  return () => {
    observer?.disconnect()
    observer = undefined
  }
}

export function pushResponsivenessContext(label: string): () => void {
  const context = { id: ++nextContextId, label }
  contexts.push(context)
  return () => {
    const index = contexts.findIndex((candidate) => candidate.id === context.id)
    if (index >= 0) contexts.splice(index, 1)
  }
}

export function recordResponsivenessIncident(durationMs: number, context = currentResponsivenessContext()): void {
  const incident: ResponsivenessIncident = {
    id: `responsiveness-${Date.now()}-${++nextIncidentId}`,
    occurredAt: new Date().toISOString(),
    durationMs: Math.round(durationMs),
    context,
  }
  incidents = [incident, ...incidents].slice(0, MAX_INCIDENTS)
  persistIncidents(incidents)
  for (const listener of listeners) listener()
}

export function clearResponsivenessIncidents(): void {
  incidents = []
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Diagnostics must never affect the workbench interaction path.
  }
  for (const listener of listeners) listener()
}

export function getResponsivenessIncidents(): readonly ResponsivenessIncident[] {
  return incidents
}

export function subscribeResponsivenessIncidents(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function currentResponsivenessContext(): string {
  return contexts.at(-1)?.label ?? document.querySelector('main')?.getAttribute('aria-label') ?? 'Workbench'
}

function readStoredIncidents(): readonly ResponsivenessIncident[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): ResponsivenessIncident[] => {
      if (value === null || typeof value !== 'object') return []
      const candidate = value as Partial<Record<keyof ResponsivenessIncident, unknown>>
      if (
        typeof candidate.id !== 'string'
        || typeof candidate.occurredAt !== 'string'
        || typeof candidate.durationMs !== 'number'
        || typeof candidate.context !== 'string'
      ) return []
      return [{
        id: candidate.id,
        occurredAt: candidate.occurredAt,
        durationMs: candidate.durationMs,
        context: candidate.context,
      }]
    }).slice(0, MAX_INCIDENTS)
  } catch {
    return []
  }
}

function persistIncidents(next: readonly ResponsivenessIncident[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // A full or disabled local store cannot be allowed to make the UI slower.
  }
}
