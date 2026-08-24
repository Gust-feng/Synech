import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { diffLines, type Change } from 'diff'
import { AlertTriangle, Brain, Check, Code2, Maximize2 } from 'lucide-react'
import { EditorContent, useEditor } from '@tiptap/react'
import { useBrain } from './brainStore'
import type { Note } from './notesStore'
import {
  fetchPersonalNoteRemoteState,
  getCommittedLocalNoteRevision,
  getPersonalNoteSaveState,
  isPersonalKnowledgePersistenceEnabled,
  refreshPersonalKnowledge,
  resolvePersonalNoteConflict,
  subscribePersonalKnowledge,
  type PersonalNoteRemoteState,
  type PersonalNoteRevision,
} from './personalKnowledgeClient'
import './note-conflict.css'
import { createMarkdownEditorExtensions, isEditorUsable, markdownFromEditor } from './markdownEditor'

interface NoteEditorProps {
  note: Note
  onSave: (id: string, patch: { title?: string; bodyMarkdown?: string }) => void
  onOpenFocus?: () => void
  onClose?: () => void
  onRestoreAsNew?: (draft: { title: string; bodyMarkdown: string }) => void
}

const AUTOSAVE_MS = 500

export function NoteEditor({ note, onSave, onOpenFocus, onClose, onRestoreAsNew }: NoteEditorProps) {
  const [title, setTitle] = useState(note.title)
  const [saved, setSaved] = useState(true)
  const [sourceMode, setSourceMode] = useState(false)
  const [sourceBody, setSourceBody] = useState(note.bodyMarkdown)
  const [incoming, setIncoming] = useState<PersonalNoteRemoteState>()
  const [showIncomingDiff, setShowIncomingDiff] = useState(false)
  const brain = useBrain()
  const durableSaveState = useSyncExternalStore(
    subscribePersonalKnowledge,
    () => getPersonalNoteSaveState(note.id),
    () => 'saved',
  )
  const collected = brain.isCollected(note.id)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<{ id: string; patch: { title?: string; bodyMarkdown?: string } } | null>(null)
  const onSaveRef = useRef(onSave)
  const baseRevisionRef = useRef(note.revision)
  const noteIdRef = useRef(note.id)
  const titleRef = useRef(title)
  const observedTitleRef = useRef(note.title)
  const sourceBodyRef = useRef(sourceBody)
  const editorBodyRef = useRef(note.bodyMarkdown)
  const sourceModeRef = useRef(sourceMode)
  onSaveRef.current = onSave
  noteIdRef.current = note.id
  titleRef.current = title
  sourceBodyRef.current = sourceBody
  sourceModeRef.current = sourceMode

  function flush() {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    if (pendingRef.current) {
      onSaveRef.current(pendingRef.current.id, pendingRef.current.patch)
      pendingRef.current = null
    }
  }

  function discardPending() {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    pendingRef.current = null
    setSaved(true)
  }

  function scheduleSave(patch: { title?: string; bodyMarkdown?: string }) {
    const id = noteIdRef.current
    const merged = { ...(pendingRef.current?.patch ?? {}), ...patch }
    pendingRef.current = { id, patch: merged }
    setSaved(false)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      onSaveRef.current(id, merged)
      pendingRef.current = null
      saveTimer.current = null
      setSaved(true)
    }, AUTOSAVE_MS)
  }

  const editor = useEditor({
    extensions: createMarkdownEditorExtensions('从这里开始写…'),
    content: note.bodyMarkdown,
    editorProps: { attributes: { class: 'ui-editor-prose', spellcheck: 'false' } },
    onUpdate: ({ editor: value }) => {
      const bodyMarkdown = markdownFromEditor(value)
      editorBodyRef.current = bodyMarkdown
      scheduleSave({ bodyMarkdown })
    },
  })

  function currentDraft() {
    return {
      title: titleRef.current,
      bodyMarkdown: sourceModeRef.current ? sourceBodyRef.current : editorBodyRef.current,
    }
  }

  useEffect(() => {
    flush()
    setTitle(note.title)
    observedTitleRef.current = note.title
    setSourceBody(note.bodyMarkdown)
    setSaved(true)
    setSourceMode(false)
    setIncoming(undefined)
    setShowIncomingDiff(false)
    baseRevisionRef.current = note.revision
    editorBodyRef.current = note.bodyMarkdown
    if (isEditorUsable(editor)) editor.commands.setContent(note.bodyMarkdown, { emitUpdate: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id])

  useEffect(() => {
    if (titleRef.current === observedTitleRef.current) setTitle(note.title)
    observedTitleRef.current = note.title
    const committedLocalRevision = getCommittedLocalNoteRevision(note.id)
    if (committedLocalRevision !== undefined && committedLocalRevision > baseRevisionRef.current) {
      baseRevisionRef.current = committedLocalRevision
    }
    if (note.revision <= baseRevisionRef.current) return
    if (getPersonalNoteSaveState(note.id) !== 'saved') return

    const draft = currentDraft()
    if (note.title === draft.title && note.bodyMarkdown === draft.bodyMarkdown) {
      // A same-content revision needs no conflict choice even when it came
      // from another window.
      baseRevisionRef.current = note.revision
    }
  }, [durableSaveState, note.bodyMarkdown, note.id, note.revision, note.title])

  useEffect(() => {
    if (!isPersonalKnowledgePersistenceEnabled()) return
    let disposed = false
    let checking = false
    const check = async () => {
      if (checking) return
      checking = true
      try {
        if (getPersonalNoteSaveState(note.id) === 'saving') return
        const remote = await fetchPersonalNoteRemoteState(note.id)
        if (disposed) return
        if (getPersonalNoteSaveState(note.id) === 'saving') return
        const committedLocalRevision = getCommittedLocalNoteRevision(note.id)
        if (committedLocalRevision !== undefined && committedLocalRevision > baseRevisionRef.current) {
          baseRevisionRef.current = committedLocalRevision
        }
        if (remote.status === 'deleted') {
          if (remote.latestRevision !== undefined && remote.latestRevision.revision > baseRevisionRef.current) {
            discardPending()
            setIncoming(remote)
          }
          return
        }
        if (remote.note.revision <= baseRevisionRef.current) return
        const draft = currentDraft()
        if (remote.note.title === draft.title && remote.note.bodyMarkdown === draft.bodyMarkdown) {
          baseRevisionRef.current = remote.note.revision
          return
        }
        setIncoming(remote)
      } catch {
        // The normal save indicator owns transport errors; polling never replaces visible content.
      } finally {
        checking = false
      }
    }
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    void check()
    return () => {
      disposed = true
      window.removeEventListener('focus', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, note.revision])

  useEffect(() => flush, [])

  const toggleSourceMode = useCallback(() => {
    if (!isEditorUsable(editor)) return
    if (!sourceMode) {
      setSourceBody(editorBodyRef.current)
      setSourceMode(true)
    } else {
      editor.commands.setContent(sourceBody, { emitUpdate: false })
      editorBodyRef.current = sourceBody
      setSourceMode(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, sourceMode, sourceBody])

  const incomingChanges = useMemo(() => {
    if (!showIncomingDiff || incoming?.status !== 'current') return undefined
    return diffLines(currentDraft().bodyMarkdown, incoming.note.bodyMarkdown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, showIncomingDiff])

  async function useIncomingVersion() {
    if (incoming?.status !== 'current') return
    discardPending()
    resolvePersonalNoteConflict(note.id)
    setTitle(incoming.note.title)
    setSourceBody(incoming.note.bodyMarkdown)
    editorBodyRef.current = incoming.note.bodyMarkdown
    if (isEditorUsable(editor)) editor.commands.setContent(incoming.note.bodyMarkdown, { emitUpdate: false })
    baseRevisionRef.current = incoming.note.revision
    setIncoming(undefined)
    setShowIncomingDiff(false)
    await refreshPersonalKnowledge().catch(() => undefined)
  }

  async function keepLocalVersion() {
    if (incoming?.status !== 'current') return
    const draft = currentDraft()
    discardPending()
    resolvePersonalNoteConflict(note.id)
    await refreshPersonalKnowledge().catch(() => undefined)
    onSaveRef.current(note.id, { title: draft.title, bodyMarkdown: draft.bodyMarkdown })
    baseRevisionRef.current = incoming.note.revision
    setIncoming(undefined)
    setShowIncomingDiff(false)
  }

  async function restoreDeletedDraft() {
    const draft = currentDraft()
    discardPending()
    resolvePersonalNoteConflict(note.id)
    await refreshPersonalKnowledge().catch(() => undefined)
    onRestoreAsNew?.(draft)
  }

  async function closeDeletedDraft() {
    discardPending()
    resolvePersonalNoteConflict(note.id)
    await refreshPersonalKnowledge().catch(() => undefined)
    onClose?.()
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      <header className="shrink-0 flex items-center gap-3 px-5" style={{ height: 48, borderBottom: '1px solid var(--ui-border, rgba(45,40,34,0.09))' }}>
        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: '#6f8778' }} />
        <span className="text-xs shrink-0" style={{ color: 'var(--ui-text-3, #aba39b)' }}>笔记</span>
        <span className="flex items-center gap-1 text-xs shrink-0" style={{ color: 'var(--ui-text-3, #aba39b)' }}>
          {saved && durableSaveState === 'saved' ? <Check size={12} /> : <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: durableSaveState.startsWith('error:') ? '#b85c52' : 'var(--ui-accent, #6865a7)' }} />}
          {durableSaveState.startsWith('error:') ? '保存失败' : saved && durableSaveState === 'saved' ? '已保存' : '保存中…'}
        </span>
        <div className="flex-1" />
        <button onClick={toggleSourceMode} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--ui-hover-tint)]" style={{ color: sourceMode ? 'var(--ui-accent, #6865a7)' : 'var(--ui-text-2, #87827c)' }}>
          <Code2 size={12} />{sourceMode ? '编辑' : '源码'}
        </button>
        {onOpenFocus && <button onClick={onOpenFocus} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--ui-hover-tint)]" style={{ color: 'var(--ui-text-2, #87827c)' }}><Maximize2 size={12} />专注</button>}
        <button onClick={() => (collected ? brain.uncollect(note.id) : brain.collectNote(note.id))} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--ui-hover-tint)]" style={{ color: collected ? 'var(--ui-accent, #6865a7)' : 'var(--ui-text-2, #87827c)' }}>
          <Brain size={12} />{collected ? '已收藏' : '收藏'}
        </button>
      </header>

      {incoming !== undefined && (
        <div className="ui-note-conflict" role="status">
          <AlertTriangle size={14} />
          <div>
            <strong>{incoming.status === 'deleted' ? '这篇笔记已被外部删除' : `${actorLabel(incoming.latestRevision)}更新了这篇笔记`}</strong>
            <span>{incoming.status === 'deleted' ? '当前草稿仍保留在编辑器中。' : '当前内容没有被覆盖，请选择要保留的版本。'}</span>
          </div>
          {incoming.status === 'current' ? (
            <div className="ui-note-conflict__actions">
              <button type="button" onClick={() => setShowIncomingDiff((value) => !value)}>{showIncomingDiff ? '返回编辑' : '比较更改'}</button>
              <button type="button" onClick={() => void keepLocalVersion()}>保留我的版本</button>
              <button type="button" data-primary onClick={() => void useIncomingVersion()}>采用新版</button>
            </div>
          ) : (
            <div className="ui-note-conflict__actions">
              <button type="button" onClick={() => void closeDeletedDraft()}>关闭</button>
              <button type="button" data-primary onClick={() => void restoreDeletedDraft()}>恢复为新笔记</button>
            </div>
          )}
        </div>
      )}

      <div className="shrink-0 mx-auto w-full px-6 pt-8" style={{ maxWidth: 'var(--reading-width, 680px)' }}>
        <input aria-label="笔记名称" value={title} onChange={(event) => { setTitle(event.target.value); scheduleSave({ title: event.target.value }) }} placeholder="无标题" spellCheck={false} className="w-full outline-none bg-transparent reading-prose" style={{ color: 'var(--ui-text-1, #292722)', fontSize: 22, fontWeight: 600 }} />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto px-6 py-4 pb-24" style={{ maxWidth: 'var(--reading-width, 680px)' }}>
          {incomingChanges !== undefined ? <NoteDiff changes={incomingChanges} /> : sourceMode ? (
            <textarea value={sourceBody} onChange={(event) => { setSourceBody(event.target.value); scheduleSave({ bodyMarkdown: event.target.value }) }} className="w-full outline-none bg-transparent resize-none text-sm leading-relaxed" style={{ color: 'var(--ui-text-1, #292722)', minHeight: '60vh', fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace', fontSize: 13, lineHeight: 1.7 }} spellCheck={false} />
          ) : <EditorContent editor={editor} />}
        </div>
      </div>
    </div>
  )
}

function actorLabel(revision: PersonalNoteRevision | undefined): string {
  if (revision?.actor.kind === 'agent') return revision.actor.actorId ? `Agent ${revision.actor.actorId} ` : 'Agent '
  if (revision?.actor.kind === 'user') return '其他窗口'
  return '外部来源'
}

function NoteDiff({ changes }: { changes: readonly Change[] }) {
  return <pre className="ui-note-conflict__diff" aria-label="笔记内容更改">{changes.map((change, index) => <span key={index} data-change={change.added ? 'incoming' : change.removed ? 'local' : 'same'}>{change.value}</span>)}</pre>
}
