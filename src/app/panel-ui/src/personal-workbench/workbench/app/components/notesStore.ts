import { useSyncExternalStore } from 'react'
import {
  createPersonalNote,
  deletePersonalNote,
  getPersonalKnowledgeSnapshot,
  reorderPersonalNotes,
  subscribePersonalKnowledge,
  updatePersonalNote,
  type Note,
} from './personalKnowledgeClient'

export type { Note } from './personalKnowledgeClient'

export function getAllNotes(): Note[] {
  return getPersonalKnowledgeSnapshot().notes
}

export function getNote(id: string): Note | undefined {
  return getAllNotes().find((note) => note.id === id)
}

export function createNote(init?: Partial<Pick<Note, 'spaceId' | 'title' | 'bodyMarkdown'>>): Note {
  return createPersonalNote(init)
}

export function updateNote(id: string, patch: Partial<Pick<Note, 'title' | 'bodyMarkdown'>>): void {
  updatePersonalNote(id, patch)
}

export function deleteNote(id: string): void {
  deletePersonalNote(id)
}

export function reorderNotes(orderedIds: string[]): void {
  reorderPersonalNotes(orderedIds)
}

export function useNotes() {
  const notes = useSyncExternalStore(subscribePersonalKnowledge, getAllNotes, getAllNotes)
  return {
    notes,
    create: createNote,
    update: updateNote,
    remove: deleteNote,
    reorder: reorderNotes,
  }
}
