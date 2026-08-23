import type { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'

export function createMarkdownEditorExtensions(placeholder?: string, resolveImageUrl?: (value: string) => string) {
  const image = resolveImageUrl === undefined ? Image : Image.extend({
    renderHTML({ HTMLAttributes }) {
      const source = typeof HTMLAttributes.src === 'string' ? resolveImageUrl(HTMLAttributes.src) : ''
      return ['img', { ...HTMLAttributes, src: source }]
    },
  })
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, codeBlock: { HTMLAttributes: { class: 'aa-code-block' } }, link: false }),
    Link.configure({ openOnClick: false, autolink: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    image.configure({ allowBase64: false }),
    TableKit.configure({ table: { resizable: false } }),
    ...(placeholder === undefined ? [] : [Placeholder.configure({ placeholder })]),
    Markdown.configure({ html: false, transformPastedText: true }),
  ]
}

export function markdownFromEditor(editor: Editor): string {
  return (editor.storage as unknown as Record<string, { getMarkdown: () => string }>).markdown.getMarkdown()
}

export function isEditorUsable(editor: Editor | null): editor is Editor {
  return editor !== null && !editor.isDestroyed
}