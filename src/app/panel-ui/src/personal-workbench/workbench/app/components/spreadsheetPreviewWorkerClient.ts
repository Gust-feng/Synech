import type { SpreadsheetSheet, SpreadsheetWorkerRequest, SpreadsheetWorkerResponse } from './spreadsheetPreviewTypes'

type PendingWorkbook = {
  readonly resolve: (sheets: readonly SpreadsheetSheet[]) => void
  readonly reject: (reason: Error) => void
  readonly detachAbort: () => void
}

let spreadsheetWorker: Worker | undefined
let nextRequestId = 1
const pendingWorkbooks = new Map<number, PendingWorkbook>()

export function warmSpreadsheetPreviewWorker(): void {
  try {
    getSpreadsheetWorker()
  } catch {
    // On-demand parsing will surface a concrete error if Worker startup stays unavailable.
  }
}

export function parseSpreadsheetWorkbook(source: Blob, signal: AbortSignal): Promise<readonly SpreadsheetSheet[]> {
  if (signal.aborted) return Promise.reject(abortError())
  const worker = getSpreadsheetWorker()
  const requestId = nextRequestId++
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const pending = pendingWorkbooks.get(requestId)
      if (pending === undefined) return
      pendingWorkbooks.delete(requestId)
      pending.detachAbort()
      reject(abortError())
      if (pendingWorkbooks.size === 0) resetSpreadsheetWorker()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pendingWorkbooks.set(requestId, {
      resolve,
      reject,
      detachAbort: () => signal.removeEventListener('abort', onAbort),
    })
    const request: SpreadsheetWorkerRequest = { kind: 'parse', requestId, source }
    try {
      worker.postMessage(request)
    } catch (reason) {
      const pending = pendingWorkbooks.get(requestId)
      pendingWorkbooks.delete(requestId)
      pending?.detachAbort()
      reject(reason instanceof Error ? reason : new Error('无法启动工作簿解析。'))
    }
  })
}

function getSpreadsheetWorker(): Worker {
  if (spreadsheetWorker !== undefined) return spreadsheetWorker
  const worker = new Worker(new URL('./spreadsheetPreview.worker.ts', import.meta.url), {
    type: 'module',
    name: 'synech-xlsx-preview',
  })
  worker.addEventListener('message', handleWorkerMessage)
  worker.addEventListener('error', handleWorkerError)
  spreadsheetWorker = worker
  return worker
}

function handleWorkerMessage(event: MessageEvent<SpreadsheetWorkerResponse>): void {
  const response = event.data
  const pending = pendingWorkbooks.get(response.requestId)
  if (pending === undefined) return
  pendingWorkbooks.delete(response.requestId)
  pending.detachAbort()
  if (response.kind === 'parsed') pending.resolve(response.sheets)
  else pending.reject(new Error(response.message))
}

function handleWorkerError(event: ErrorEvent): void {
  const error = new Error(event.message || '无法读取工作簿。')
  for (const pending of pendingWorkbooks.values()) {
    pending.detachAbort()
    pending.reject(error)
  }
  pendingWorkbooks.clear()
  resetSpreadsheetWorker()
}

function resetSpreadsheetWorker(): void {
  spreadsheetWorker?.terminate()
  spreadsheetWorker = undefined
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}
