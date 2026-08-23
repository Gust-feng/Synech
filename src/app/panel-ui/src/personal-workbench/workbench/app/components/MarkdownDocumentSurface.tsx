import { useEffect, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { createMarkdownEditorExtensions, isEditorUsable, markdownFromEditor } from './markdownEditor'

export function MarkdownDocumentSurface({
  markdown,
  sourceVersion,
  editable = false,
  resolveImageUrl,
  onChange,
}: {
  markdown: string
  sourceVersion: string
  editable?: boolean
  resolveImageUrl?: (value: string) => string
  onChange?: (markdown: string) => void
}) {
  const onChangeRef = useRef(onChange)
  const userEditRef = useRef(false)
  onChangeRef.current = onChange
  const editor = useEditor({
    extensions: createMarkdownEditorExtensions(undefined, resolveImageUrl),
    content: markdown,
    editable,
    editorProps: {
      attributes: { class: 'aa-editor-prose aa-reference-markdown-prose', spellcheck: 'false' },
      handleDOMEvents: {
        beforeinput: () => { userEditRef.current = true; return false },
        paste: () => { userEditRef.current = true; return false },
        drop: () => { userEditRef.current = true; return false },
      },
    },
    onUpdate: ({ editor: value }) => {
      if (userEditRef.current && onChangeRef.current !== undefined) onChangeRef.current(markdownFromEditor(value))
    },
  })

  useEffect(() => {
    if (isEditorUsable(editor)) editor.setEditable(editable)
  }, [editable, editor])

  useEffect(() => {
    if (isEditorUsable(editor)) editor.commands.setContent(markdown, { emitUpdate: false })
    // Local edits must not recreate the document or move the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, sourceVersion])

  return <EditorContent editor={editor} />
}