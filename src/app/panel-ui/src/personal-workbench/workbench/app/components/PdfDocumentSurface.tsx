import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { pushResponsivenessContext } from '@ui/shell/responsiveness-diagnostics'
import type { DocumentPreview } from '@panel-api/workbench'

type PdfDocumentSurfaceProps = {
  readonly source: { readonly kind: 'pages'; readonly pages: readonly string[] }
    | { readonly kind: 'url'; readonly url: string; readonly byteLength?: number; readonly sourceVersion?: string }
}

type PdfDocumentHandle = {
  readonly numPages: number
  getPage(pageNumber: number): Promise<PdfPageHandle>
  destroy(): Promise<void>
}

type PdfPageHandle = {
  getViewport(input: { readonly scale: number }): { readonly width: number; readonly height: number }
  render(input: {
    readonly canvas: HTMLCanvasElement
    readonly canvasContext: CanvasRenderingContext2D
    readonly viewport: { readonly width: number; readonly height: number }
  }): { readonly promise: Promise<void>; cancel(): void }
  cleanup(): void
}

type PdfLoadSession = {
  readonly promise: Promise<PdfDocumentHandle>
  destroy(): Promise<void>
}

type CachedPdfDocument = {
  readonly key: string
  readonly byteLength: number
  promise: Promise<PdfDocumentHandle>
  displayReadyPromise: Promise<PdfDocumentHandle>
  session?: PdfLoadSession
  document?: PdfDocumentHandle
  firstPage?: CachedPdfPage
  firstPageBytes: number
  displayReady: boolean
  consumers: number
  evicted: boolean
}

type CachedPdfPage = {
  readonly canvas: HTMLCanvasElement
  readonly aspectRatio: number
}

const INITIAL_PAGE_COUNT = 8
const PAGE_BATCH_SIZE = 8
const MAX_CONCURRENT_PAGE_RENDERS = 2
const MAX_CACHED_PDF_BYTES = 16 * 1024 * 1024
const MAX_PDF_CACHE_BYTES = 40 * 1024 * 1024
const MAX_CACHED_PDF_DOCUMENTS = 4
const CACHED_FIRST_PAGE_WIDTH = 960
const MAX_CACHED_FIRST_PAGE_PIXELS = 2_500_000

const pdfDocumentCache = new Map<string, CachedPdfDocument>()
let cachedPdfBytes = 0

export function PdfDocumentSurface({ source }: PdfDocumentSurfaceProps) {
  if (source.kind === 'pages') return <StructuredPdfPages pages={source.pages} />
  return <RenderedPdfDocument url={source.url} byteLength={source.byteLength} sourceVersion={source.sourceVersion} />
}

export function PdfDocumentThumbnail({
  source,
  title,
  fallbackText,
}: {
  readonly source?: { readonly url: string; readonly byteLength?: number; readonly sourceVersion?: string }
  readonly title: string
  readonly fallbackText?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [firstPage, setFirstPage] = useState(() => source === undefined
    ? undefined
    : getCachedPdfFirstPage(source.url, source.byteLength, source.sourceVersion))

  useEffect(() => {
    let disposed = false
    if (source === undefined || source.byteLength === undefined || source.byteLength > MAX_CACHED_PDF_BYTES) {
      setFirstPage(undefined)
      return () => { disposed = true }
    }
    const cached = getOrCreateCachedPdfDocument(source.url, source.byteLength, source.sourceVersion)
    setFirstPage(getCachedPdfFirstPage(source.url, source.byteLength, source.sourceVersion))
    void cached.displayReadyPromise.then(() => {
      if (!disposed) setFirstPage(getCachedPdfFirstPage(source.url, source.byteLength, source.sourceVersion))
    }).catch(() => {
      if (!disposed) setFirstPage(undefined)
    })
    return () => { disposed = true }
  }, [source?.byteLength, source?.sourceVersion, source?.url])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || firstPage === undefined) return
    canvas.width = firstPage.canvas.width
    canvas.height = firstPage.canvas.height
    canvas.getContext('2d', { alpha: false })?.drawImage(firstPage.canvas, 0, 0)
  }, [firstPage])

  return (
    <div className="ui-pdf-document__thumbnail" aria-label={`${title} PDF 首页`}>
      <div className="ui-pdf-document__thumbnail-paper">
        {firstPage !== undefined ? (
          <canvas ref={canvasRef} />
        ) : fallbackText !== undefined ? (
          <p>{fallbackText}</p>
        ) : (
          <PdfThumbnailPlaceholder />
        )}
      </div>
    </div>
  )
}

