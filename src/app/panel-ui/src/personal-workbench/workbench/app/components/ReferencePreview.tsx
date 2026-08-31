import { Fragment, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ForwardedRef, type ReactNode, type UIEvent } from 'react'
import { diffLines, type Change } from 'diff'
import { AlertTriangle, Check, ChevronRight, Clipboard, Code2, ExternalLink, FileText, Folder, RefreshCw } from 'lucide-react'
import { fetchDocumentPreview, getCachedReferencePreview, refreshDocumentPreview, saveDocumentCaption, saveDocumentText, subscribeReferencePreviewCache, type DocumentPreview } from './referencePreviewClient'
import type { SpaceReferenceAnnotation } from '@panel-api/spaces'
import { MarkdownDocumentSurface } from './MarkdownDocumentSurface'
import { CodeDocumentSurface } from './CodeDocumentSurface'
import { PdfDocumentSurface } from './PdfDocumentSurface'
import { VideoDocumentSurface } from './VideoDocumentSurface'
import { ImageDocumentSurface } from './ImageDocumentSurface'
import { DocxDocumentSurface } from './DocxDocumentSurface'
import { SpreadsheetDocumentSurface } from './SpreadsheetDocumentSurface'
import { isMarkdownDocument } from './documentProjection'
import './reference-preview.css'

const AUTOSAVE_MS = 500
const MAX_DOCUMENT_VIEW_MEMORY = 128
type DocumentScrollSurface = 'content' | 'source' | 'diff'
type DocumentViewMemory = {
  sourceMode: boolean
  scrollTop: Partial<Record<DocumentScrollSurface, number>>
}
const documentViewMemory = new Map<string, DocumentViewMemory>()
type PendingReferenceSave = {
  readonly epoch: number
  readonly itemId: string
  readonly relativePath: string
  readonly text: string
}
export type ReferencePreviewHandle = { readonly flush: () => Promise<void>; readonly discard: () => void }
type ReferenceDocumentSessionProps = {
  itemId: string
  initialRelativePath?: string
  fallbackTitle: string
  canOpen: boolean
  onOpen: () => void
  actions?: ReactNode
  apiBase?: string
  readOnly?: boolean
  onNavigatePath?: (relativePath: string) => void
}

export const ReferencePreview = forwardRef<ReferencePreviewHandle, {
  itemId: string
  initialRelativePath?: string
  fallbackTitle: string
  canOpen: boolean
  onOpen: () => void
  actions?: ReactNode
  apiBase?: string
  readOnly?: boolean
  onNavigatePath?: (relativePath: string) => void
  embedded?: boolean
}>(function ReferencePreview({
  itemId,
  initialRelativePath = '',
  fallbackTitle,
  canOpen,
  onOpen,
  actions,
  apiBase,
  readOnly = false,
  onNavigatePath,
  embedded = false,
}, ref) {
  const resolvedApiBase = apiBase ?? '/api/spaces/references'
  const targetKey = `${resolvedApiBase}:${itemId}:${initialRelativePath}`
  return (
    <div className={`ui-reference-preview${embedded ? ' ui-reference-preview--embedded' : ''}`}>
      <ReferenceDocumentSession
        ref={ref}
        key={targetKey}
        itemId={itemId}
        initialRelativePath={initialRelativePath}
        fallbackTitle={fallbackTitle}
        canOpen={canOpen}
        onOpen={onOpen}
        actions={actions}
        apiBase={resolvedApiBase}
        readOnly={readOnly}
        onNavigatePath={onNavigatePath}
      />
    </div>
  )
})

const ReferenceDocumentSession = forwardRef<ReferencePreviewHandle, ReferenceDocumentSessionProps>(function ReferenceDocumentSession(props, ref) {
  return <ReferenceDocumentSessionView {...props} sessionRef={ref} />
})

