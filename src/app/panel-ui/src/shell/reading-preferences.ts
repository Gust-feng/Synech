import { panelStorageKey } from './local-preferences'

export type ReadingFont = 'sans' | 'serif'
export type ReadingWidth = 'narrow' | 'standard' | 'wide'
export type ReadingSize = 'small' | 'medium' | 'large'

export interface ReadingPrefs {
  readonly font: ReadingFont
  readonly width: ReadingWidth
  readonly size: ReadingSize
  readonly sizePx?: number
}

const STORAGE_KEY = panelStorageKey('reading.preferences')
const DEFAULTS: ReadingPrefs = { font: 'sans', width: 'standard', size: 'medium' }

export const WIDTH_PX: Record<ReadingWidth, number> = {
  narrow: 560,
  standard: 680,
  wide: 820,
}

export const SIZE_PX: Record<ReadingSize, number> = {
  small: 15,
  medium: 16,
  large: 18,
}

export const READING_SIZE_MIN_PX = 14
export const READING_SIZE_MAX_PX = 24
export const READING_SIZE_STEP_PX = 1

const READING_PREFERENCES_CHANGED_EVENT = 'ui:reading-preferences-changed'

export function loadPrefs(): ReadingPrefs {
  if (typeof window === 'undefined') return DEFAULTS
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ReadingPrefs>
    const sizePx = normalizeSizePx(parsed.sizePx)
    return {
      font: parsed.font === 'serif' ? 'serif' : 'sans',
      width: parsed.width === 'narrow' || parsed.width === 'wide' ? parsed.width : 'standard',
      size: parsed.size === 'small' || parsed.size === 'large' ? parsed.size : 'medium',
      ...(sizePx === undefined ? {} : { sizePx }),
    }
  } catch {
    return DEFAULTS
  }
}

export function readingBodySizePx(prefs: ReadingPrefs): number {
  return prefs.sizePx === undefined ? SIZE_PX[prefs.size] : normalizeSizePx(prefs.sizePx) ?? SIZE_PX[prefs.size]
}

export function applyPrefs(prefs: ReadingPrefs): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--reading-font', prefs.font === 'serif' ? 'var(--reading-serif)' : 'var(--reading-sans)')
  root.style.setProperty('--reading-width', `${WIDTH_PX[prefs.width]}px`)
  root.style.setProperty('--reading-body-size', `${readingBodySizePx(prefs)}px`)
}

export function savePrefs(prefs: ReadingPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // The preference still applies for the current window when storage is unavailable.
  }
  applyPrefs(prefs)
  dispatchReadingPreferencesChanged()
}

export function adjustReadingSize(direction: -1 | 1): ReadingPrefs {
  const current = loadPrefs()
  const nextSizePx = clampSizePx(readingBodySizePx(current) + direction * READING_SIZE_STEP_PX)
  const next = prefsAtSize(current, nextSizePx)
  savePrefs(next)
  return next
}

export function handleReadingSizeWheel(event: Pick<WheelEvent, 'ctrlKey' | 'deltaY' | 'preventDefault'>): boolean {
  if (!event.ctrlKey || event.deltaY === 0) return false
  event.preventDefault()
  adjustReadingSize(event.deltaY < 0 ? 1 : -1)
  return true
}

export function subscribeReadingPreferencesChanged(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener(READING_PREFERENCES_CHANGED_EVENT, callback)
  return () => window.removeEventListener(READING_PREFERENCES_CHANGED_EVENT, callback)
}

function prefsAtSize(current: ReadingPrefs, sizePx: number): ReadingPrefs {
  const preset = (Object.entries(SIZE_PX) as [ReadingSize, number][]).find(([, value]) => value === sizePx)
  if (preset !== undefined) {
    return { font: current.font, width: current.width, size: preset[0] }
  }
  return { ...current, sizePx }
}

function normalizeSizePx(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return clampSizePx(Math.round(value))
}

function clampSizePx(value: number): number {
  return Math.min(READING_SIZE_MAX_PX, Math.max(READING_SIZE_MIN_PX, value))
}

function dispatchReadingPreferencesChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(READING_PREFERENCES_CHANGED_EVENT))
}