function PdfThumbnailPlaceholder() {
  return (
    <div className="ui-pdf-document__thumbnail-placeholder" aria-hidden="true">
      {[72, 92, 84, 58, 88, 66].map((width, index) => <span key={index} style={{ width: `${width}%` }} />)}
    </div>
  )
}

export function prefetchPdfPreview(preview: DocumentPreview): void {
  if (preview.content.kind !== 'media' || preview.content.mediaKind !== 'pdf') return
  if (preview.byteLength === undefined || preview.byteLength > MAX_CACHED_PDF_BYTES) return
  void getOrCreateCachedPdfDocument(
    preview.content.url,
    preview.byteLength,
    preview.fingerprint,
  ).displayReadyPromise.catch(() => undefined)
}

function StructuredPdfPages({ pages }: { readonly pages: readonly string[] }) {
  const pagination = useProgressivePages(pages.length)
  useResponsivenessContext(`PDF text preview (${pages.length} pages)`)
  if (pages.length === 0) return <PdfState message="这个 PDF 暂无可显示内容。" />
  return (
    <div className="ui-pdf-document" data-pdf-source="structured">
      {pages.slice(0, pagination.visibleCount).map((page, index) => (
        <article className="ui-pdf-document__page ui-pdf-document__page--text" key={index}>
          <pre>{page}</pre>
          <PageNumber current={index + 1} total={pages.length} />
        </article>
      ))}
      <PdfPageContinuation {...pagination} total={pages.length} />
    </div>
  )
}

function RenderedPdfDocument({ url, byteLength, sourceVersion }: {
  readonly url: string
  readonly byteLength?: number
  readonly sourceVersion?: string
}) {
  const [document, setDocument] = useState<PdfDocumentHandle | undefined>(() => getReadyCachedPdfDocument(url, byteLength, sourceVersion))
  const [error, setError] = useState<string>()
  const [reloadKey, setReloadKey] = useState(0)
  const pagination = useProgressivePages(document?.numPages ?? 0)
  useResponsivenessContext(document === undefined ? 'PDF loading' : `PDF preview (${document.numPages} pages)`)

  useEffect(() => {
    let disposed = false
    let session: PdfLoadSession | undefined
    let cached: CachedPdfDocument | undefined
    setDocument(getReadyCachedPdfDocument(url, byteLength, sourceVersion))
    setError(undefined)
    const load = byteLength !== undefined && byteLength <= MAX_CACHED_PDF_BYTES
      ? (cached = acquireCachedPdfDocument(url, byteLength, sourceVersion)).displayReadyPromise
      : createPdfLoadSession(url).then((created) => {
        session = created
        return created.promise
      })
    void load.then((value) => {
      if (disposed) {
        return
      }
      setDocument(value)
    }).catch(() => {
      if (!disposed) setError('无法在工作台中读取这个 PDF。')
    })
    return () => {
      disposed = true
      if (cached !== undefined) releaseCachedPdfDocument(cached)
      if (session !== undefined) void session.destroy()
    }
  }, [byteLength, reloadKey, sourceVersion, url])

  if (error !== undefined) return <PdfState message={error} onRetry={() => setReloadKey((value) => value + 1)} />
  if (document === undefined) return <PdfState message="正在读取 PDF..." />
  const firstPage = getCachedPdfFirstPage(url, byteLength, sourceVersion)
  return (
    <div className="ui-pdf-document" data-pdf-source="file">
      {Array.from({ length: pagination.visibleCount }, (_, index) => (
        <RenderedPdfPage document={document} pageNumber={index + 1} total={document.numPages} initialPage={index === 0 ? firstPage : undefined} key={index} />
      ))}
      <PdfPageContinuation {...pagination} total={document.numPages} />
    </div>
  )
}

