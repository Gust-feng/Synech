import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { getWarmedImageUrl } from './imagePreviewRuntime'

export function ImageDocumentSurface({
  url,
  sourceVersion,
  alt,
  caption,
  editable = false,
  onCaptionChange,
}: {
  readonly url: string
  readonly sourceVersion?: string
  readonly alt: string
  readonly caption?: string
  readonly editable?: boolean
  readonly onCaptionChange?: (caption: string) => Promise<void>
}) {
  const sourceKey = `${url}\u0000${sourceVersion ?? ''}`
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const editorRef = useRef<HTMLParagraphElement>(null)
  const draftRef = useRef(caption ?? '')
  const skipNextCommitRef = useRef(false)

  useLayoutEffect(() => {
    draftRef.current = caption ?? ''
    if (editorRef.current !== null && document.activeElement !== editorRef.current) {
      editorRef.current.textContent = caption ?? ''
    }
  }, [caption])

  useEffect(() => {
    if (!editing) return
    const editor = editorRef.current
    if (editor === null) return
    editor.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [editing])

  function beginEditing() {
    if (!editable || onCaptionChange === undefined || saving) return
    draftRef.current = caption ?? ''
    setError(undefined)
    setEditing(true)
  }

  async function commit() {
    if (skipNextCommitRef.current) {
      skipNextCommitRef.current = false
      return
    }
    if ((!editing && !caption) || saving || onCaptionChange === undefined) return
    setSaving(true)
    try {
      await onCaptionChange(draftRef.current)
      setError(undefined)
      setEditing(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '图片说明保存失败。')
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    if (saving) return
    draftRef.current = caption ?? ''
    if (editorRef.current !== null) editorRef.current.textContent = caption ?? ''
    skipNextCommitRef.current = true
    setError(undefined)
    setEditing(false)
    editorRef.current?.blur()
  }

  function handleInput(event: React.FormEvent<HTMLParagraphElement>) {
    draftRef.current = event.currentTarget.textContent ?? ''
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLParagraphElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  }

  const showCaptionEntry = editable && !caption && !editing && !saving

  return (
    <div
      className={`aa-reference-preview__media${caption || editable ? ' aa-reference-preview__media--described' : ''}${editable ? ' aa-reference-preview__media--caption-editable' : ''}`}
      data-document-scroll="content"
    >
      <StableImage key={sourceKey} url={url} sourceVersion={sourceVersion} alt={alt} />
      {showCaptionEntry ? (
        <button className="aa-reference-preview__caption-add" type="button" onClick={beginEditing}>
          <Plus size={13} aria-hidden="true" />
          <span>添加图片说明</span>
        </button>
      ) : (caption || editing || saving) && <p
        ref={editorRef}
        className="aa-reference-preview__caption-text"
        contentEditable={editable && !saving}
        spellCheck={false}
        suppressContentEditableWarning
        role={editable && !saving ? 'textbox' : undefined}
        aria-label={editable && !saving ? '图片说明' : undefined}
        onClick={(event) => event.stopPropagation()}
        onFocus={() => {
          if (editable && !saving) {
            setError(undefined)
            setEditing(true)
          }
        }}
        onInput={handleInput}
        onBlur={() => void commit()}
        onKeyDown={handleKeyDown}
      >{editable ? null : caption}</p>}
      {error && <span className="aa-reference-preview__caption-status" role="alert">{error}</span>}
    </div>
  )
}

function StableImage({
  url,
  sourceVersion,
  alt,
}: {
  readonly url: string
  readonly sourceVersion?: string
  readonly alt: string
}) {
  // Pick the warmed source once per source version. A later cache fill must not
  // replace the mounted image URL and trigger a second decode/repaint.
  const [displayUrl] = useState(() => getWarmedImageUrl(url, sourceVersion) ?? url)
  return <img src={displayUrl} alt={alt} />
}
