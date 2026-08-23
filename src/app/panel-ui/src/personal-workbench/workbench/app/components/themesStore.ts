import { useSyncExternalStore } from 'react'
import {
  executePersonalKnowledgeCommand,
  getPersonalKnowledgeSnapshot,
  subscribePersonalKnowledge,
  type Assignment,
  type Theme,
} from './personalKnowledgeClient'

export type { Assignment, Theme } from './personalKnowledgeClient'

const DEFAULT_COLOR = '#6865a7'
export function getThemes(): Theme[] { return getPersonalKnowledgeSnapshot().themes }
export function getAssignments(): Assignment[] { return getPersonalKnowledgeSnapshot().assignments }
export function themesOf(refId: string): string[] { return getAssignments().filter((value) => value.refId === refId).map((value) => value.themeId) }
export function pagesOf(themeId: string): string[] { return getAssignments().filter((value) => value.themeId === themeId).map((value) => value.refId) }
export function isLocked(refId: string, themeId: string): boolean { return getAssignments().some((value) => value.refId === refId && value.themeId === themeId && value.locked) }
export function assign(refId: string, themeId: string, by: 'agent' | 'user' = 'user'): void {
  if (getAssignments().some((value) => value.refId === refId && value.themeId === themeId)) return
  const assignment = { refId, themeId, by, locked: false }
  executePersonalKnowledgeCommand((value) => ({ ...value, assignments: [...value.assignments, assignment] }), { type: 'theme.assign', assignment })
}
export function unassign(refId: string, themeId: string): void {
  executePersonalKnowledgeCommand(
    (value) => ({ ...value, assignments: value.assignments.filter((item) => item.refId !== refId || item.themeId !== themeId) }),
    { type: 'theme.unassign', refId, themeId },
  )
}
export function toggleLock(refId: string, themeId: string): void {
  executePersonalKnowledgeCommand(
    (value) => ({ ...value, assignments: value.assignments.map((item) => item.refId === refId && item.themeId === themeId ? { ...item, locked: !item.locked } : item) }),
    { type: 'theme.toggle_lock', refId, themeId },
  )
}
export function createTheme(name: string, color = DEFAULT_COLOR): string {
  const id = `theme-${crypto.randomUUID()}`
  const theme: Theme = { id, name: name.trim() || '新主题', color, origin: 'user' }
  executePersonalKnowledgeCommand((value) => ({ ...value, themes: [...value.themes, theme] }), { type: 'theme.create', theme })
  return id
}
export function renameTheme(themeId: string, name: string): void {
  const normalized = name.trim()
  if (normalized.length === 0) return
  executePersonalKnowledgeCommand(
    (value) => ({ ...value, themes: value.themes.map((theme) => theme.id === themeId ? { ...theme, name: normalized } : theme) }),
    { type: 'theme.rename', themeId, name: normalized },
  )
}
export function deleteTheme(themeId: string): void {
  executePersonalKnowledgeCommand(
    (value) => ({ ...value, themes: value.themes.filter((theme) => theme.id !== themeId), assignments: value.assignments.filter((item) => item.themeId !== themeId) }),
    { type: 'theme.delete', themeId },
  )
}
export function mergeTheme(fromId: string, toId: string): void {
  if (fromId === toId) return
  executePersonalKnowledgeCommand((value) => {
    const existing = new Map(value.assignments.filter((item) => item.themeId === toId).map((item) => [item.refId, item]))
    for (const item of value.assignments.filter((candidate) => candidate.themeId === fromId)) {
      const current = existing.get(item.refId)
      existing.set(item.refId, current === undefined ? { ...item, themeId: toId } : { ...current, locked: current.locked || item.locked, by: current.by === 'user' || item.by === 'user' ? 'user' : 'agent' })
    }
    return { ...value, themes: value.themes.filter((theme) => theme.id !== fromId), assignments: [...value.assignments.filter((item) => item.themeId !== fromId && item.themeId !== toId), ...existing.values()] }
  }, { type: 'theme.merge', fromId, toId })
}
export function useThemes() {
  const snapshot = useSyncExternalStore(
    subscribePersonalKnowledge,
    getPersonalKnowledgeSnapshot,
    getPersonalKnowledgeSnapshot,
  )
  return { themes: snapshot.themes, assignments: snapshot.assignments, themesOf, pagesOf, isLocked, assign: (refId: string, themeId: string) => assign(refId, themeId), unassign, toggleLock, createTheme, renameTheme, deleteTheme, mergeTheme }
}