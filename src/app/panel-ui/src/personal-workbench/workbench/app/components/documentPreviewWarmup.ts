import type { DocumentPreview } from './referencePreviewClient'
import { prefetchImagePreview } from './imagePreviewRuntime'
import { prefetchOfficePreview } from './officePreviewRuntime'
import { prefetchPdfPreview } from './PdfDocumentSurface'
import { prefetchVideoPreview } from './videoPreviewRuntime'

export function prefetchDocumentSurface(preview: DocumentPreview): void {
  if (preview.content.kind === 'office') {
    prefetchOfficePreview(preview)
    return
  }
  if (preview.content.kind !== 'media') return
  if (preview.content.mediaKind === 'image') prefetchImagePreview(preview)
  else if (preview.content.mediaKind === 'pdf') prefetchPdfPreview(preview)
  else if (preview.content.mediaKind === 'video') prefetchVideoPreview(preview)
}
