import readWorkbook from 'read-excel-file/web-worker'
import type { SpreadsheetSheet, SpreadsheetWorkerRequest, SpreadsheetWorkerResponse } from './spreadsheetPreviewTypes'

type SpreadsheetWorkerScope = {
  addEventListener: (type: 'message', listener: (event: MessageEvent<SpreadsheetWorkerRequest>) => void) => void
  postMessage: (message: SpreadsheetWorkerResponse) => void
}

const workerScope = globalThis as unknown as SpreadsheetWorkerScope

workerScope.addEventListener('message', (event) => {
  const request = event.data
  if (request.kind !== 'parse') return
  void readWorkbook(request.source).then((sheets) => {
    // read-excel-file 9.3.1 declares date cells as `typeof Date`, while its
    // browser parser returns structured-cloneable Date instances at runtime.
    workerScope.postMessage({
      kind: 'parsed',
      requestId: request.requestId,
      sheets: sheets as unknown as readonly SpreadsheetSheet[],
    })
  }, (reason: unknown) => {
    workerScope.postMessage({
      kind: 'failed',
      requestId: request.requestId,
      message: reason instanceof Error ? reason.message : '无法读取工作簿。',
    })
  })
})