function RenderedPdfPage({ document, pageNumber, total, initialPage }: {
  readonly document: PdfDocumentHandle
  readonly pageNumber: number
  readonly total: number
  readonly initialPage?: CachedPdfPage
}) {
  const articleRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(() => pageNumber <= 2 || typeof IntersectionObserver === 'undefined')
  const [aspectRatio, setAspectRatio] = useState(() => initialPage?.aspectRatio ?? 1 / Math.SQRT2)
  const [failed, setFailed] = useState(false)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || initialPage === undefined) return
    canvas.width = initialPage.canvas.width
    canvas.height = initialPage.canvas.height
    const context = canvas.getContext('2d', { alpha: false })
    context?.drawImage(initialPage.canvas, 0, 0)
  }, [initialPage])

  useEffect(() => {
    const element = articleRef.current
    if (element === null || visible) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
    }, { rootMargin: '800px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const article = articleRef.current
    const canvas = canvasRef.current
    if (article === null || canvas === null) return
    const abortController = new AbortController()
    let page: PdfPageHandle | undefined
    let renderTask: ReturnType<PdfPageHandle['render']> | undefined
    let renderedWidth = 0

    const render = async () => {
      const cssWidth = Math.max(1, Math.round(article.clientWidth))
      if (cssWidth === renderedWidth || abortController.signal.aborted) return
      renderedWidth = cssWidth
      await pdfPageRenderScheduler.schedule(abortController.signal, async () => {
        page ??= await document.getPage(pageNumber)
        if (abortController.signal.aborted) return
        const baseViewport = page.getViewport({ scale: 1 })
        setAspectRatio(baseViewport.width / baseViewport.height)
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
        const viewport = page.getViewport({ scale: cssWidth * pixelRatio / baseViewport.width })
        const renderCanvas = globalThis.document.createElement('canvas')
        renderCanvas.width = Math.ceil(viewport.width)
        renderCanvas.height = Math.ceil(viewport.height)
        const renderContext = renderCanvas.getContext('2d', { alpha: false })
        if (renderContext === null) throw new Error('Canvas 2D is unavailable.')
        renderTask?.cancel()
        renderTask = page.render({ canvas: renderCanvas, canvasContext: renderContext, viewport })
        await renderTask.promise
        if (abortController.signal.aborted) return
        canvas.width = renderCanvas.width
        canvas.height = renderCanvas.height
        const visibleContext = canvas.getContext('2d', { alpha: false })
        if (visibleContext === null) throw new Error('Canvas 2D is unavailable.')
        visibleContext.drawImage(renderCanvas, 0, 0)
        setFailed(false)
      })
    }

    const observer = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => { void render().catch((reason) => handleRenderFailure(reason, abortController.signal, setFailed)) })
    observer?.observe(article)
    void render().catch((reason) => handleRenderFailure(reason, abortController.signal, setFailed))
    return () => {
      abortController.abort()
      observer?.disconnect()
      renderTask?.cancel()
      page?.cleanup()
    }
  }, [document, pageNumber, visible])

  return (
    <article
      className="ui-pdf-document__page ui-pdf-document__page--canvas"
      ref={articleRef}
      style={{ aspectRatio }}
      aria-label={`PDF 第 ${pageNumber} 页`}
    >
      <canvas ref={canvasRef} />
      {failed && <span className="ui-pdf-document__page-error">这一页暂时无法显示。</span>}
      <PageNumber current={pageNumber} total={total} />
    </article>
  )
}

function PdfPageContinuation(props: {
  readonly visibleCount: number
  readonly sentinelRef: RefObject<HTMLDivElement | null>
  readonly loadMore: () => void
  readonly total: number
}) {
  if (props.visibleCount >= props.total) return null
  const remaining = props.total - props.visibleCount
  return (
    <div className="ui-pdf-document__continuation" ref={props.sentinelRef}>
      <span>{props.visibleCount} / {props.total} 页</span>
      <button type="button" onClick={props.loadMore}>继续加载后 {Math.min(PAGE_BATCH_SIZE, remaining)} 页</button>
    </div>
  )
}

function PageNumber({ current, total }: { readonly current: number; readonly total: number }) {
  return <span className="ui-pdf-document__page-number">{current} / {total}</span>
}

function PdfState({ message, onRetry }: { readonly message: string; readonly onRetry?: () => void }) {
  return (
    <div className="ui-pdf-document__state" role={onRetry === undefined ? 'status' : 'alert'}>
      <span>{message}</span>
      {onRetry !== undefined && <button type="button" onClick={onRetry}>重试</button>}
    </div>
  )
}

