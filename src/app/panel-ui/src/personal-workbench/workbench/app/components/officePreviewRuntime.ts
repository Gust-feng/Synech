import type { DocumentPreview } from '@panel-api/workbench'
import type { SpreadsheetSheet } from './spreadsheetPreviewTypes'

const MAX_CACHED_DOCUMENT_BYTES = 8 * 1024 * 1024
const MAX_DOCUMENT_CACHE_BYTES = 24 * 1024 * 1024
const MAX_RENDERED_OFFICE_PREVIEWS = 8
const DOCX_RENDER_OPTIONS = {
  className: 'ui-docx',
  inWrapper: true,
  ignoreWidth: false,
  ignoreHeight: false,
  breakPages: true,
  ignoreLastRenderedPageBreak: false,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  renderChanges: false,
  renderComments: false,
  renderAltChunks: false,
  useBase64URL: true,
  experimental: false,
  debug: false,
} as const

type OfficeContent = Extract<DocumentPreview['content'], { readonly kind: 'office' }>
type CachedDocument = { readonly byteLength: number; readonly promise: Promise<Blob> }
export type DocxPreviewMarkup = { readonly bodyHtml: string; readonly styleHtml: string }
type OfficeDocumentRequest = {
  readonly url: string
  readonly byteLength?: number
  readonly sourceVersion?: string
  readonly signal: AbortSignal
}

const documentCache = new Map<string, CachedDocument>()
const docxPreviewCache = new Map<string, Promise<DocxPreviewMarkup>>()
const docxPreviewValues = new Map<string, DocxPreviewMarkup>()
const spreadsheetPreviewCache = new Map<string, Promise<readonly SpreadsheetSheet[]>>()
const spreadsheetPreviewValues = new Map<string, readonly SpreadsheetSheet[]>()
let cachedDocumentBytes = 0
let docxRendererPromise: Promise<typeof import('docx-preview')> | undefined
let spreadsheetWorkerClientPromise: Promise<typeof import('./spreadsheetPreviewWorkerClient')> | undefined

export function loadDocxRenderer(): Promise<typeof import('docx-preview')> {
  docxRendererPromise ??= import('docx-preview').catch((reason: unknown) => {
    docxRendererPromise = undefined
    throw reason
  })
  return docxRendererPromise
}

export function loadOfficeDocument({ url, byteLength, sourceVersion, signal }: OfficeDocumentRequest): Promise<Blob> {
  const cacheable = byteLength !== undefined && byteLength <= MAX_CACHED_DOCUMENT_BYTES
  if (!cacheable) return fetchOfficeDocument(url, signal)
  const cacheKey = `${url}\u0000${sourceVersion ?? ''}`
  const cached = documentCache.get(cacheKey)
  if (cached !== undefined) {
    documentCache.delete(cacheKey)
    documentCache.set(cacheKey, cached)
    return waitForDocument(cached.promise, signal)
  }

  makeDocumentCacheRoom(byteLength)
  const promise = fetchOfficeDocument(url).catch((reason: unknown) => {
    removeCachedDocument(cacheKey)
    throw reason
  })
  documentCache.set(cacheKey, { byteLength, promise })
  cachedDocumentBytes += byteLength
  return waitForDocument(promise, signal)
}

export function prefetchOfficePreview(preview: DocumentPreview): void {
  if (preview.content.kind !== 'office') return
  warmOfficeRenderer(preview.content.officeKind)
  if (preview.byteLength !== undefined && preview.byteLength <= MAX_CACHED_DOCUMENT_BYTES) {
    const request = {
      url: preview.content.url,
      byteLength: preview.byteLength,
      sourceVersion: preview.fingerprint,
      signal: new AbortController().signal,
    }
    if (preview.content.officeKind === 'docx') {
      void loadDocxPreviewMarkup(request).catch(() => undefined)
    } else {
      void loadSpreadsheetPreview(request).catch(() => undefined)
    }
  }
}

export function getCachedDocxPreviewMarkup(url: string, sourceVersion?: string): DocxPreviewMarkup | undefined {
  return docxPreviewValues.get(officePreviewKey(url, sourceVersion))
}

export function loadDocxPreviewMarkup(request: OfficeDocumentRequest): Promise<DocxPreviewMarkup> {
  const key = officePreviewKey(request.url, request.sourceVersion)
  const cached = docxPreviewCache.get(key)
  if (cached !== undefined) return waitForValue(cached, request.signal)
  const promise = Promise.all([
    loadOfficeDocument(request),
    loadDocxRenderer(),
  ]).then(async ([document, renderer]) => {
    const host = documentNode('div')
    const styles = documentNode('div')
    const body = documentNode('div')
    Object.assign(host.style, {
      position: 'fixed',
      width: '900px',
      height: '1px',
      left: '0',
      bottom: '0',
      overflow: 'hidden',
      visibility: 'hidden',
      pointerEvents: 'none',
    })
    host.append(styles, body)
    globalThis.document.body.append(host)
    try {
      await renderer.renderAsync(document, body, styles, DOCX_RENDER_OPTIONS)
      return { bodyHtml: body.innerHTML, styleHtml: styles.innerHTML }
    } finally {
      host.remove()
    }
  }).catch((reason: unknown) => {
    if (docxPreviewCache.get(key) === promise) docxPreviewCache.delete(key)
    throw reason
  })
  rememberPreviewPromise(docxPreviewCache, docxPreviewValues, key, promise)
  return waitForValue(promise, request.signal)
}