function ReferenceDocumentSessionView({
  itemId,
  initialRelativePath = '',
  fallbackTitle,
  canOpen,
  onOpen,
  actions,
  apiBase = '/api/spaces/references',
  readOnly = false,
  onNavigatePath,
  sessionRef,
}: ReferenceDocumentSessionProps & { sessionRef: ForwardedRef<ReferencePreviewHandle> }) {
  const targetKey = `${apiBase}:${itemId}:${initialRelativePath}`
  const cachedPreview = getCachedReferencePreview(itemId, initialRelativePath, apiBase)
  const [preview, setPreview] = useState<DocumentPreview | undefined>(cachedPreview)
  const [incoming, setIncoming] = useState<DocumentPreview>()
  const [showDiff, setShowDiff] = useState(false)
  const [error, setError] = useState<string>()
  const [relativePath, setRelativePath] = useState(initialRelativePath)
  const [draft, setDraft] = useState(() => cachedPreview?.content.kind === 'text' ? cachedPreview.content.text : '')
  const [loading, setLoading] = useState(cachedPreview === undefined)
  const [sourceMode, setSourceMode] = useState(() => documentViewMemory.get(targetKey)?.sourceMode ?? false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const loadVersionRef = useRef(0)
  const draftRef = useRef(draft)
  const pendingSaveRef = useRef<PendingReferenceSave | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveChainRef = useRef(Promise.resolve())
  const saveEpochRef = useRef(0)
  const fingerprintsRef = useRef(new Map<string, string>())
  const sessionElementRef = useRef<HTMLDivElement>(null)
  draftRef.current = draft
  const dirty = !loading && preview?.content.kind === 'text' && preview.presentation.editable && draft !== preview.content.text

  function persistPendingSave() {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    const pending = pendingSaveRef.current
    if (pending === null) return saveChainRef.current
    pendingSaveRef.current = null
    saveChainRef.current = saveChainRef.current.then(async () => {
      if (pending.epoch !== saveEpochRef.current) return
      const expectedFingerprint = fingerprintsRef.current.get(targetKey)
      if (expectedFingerprint === undefined) return
      const saved = await saveDocumentText(pending.itemId, {
        relativePath: pending.relativePath,
        expectedFingerprint,
        text: pending.text,
      }, apiBase)
      if (pending.epoch !== saveEpochRef.current) return
      if (saved.fingerprint !== undefined) fingerprintsRef.current.set(targetKey, saved.fingerprint)
      setPreview(saved)
      setIncoming(undefined)
      setShowDiff(false)
      setError(undefined)
      if (pendingSaveRef.current === null && draftRef.current === pending.text) setSaveState('saved')
    }, async () => undefined).catch(async (reason: unknown) => {
      if (pending.epoch !== saveEpochRef.current) return
      const status = typeof reason === 'object' && reason !== null && 'status' in reason ? Number(reason.status) : undefined
      if (status === 409) {
        const next = await refreshDocumentPreview(pending.itemId, pending.relativePath, undefined, apiBase).catch(() => undefined)
        if (next !== undefined) setIncoming(next)
      }
      setSaveState('error')
      setError(reason instanceof Error ? reason.message : '引用文件保存失败。')
    })
    return saveChainRef.current
  }

  function scheduleSave(text: string, immediate = false) {
    if (readOnly || preview?.content.kind !== 'text' || !preview.presentation.editable || loading) return
    if (fingerprintsRef.current.get(targetKey) === undefined) return
    setDraft(text)
    setSaveState('saving')
    pendingSaveRef.current = { epoch: saveEpochRef.current, itemId, relativePath, text }
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
    if (immediate) persistPendingSave()
    else saveTimerRef.current = setTimeout(persistPendingSave, AUTOSAVE_MS)
  }

  useEffect(() => () => { void persistPendingSave() }, [targetKey])

  useImperativeHandle(sessionRef, () => ({
    flush: async () => { await persistPendingSave(); await saveChainRef.current },
    discard: () => {
      saveEpochRef.current += 1
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      pendingSaveRef.current = null
    },
  }), [targetKey])

  useEffect(() => {
    // Electron owns the desktop close lifecycle. Browser beforeunload would
    // silently cancel the custom window close button; autosave remains the
    // desktop persistence path.
    if (!dirty || window.desktopHost !== undefined) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [dirty])

  useEffect(() => {
    const cached = getCachedReferencePreview(itemId, initialRelativePath, apiBase)
    if (cached !== undefined) {
      setPreview(cached)
      setRelativePath(initialRelativePath)
      setDraft(cached.content.kind === 'text' ? cached.content.text : '')
      if (cached.fingerprint !== undefined) fingerprintsRef.current.set(targetKey, cached.fingerprint)
      setLoading(false)
      return undefined
    }
    const controller = new AbortController()
    const loadVersion = ++loadVersionRef.current
    setLoading(preview === undefined)
    setIncoming(undefined)
    setShowDiff(false)
    setError(undefined)
    setSaveState('saved')
    void fetchDocumentPreview(itemId, initialRelativePath, controller.signal, apiBase).then((value) => {
      if (loadVersion !== loadVersionRef.current) return
      setPreview(value)
      setRelativePath(initialRelativePath)
      setDraft(value.content.kind === 'text' ? value.content.text : '')
      if (value.fingerprint !== undefined) fingerprintsRef.current.set(targetKey, value.fingerprint)
      setLoading(false)
    }, (reason: unknown) => {
      if (!controller.signal.aborted && loadVersion === loadVersionRef.current) {
        setError(reason instanceof Error ? reason.message : '引用预览加载失败。')
        setLoading(false)
      }
    })
    return () => controller.abort()
  }, [apiBase, initialRelativePath, itemId, targetKey])

  useEffect(() => {
    if (preview === undefined) return
    let disposed = false
    const revalidate = async () => {
      try {
        const next = await fetchDocumentPreview(itemId, relativePath, undefined, apiBase)
        if (disposed) return
        const annotationChanged = annotationRevisionChanged(preview, next)
        const captionChanged = imageCaptionRevisionChanged(preview, next)
        const webMetadataChanged = webMetadataChangedBetween(preview, next)
        const sourceChanged = hasSourceChanged(preview, next)
        if (webMetadataChanged) {
          setPreview(next)
          setIncoming(undefined)
          setShowDiff(false)
          return
        }
        if (annotationChanged && sourceChanged) {
          // annotation 与来源同时变化：立即应用新整理内容（Space 自己的内容），
          // 同时保留来源冲突提示，不能吞掉用户对正文变化的知情权。
          setPreview({ ...preview, annotation: next.annotation })
          setIncoming(next)
          return
        }
        if (annotationChanged) {
          // 仅 annotation 变化：来源正文未变化时 preview.content 相同，
          // 用户当前草稿（draft）不受影响。
          setPreview(next)
          setIncoming(undefined)
          setShowDiff(false)
          return
        }
        if (captionChanged && !sourceChanged) {
          setPreview(next)
          setIncoming(undefined)
          setShowDiff(false)
          return
        }
        if (sourceChanged) setIncoming(next)
      } catch {
        // Keep the visible projection stable. Explicit reload still reports failures.
      }
    }
    const onFocus = () => void revalidate()
    const unsubscribe = subscribeReferencePreviewCache(() => {
      if (getCachedReferencePreview(itemId, relativePath, apiBase) === undefined) void revalidate()
    }, apiBase)
    window.addEventListener('focus', onFocus)
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [apiBase, itemId, preview, relativePath])

  const changes = useMemo(() => {
    if (!showDiff || preview?.content.kind !== 'text' || incoming?.content.kind !== 'text') return undefined
    return diffLines(draft, incoming.content.text)
  }, [draft, incoming, preview, showDiff])

  const sourceModeActive = sourceMode && !readOnly && preview?.presentation.kind === 'markdown' && preview.presentation.sourceMode
  const activeScrollSurface: DocumentScrollSurface = changes !== undefined ? 'diff' : sourceModeActive ? 'source' : 'content'
  useLayoutEffect(() => {
    const scrolling = sessionElementRef.current?.querySelector<HTMLElement>(`[data-document-scroll="${activeScrollSurface}"]`)
    if (scrolling !== undefined && scrolling !== null) scrolling.scrollTop = documentViewMemory.get(targetKey)?.scrollTop[activeScrollSurface] ?? 0
  }, [activeScrollSurface, loading, preview?.fingerprint, targetKey])

  function toggleSourceMode() {
    setSourceMode((current) => {
      const next = !current
      rememberDocumentView(targetKey, { sourceMode: next })
      return next
    })
  }

  function rememberScroll(event: UIEvent<HTMLDivElement>) {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const surface = target.dataset.documentScroll as DocumentScrollSurface | undefined
    if (surface === undefined) return
    rememberDocumentView(targetKey, { scrollSurface: surface, scrollTop: target.scrollTop })
  }

  async function reload() {
    saveEpochRef.current += 1
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    pendingSaveRef.current = null
    const loadVersion = ++loadVersionRef.current
    setError(undefined)
    try {
      const next = incoming ?? await fetchDocumentPreview(itemId, relativePath, undefined, apiBase)
      if (loadVersion !== loadVersionRef.current) return
      setPreview(next)
      setDraft(next.content.kind === 'text' ? next.content.text : '')
      if (next.fingerprint !== undefined) fingerprintsRef.current.set(targetKey, next.fingerprint)
      setIncoming(undefined)
      setShowDiff(false)
      setSaveState('saved')
    } catch (reason) {
      if (loadVersion === loadVersionRef.current) setError(reason instanceof Error ? reason.message : '引用预览加载失败。')
    }
  }

  async function saveCaption(caption: string) {
    if (readOnly || preview?.content.kind !== 'media' || preview.content.mediaKind !== 'image' || preview.content.captionEditable !== true || preview.content.captionFingerprint === undefined) return
    const saved = await saveDocumentCaption(itemId, { relativePath, expectedFingerprint: preview.content.captionFingerprint, caption }, apiBase)
    setPreview(saved)
    setIncoming(undefined)
    setError(undefined)
  }

  if (preview === undefined) {
    return (
      <div className="ui-reference-preview__session">
        <ReferenceHeader rootTitle={fallbackTitle} relativePath={initialRelativePath} source="" actions={actions} canOpen={canOpen} onOpen={onOpen} />
        <PreviewState title={fallbackTitle} message={error ?? '正在读取引用内容...'} error={error !== undefined} onRetry={() => void reload()} />
      </div>
    )
  }
  const markdownDocument = isMarkdownDocument(preview)

  return (
    <div className="ui-reference-preview__session" ref={sessionElementRef} onScrollCapture={rememberScroll}>
      <ReferenceHeader
        rootTitle={fallbackTitle}
        relativePath={relativePath}
        source={preview.source}
        actions={actions}
        canOpen={canOpen}
        onOpen={onOpen}
        saveState={!readOnly && preview.content.kind === 'text' && preview.presentation.editable ? saveState : undefined}
        sourceMode={!readOnly && preview.presentation.sourceMode && preview.content.kind === 'text' ? sourceModeActive : undefined}
        onToggleSourceMode={toggleSourceMode}
      />

      {incoming !== undefined && (
        <div className="ui-reference-preview__notice" role="status">
          <AlertTriangle size={14} />
          <span>来源已更新，当前内容仍保持不变。</span>
          {preview.content.kind === 'text' && incoming.content.kind === 'text' && (
            <button type="button" onClick={() => setShowDiff((value) => !value)}>{showDiff ? '返回预览' : '比较更改'}</button>
          )}
          {dirty && incoming.fingerprint !== undefined && <button type="button" onClick={() => { fingerprintsRef.current.set(targetKey, incoming.fingerprint!); scheduleSave(draft, true) }}>保留我的版本</button>}
          <button type="button" onClick={() => void reload()}>加载新版</button>
        </div>
      )}
      {error !== undefined && <div className="ui-reference-preview__error" role="alert">{error}</div>}
      {changes !== undefined ? <TextDiff changes={changes} /> : sourceModeActive && markdownDocument ? (
        <textarea className="ui-reference-preview__editor" data-document-scroll="source" value={draft} onChange={(event) => scheduleSave(event.target.value)} spellCheck={false} />
      ) : <>
        <PreviewBody preview={preview} itemId={itemId} apiBase={apiBase} relativePath={relativePath} targetKey={targetKey} draft={draft} editable={!readOnly && !loading && preview.content.kind === 'text' && preview.presentation.editable} captionEditable={!readOnly && !loading && preview.content.kind === 'media' && preview.content.mediaKind === 'image' && preview.content.captionEditable === true} onChange={scheduleSave} onCaptionChange={saveCaption} onReload={() => void reload()} onNavigatePath={onNavigatePath} />
      </>}
    </div>
  )
}

function WebDocument({
  content,
  markdown,
  sourceVersion,
  annotation,
}: {
  content: Extract<DocumentPreview['content'], { kind: 'web' }>
  markdown: string
  sourceVersion: string
  annotation?: SpaceReferenceAnnotation
}) {
  return (
    <div className="ui-reference-preview__reader" data-document-scroll="content">
      <article className="ui-reference-preview__markdown ui-reference-preview__web-document reading-prose">
        <WebSourceIdentity url={content.url} faviconUrl={content.faviconUrl} />
        <MarkdownDocumentSurface markdown={markdown} sourceVersion={sourceVersion} />
        {annotation?.keyPoints !== undefined && annotation.keyPoints.length > 0 && (
          <ul className="ui-reference-preview__annotation-points">
            {annotation.keyPoints.map((point, index) => <li key={index}>{point}</li>)}
          </ul>
        )}
        {annotation?.tags !== undefined && annotation.tags.length > 0 && (
          <div className="ui-reference-preview__annotation-tags">
            {annotation.tags.map((tag, index) => <span key={index}>{tag}</span>)}
          </div>
        )}
      </article>
    </div>
  )
}

function WebSourceIdentity({ url, faviconUrl }: { readonly url: string; readonly faviconUrl?: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div className="ui-reference-preview__web-source">
      {faviconUrl !== undefined && <WebSourceFavicon url={faviconUrl} />}
      <span className="ui-reference-preview__source-url">{url}</span>
      <button
        type="button"
        className="ui-reference-preview__copy-source"
        onClick={() => void copyUrl()}
        aria-label="复制原文链接"
      >
        <Clipboard size={12} />
        <span>{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制链接'}</span>
      </button>
    </div>
  )
}

function WebSourceFavicon({ url }: { readonly url: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return <img className="ui-reference-preview__site-icon" src={url} alt="" onError={() => setFailed(true)} />
}

function ReferenceHeader({ rootTitle, relativePath, source, actions, canOpen, onOpen, saveState, sourceMode, onToggleSourceMode }: {
  rootTitle: string
  relativePath: string
  source: string
  actions?: ReactNode
  canOpen: boolean
  onOpen: () => void
  saveState?: 'saved' | 'saving' | 'error'
  sourceMode?: boolean
  onToggleSourceMode?: () => void
}) {
  return (
    <header className="ui-reference-preview__header">
      <ReferenceBreadcrumb rootTitle={rootTitle} relativePath={relativePath} source={source} />
      <div className="ui-reference-preview__actions">
        {saveState !== undefined && (
          <span className="ui-reference-preview__save-state" data-state={saveState}>
            {saveState === 'saved' ? <Check size={12} /> : <span />}
            {saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : '保存失败'}
          </span>
        )}
        {sourceMode !== undefined && onToggleSourceMode !== undefined && (
          <button type="button" onClick={onToggleSourceMode}>
            <Code2 size={13} />{sourceMode ? '阅读' : '源码'}
          </button>
        )}
        {actions}
        {canOpen && (
          <button type="button" onClick={onOpen}>
            <ExternalLink size={13} />
            在系统中打开
          </button>
        )}
      </div>
    </header>
  )
}

function ReferenceBreadcrumb({ rootTitle, relativePath, source }: { rootTitle: string; relativePath: string; source: string }) {
  const segments = relativePath.split('/').filter(Boolean)
  return (
    <nav className="ui-reference-preview__breadcrumb" aria-label="文件路径" title={source}>
      <span data-root>{rootTitle}</span>
      {segments.map((segment, index) => (
        <Fragment key={`${index}:${segment}`}>
          <ChevronRight size={12} aria-hidden="true" />
          <span data-current={index === segments.length - 1 || undefined} aria-current={index === segments.length - 1 ? 'page' : undefined}>{segment}</span>
        </Fragment>
      ))}
    </nav>
  )
}

function PreviewBody({ preview, itemId, apiBase, relativePath, targetKey, draft, editable, captionEditable, onChange, onCaptionChange, onReload, onNavigatePath }: { preview: DocumentPreview; itemId: string; apiBase: string; relativePath: string; targetKey: string; draft: string; editable: boolean; captionEditable: boolean; onChange: (value: string) => void; onCaptionChange: (value: string) => Promise<void>; onReload: () => void; onNavigatePath?: (relativePath: string) => void }) {
  const content = preview.content
  // Presentation owns renderer selection; source-specific content only supplies that surface's payload.
  switch (preview.presentation.kind) {
    case 'unavailable':
      return content.kind === 'unavailable'
        ? <PreviewState title={preview.title} message={content.message} error={preview.status === 'missing'} onRetry={onReload} />
        : <InvalidPresentationState preview={preview} onReload={onReload} />
    case 'markdown':
      if (content.kind !== 'text') return <InvalidPresentationState preview={preview} onReload={onReload} />
      return (
        <div className="ui-reference-preview__reader" data-document-scroll="content">
          <article className="ui-reference-preview__markdown reading-prose">
            <MarkdownDocumentSurface key={targetKey} markdown={draft} sourceVersion={`${targetKey}:${preview.fingerprint ?? ''}`} editable={editable} resolveImageUrl={referenceMarkdownUrlTransform(apiBase, itemId, relativePath)} onChange={onChange} />
            {content.truncated && <p className="ui-reference-preview__truncated">仅显示前 512 KiB 内容。</p>}
          </article>
        </div>
      )
    case 'code':
    case 'text':
      if (content.kind !== 'text') return <InvalidPresentationState preview={preview} onReload={onReload} />
      return (
        <div className="ui-reference-preview__text" data-presentation={preview.presentation.kind} data-editable={editable || undefined} data-document-scroll={editable ? undefined : 'content'}>
          {editable ? (
            <textarea className="ui-reference-preview__editor ui-reference-preview__editor--inline" data-document-scroll="content" value={draft} readOnly={!editable} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
          ) : preview.presentation.kind === 'code'
            ? <CodeDocumentSurface source={draft} filename={preview.title} language={content.language ?? 'plaintext'} encoding={content.encoding} />
            : <article className="ui-reference-preview__plain"><pre>{draft}</pre></article>}
          {content.truncated && <p className="ui-reference-preview__truncated">仅显示前 512 KiB 内容。</p>}
        </div>
      )
    case 'directory': {
      if (content.kind !== 'directory') return <InvalidPresentationState preview={preview} onReload={onReload} />
      if (onNavigatePath !== undefined) {
        const parent = content.relativePath.split('/').filter(Boolean).slice(0, -1).join('/')
        return (
          <div className="ui-reference-preview__directory" data-document-scroll="content">
            {content.relativePath.length > 0 && <button type="button" onClick={() => onNavigatePath(parent)}><ChevronRight size={13} style={{ transform: 'rotate(180deg)' }} />上一级</button>}
            {content.entries.map((entry) => (
              <button type="button" key={entry.relativePath} onClick={() => onNavigatePath(entry.relativePath)}>
                {entry.kind === 'directory' ? <Folder size={14} /> : <FileText size={14} />}
                <span>{entry.name}</span>
                {entry.kind === 'directory' && <ChevronRight size={13} />}
              </button>
            ))}
            {content.entries.length === 0 && <span>这个文件夹是空的。</span>}
          </div>
        )
      }
      return <PreviewState title={preview.title} message="从左侧资源树选择文件。" error={false} onRetry={onReload} />
    }
    case 'web':
      if (content.kind !== 'web') return <InvalidPresentationState preview={preview} onReload={onReload} />
      if (preview.annotation !== undefined) {
        return <WebDocument content={content} markdown={preview.annotation.markdown} sourceVersion={`${targetKey}:annotation:${preview.annotation.revision}`} annotation={preview.annotation} />
      }
      if (content.body !== undefined) {
        return <WebDocument content={content} markdown={content.body} sourceVersion={`${targetKey}:${preview.fingerprint ?? ''}`} />
      }
      return (
        <div className="ui-reference-preview__web" data-document-scroll="content">
          <FileText size={28} />
          <strong>{preview.title}</strong>
          <span className="ui-reference-preview__annotation-empty">Agent 尚未整理此引用</span>
          <a href={content.url} target="_blank" rel="noreferrer">{content.url}<ExternalLink size={12} /></a>
        </div>
      )
    case 'pdf':
      if (content.kind === 'pages') {
        return <div className="ui-reference-preview__reader" data-document-scroll="content"><PdfDocumentSurface source={{ kind: 'pages', pages: content.pages }} /></div>
      }
      if (content.kind === 'media' && content.mediaKind === 'pdf') {
        return <div className="ui-reference-preview__reader" data-document-scroll="content"><PdfDocumentSurface source={{ kind: 'url', url: content.url, byteLength: preview.byteLength, sourceVersion: preview.fingerprint }} /></div>
      }
      return <InvalidPresentationState preview={preview} onReload={onReload} />
    case 'docx':
      return content.kind === 'office' && content.officeKind === 'docx'
        ? <DocxDocumentSurface url={content.url} byteLength={preview.byteLength} sourceVersion={preview.fingerprint} />
        : <InvalidPresentationState preview={preview} onReload={onReload} />
    case 'xlsx':
      return content.kind === 'office' && content.officeKind === 'xlsx'
        ? <SpreadsheetDocumentSurface url={content.url} byteLength={preview.byteLength} sourceVersion={preview.fingerprint} />
        : <InvalidPresentationState preview={preview} onReload={onReload} />
    case 'image':
      return content.kind === 'media' && content.mediaKind === 'image'
        ? <ImageDocumentSurface url={content.url} sourceVersion={preview.fingerprint} alt={content.alt ?? preview.title} caption={content.caption} editable={captionEditable} onCaptionChange={onCaptionChange} />
        : <InvalidPresentationState preview={preview} onReload={onReload} />
    case 'video':
      return content.kind === 'media' && content.mediaKind === 'video'
        ? <VideoDocumentSurface url={content.url} title={preview.title} poster={content.poster} duration={content.duration} sourceVersion={preview.fingerprint} />
        : <InvalidPresentationState preview={preview} onReload={onReload} />
    case 'audio':
      return content.kind === 'media' && content.mediaKind === 'audio'
        ? <div className="ui-reference-preview__audio" data-document-scroll="content"><audio aria-label={preview.title} controls preload="metadata" src={content.url} />{content.duration && <span>{content.duration}</span>}{content.transcript && <p>{content.transcript}</p>}</div>
        : <InvalidPresentationState preview={preview} onReload={onReload} />
  }
}

function InvalidPresentationState({ preview, onReload }: { preview: DocumentPreview; onReload: () => void }) {
  return <PreviewState title={preview.title} message="这个文件的预览数据不完整。" error onRetry={onReload} />
}

function referenceMarkdownUrlTransform(apiBase: string, itemId: string, relativePath: string): (value: string) => string {
  const baseParts = relativePath.split('/').filter(Boolean).slice(0, -1)
  return (value) => {
    const trimmed = value.trim()
    if (/^https?:/iu.test(trimmed)) return trimmed
    if (/^[a-z][a-z\d+.-]*:/iu.test(trimmed) || trimmed.startsWith('//')) return ''
    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(trimmed.split(/[?#]/u, 1)[0])
    } catch {
      return ''
    }
    const parts = [...baseParts]
    for (const part of decodedPath.replaceAll('\\', '/').split('/')) {
      if (part.length === 0 || part === '.') continue
      if (part === '..') {
        if (parts.length === 0) return ''
        parts.pop()
      } else {
        parts.push(part)
      }
    }
    const resolved = parts.join('/')
    return resolved.length === 0 ? '' : `${apiBase}/${encodeURIComponent(itemId)}/content?path=${encodeURIComponent(resolved)}`
  }
}

function TextDiff({ changes }: { changes: readonly Change[] }) {
  return (
    <pre className="ui-reference-preview__diff" data-document-scroll="diff" aria-label="来源内容更改">
      {changes.map((change, index) => <span key={index} data-change={change.added ? 'added' : change.removed ? 'removed' : 'same'}>{change.value}</span>)}
    </pre>
  )
}

function rememberDocumentView(targetKey: string, update: { sourceMode?: boolean; scrollSurface?: DocumentScrollSurface; scrollTop?: number }) {
  const current = documentViewMemory.get(targetKey) ?? { sourceMode: false, scrollTop: {} }
  const next: DocumentViewMemory = {
    sourceMode: update.sourceMode ?? current.sourceMode,
    scrollTop: update.scrollSurface === undefined
      ? current.scrollTop
      : { ...current.scrollTop, [update.scrollSurface]: update.scrollTop ?? 0 },
  }
  documentViewMemory.delete(targetKey)
  documentViewMemory.set(targetKey, next)
  while (documentViewMemory.size > MAX_DOCUMENT_VIEW_MEMORY) documentViewMemory.delete(documentViewMemory.keys().next().value!)
}

function PreviewState({ title, message, error, onRetry }: { title: string; message: string; error: boolean; onRetry: () => void }) {
  return (
    <div className="ui-reference-preview__state">
      {error ? <AlertTriangle size={22} /> : <FileText size={22} />}
      <strong>{title}</strong>
      <span>{message}</span>
      {error && <button type="button" onClick={onRetry}><RefreshCw size={13} />重试</button>}
    </div>
  )
}

function hasSourceChanged(current: DocumentPreview, next: DocumentPreview): boolean {
  return current.fingerprint !== next.fingerprint || current.status !== next.status
}

function webMetadataChangedBetween(current: DocumentPreview, next: DocumentPreview): boolean {
  if (current.content.kind !== 'web' || next.content.kind !== 'web') return false
  return current.content.site !== next.content.site || current.content.faviconUrl !== next.content.faviconUrl
}

function annotationRevisionChanged(current: DocumentPreview, next: DocumentPreview): boolean {
  return current.annotation?.revision !== next.annotation?.revision
}

function imageCaptionRevisionChanged(current: DocumentPreview, next: DocumentPreview): boolean {
  const currentFingerprint = current.content.kind === 'media' && current.content.mediaKind === 'image'
    ? current.content.captionFingerprint
    : undefined
  const nextFingerprint = next.content.kind === 'media' && next.content.mediaKind === 'image'
    ? next.content.captionFingerprint
    : undefined
  return currentFingerprint !== nextFingerprint
}