function useProgressivePages(total: number) {
  const [visibleCount, setVisibleCount] = useState(() => Math.min(total, INITIAL_PAGE_COUNT))
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadMore = () => setVisibleCount((current) => Math.min(total, current + PAGE_BATCH_SIZE))

  useEffect(() => {
    setVisibleCount(Math.min(total, INITIAL_PAGE_COUNT))
  }, [total])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (sentinel === null || visibleCount >= total || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore()
    }, { rootMargin: '600px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [total, visibleCount])

  return { visibleCount, sentinelRef, loadMore }
}

function useResponsivenessContext(label: string): void {
  useEffect(() => pushResponsivenessContext(label), [label])
}

function handleRenderFailure(
  reason: unknown,
  signal: AbortSignal,
  setFailed: (failed: boolean) => void,
): void {
  const name = reason instanceof Error ? reason.name : undefined
  if (!signal.aborted && name !== 'RenderingCancelledException') setFailed(true)
}

class PdfPageRenderScheduler {
  private active = 0
  private readonly pending: Array<{
    readonly signal: AbortSignal
    readonly run: () => Promise<void>
    readonly resolve: () => void
    readonly reject: (reason: unknown) => void
  }> = []

  schedule(signal: AbortSignal, run: () => Promise<void>): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.pending.push({ signal, run, resolve, reject })
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < MAX_CONCURRENT_PAGE_RENDERS) {
      const job = this.pending.shift()
      if (job === undefined) return
      if (job.signal.aborted) {
        job.resolve()
        continue
      }
      this.active += 1
      void job.run().then(job.resolve, job.reject).finally(() => {
        this.active -= 1
        this.drain()
      })
    }
  }
}

const pdfPageRenderScheduler = new PdfPageRenderScheduler()

function getReadyCachedPdfDocument(
  url: string,
  byteLength?: number,
  sourceVersion?: string,
): PdfDocumentHandle | undefined {
  if (byteLength === undefined || byteLength > MAX_CACHED_PDF_BYTES) return undefined
  const key = pdfCacheKey(url, sourceVersion)
  const cached = pdfDocumentCache.get(key)
  if (cached === undefined) return undefined
  touchCachedPdfDocument(key, cached)
  return cached.displayReady ? cached.document : undefined
}

function getCachedPdfFirstPage(
  url: string,
  byteLength?: number,
  sourceVersion?: string,
): CachedPdfPage | undefined {
  if (byteLength === undefined || byteLength > MAX_CACHED_PDF_BYTES) return undefined
  const cached = pdfDocumentCache.get(pdfCacheKey(url, sourceVersion))
  return cached?.displayReady ? cached.firstPage : undefined
}

function acquireCachedPdfDocument(
  url: string,
  byteLength: number,
  sourceVersion?: string,
): CachedPdfDocument {
  const cached = getOrCreateCachedPdfDocument(url, byteLength, sourceVersion)
  cached.consumers += 1
  return cached
}

function releaseCachedPdfDocument(cached: CachedPdfDocument): void {
  cached.consumers = Math.max(0, cached.consumers - 1)
  trimPdfDocumentCache()
}

function getOrCreateCachedPdfDocument(
  url: string,
  byteLength: number,
  sourceVersion?: string,
): CachedPdfDocument {
  const key = pdfCacheKey(url, sourceVersion)
  const current = pdfDocumentCache.get(key)
  if (current !== undefined) {
    touchCachedPdfDocument(key, current)
    return current
  }

  const cached: CachedPdfDocument = {
    key,
    byteLength,
    promise: Promise.resolve(undefined as unknown as PdfDocumentHandle),
    displayReadyPromise: Promise.resolve(undefined as unknown as PdfDocumentHandle),
    firstPageBytes: 0,
    displayReady: false,
    consumers: 0,
    evicted: false,
  }
  cached.promise = createPdfLoadSession(url).then(async (session) => {
    cached.session = session
    if (cached.evicted) {
      await session.destroy()
      throw new DOMException('The PDF cache entry was evicted.', 'AbortError')
    }
    return session.promise
  }).then((document) => {
    cached.document = document
    return document
  }).catch((reason: unknown) => {
    if (pdfDocumentCache.get(key) === cached) removeCachedPdfDocument(cached)
    throw reason
  })
  cached.displayReadyPromise = cached.promise.then(async (document) => {
    try {
      await cacheFirstPdfPage(cached, document)
    } catch {
      // Parsing is still useful when a background first-page render is unavailable.
    } finally {
      if (!cached.evicted) cached.displayReady = true
    }
    return document
  })
  pdfDocumentCache.set(key, cached)
  cachedPdfBytes += byteLength
  trimPdfDocumentCache()
  return cached
}