export function getCachedSpreadsheetPreview(url: string, sourceVersion?: string): readonly SpreadsheetSheet[] | undefined {
  return spreadsheetPreviewValues.get(officePreviewKey(url, sourceVersion))
}

export function loadSpreadsheetPreview(request: OfficeDocumentRequest): Promise<readonly SpreadsheetSheet[]> {
  const key = officePreviewKey(request.url, request.sourceVersion)
  const cached = spreadsheetPreviewCache.get(key)
  if (cached !== undefined) return waitForValue(cached, request.signal)
  // Once the bytes are available, the bounded cache owns parsing; one surface abort only stops waiting for it.
  const promise = Promise.all([
    loadOfficeDocument(request),
    loadSpreadsheetWorkerClient(),
  ]).then(([document, workerClient]) => workerClient.parseSpreadsheetWorkbook(document, new AbortController().signal)).catch((reason: unknown) => {
    if (spreadsheetPreviewCache.get(key) === promise) spreadsheetPreviewCache.delete(key)
    throw reason
  })
  rememberPreviewPromise(spreadsheetPreviewCache, spreadsheetPreviewValues, key, promise)
  return waitForValue(promise, request.signal)
}

export function scheduleOfficePreviewWarmup(): void {
  scheduleIdle(async () => {
    await loadDocxRenderer().catch(() => undefined)
    scheduleIdle(async () => {
      const workerClient = await loadSpreadsheetWorkerClient().catch(() => undefined)
      workerClient?.warmSpreadsheetPreviewWorker()
    })
  })
}

function warmOfficeRenderer(kind: OfficeContent['officeKind']): void {
  if (kind === 'docx') {
    void loadDocxRenderer().catch(() => undefined)
    return
  }
  void loadSpreadsheetWorkerClient()
    .then((client) => client.warmSpreadsheetPreviewWorker())
    .catch(() => undefined)
}

function loadSpreadsheetWorkerClient(): Promise<typeof import('./spreadsheetPreviewWorkerClient')> {
  spreadsheetWorkerClientPromise ??= import('./spreadsheetPreviewWorkerClient').catch((reason: unknown) => {
    spreadsheetWorkerClientPromise = undefined
    throw reason
  })
  return spreadsheetWorkerClientPromise
}

async function fetchOfficeDocument(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, signal === undefined ? undefined : { signal })
  if (!response.ok) throw new Error(`文件内容读取失败（HTTP ${response.status}）。`)
  return response.blob()
}

function waitForDocument(promise: Promise<Blob>, signal: AbortSignal): Promise<Blob> {
  return waitForValue(promise, signal)
}

function waitForValue<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      if (!signal.aborted) resolve(value)
    }, (reason: unknown) => {
      signal.removeEventListener('abort', onAbort)
      if (!signal.aborted) reject(reason)
    })
  })
}

function rememberPreviewPromise<T>(
  promises: Map<string, Promise<T>>,
  values: Map<string, T>,
  key: string,
  promise: Promise<T>,
): void {
  promises.delete(key)
  promises.set(key, promise)
  void promise.then((value) => {
    if (promises.get(key) === promise) values.set(key, value)
  }, () => undefined)
  while (promises.size > MAX_RENDERED_OFFICE_PREVIEWS) {
    const oldestKey = promises.keys().next().value
    if (oldestKey === undefined) return
    promises.delete(oldestKey)
    values.delete(oldestKey)
  }
}

function officePreviewKey(url: string, sourceVersion?: string): string {
  return `${url}\u0000${sourceVersion ?? ''}`
}

function documentNode(tagName: 'div'): HTMLDivElement {
  return globalThis.document.createElement(tagName)
}

function makeDocumentCacheRoom(byteLength: number): void {
  while (cachedDocumentBytes + byteLength > MAX_DOCUMENT_CACHE_BYTES && documentCache.size > 0) {
    removeCachedDocument(documentCache.keys().next().value!)
  }
}

function removeCachedDocument(url: string): void {
  const cached = documentCache.get(url)
  if (cached === undefined) return
  documentCache.delete(url)
  cachedDocumentBytes -= cached.byteLength
}

function scheduleIdle(task: () => void | Promise<void>): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => { void task() }, { timeout: 3_000 })
  } else {
    window.setTimeout(() => { void task() }, 1_500)
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}
