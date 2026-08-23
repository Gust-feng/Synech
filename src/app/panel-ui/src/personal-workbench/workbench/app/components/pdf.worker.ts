import { version } from 'unpdf/pdfjs'

const pdfWorkerScope = globalThis as typeof globalThis & {
  __workbenchPdfWorkerVersion?: string
}

// Keep the bundled PDF.js module in this worker entry; it initializes its
// message handler when evaluated in a dedicated WorkerGlobalScope.
pdfWorkerScope.__workbenchPdfWorkerVersion = version