function trimPdfDocumentCache(): void {
  while (pdfDocumentCache.size > MAX_CACHED_PDF_DOCUMENTS || cachedPdfBytes > MAX_PDF_CACHE_BYTES) {
    const candidate = [...pdfDocumentCache.values()].find((entry) => entry.consumers === 0)
    if (candidate === undefined) return
    removeCachedPdfDocument(candidate)
  }
}

function removeCachedPdfDocument(cached: CachedPdfDocument): void {
  if (pdfDocumentCache.get(cached.key) !== cached) return
  pdfDocumentCache.delete(cached.key)
  cachedPdfBytes -= cached.byteLength + cached.firstPageBytes
  cached.evicted = true
  if (cached.session !== undefined) void cached.session.destroy()
}

function touchCachedPdfDocument(key: string, cached: CachedPdfDocument): void {
  pdfDocumentCache.delete(key)
  pdfDocumentCache.set(key, cached)
}

function pdfCacheKey(url: string, sourceVersion?: string): string {
  return `${url}\u0000${sourceVersion ?? ''}`
}

async function cacheFirstPdfPage(cached: CachedPdfDocument, document: PdfDocumentHandle): Promise<void> {
  if (document.numPages === 0 || cached.evicted) return
  const page = await document.getPage(1)
  let renderTask: ReturnType<PdfPageHandle['render']> | undefined
  try {
    const baseViewport = page.getViewport({ scale: 1 })
    let scale = CACHED_FIRST_PAGE_WIDTH / baseViewport.width
    let viewport = page.getViewport({ scale })
    const pixels = viewport.width * viewport.height
    if (pixels > MAX_CACHED_FIRST_PAGE_PIXELS) {
      scale *= Math.sqrt(MAX_CACHED_FIRST_PAGE_PIXELS / pixels)
      viewport = page.getViewport({ scale })
    }
    const canvas = globalThis.document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(viewport.width))
    canvas.height = Math.max(1, Math.ceil(viewport.height))
    const context = canvas.getContext('2d', { alpha: false })
    if (context === null) return
    renderTask = page.render({ canvas, canvasContext: context, viewport })
    await renderTask.promise
    if (cached.evicted || pdfDocumentCache.get(cached.key) !== cached) return
    const firstPageBytes = canvas.width * canvas.height * 4
    cached.firstPage = { canvas, aspectRatio: baseViewport.width / baseViewport.height }
    cached.firstPageBytes = firstPageBytes
    cachedPdfBytes += firstPageBytes
    trimPdfDocumentCache()
  } finally {
    if (cached.evicted) renderTask?.cancel()
    page.cleanup()
  }
}

async function createPdfLoadSession(url: string): Promise<PdfLoadSession> {
  if (typeof Worker === 'undefined') throw new Error('PDF worker is unavailable.')
  const pdfjs = await import('unpdf/pdfjs')
  const workerPort = new Worker(new URL('./pdf.worker.ts', import.meta.url), {
    type: 'module',
    name: 'synech-pdf-worker',
  })
  const worker = pdfjs.PDFWorker.create({ port: workerPort, name: 'synech-pdf-worker' })
  const loadingTask = pdfjs.getDocument({
    url,
    worker,
    withCredentials: true,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  })
  let document: PdfDocumentHandle | undefined
  let destroyed = false
  return {
    promise: loadingTask.promise.then((value) => {
      document = value as PdfDocumentHandle
      return document
    }),
    async destroy() {
      if (destroyed) return
      destroyed = true
      try {
        if (document === undefined) await loadingTask.destroy()
        else await document.destroy()
      } finally {
        worker.destroy()
        workerPort.terminate()
      }
    },
  }
}
