import type { DocumentPreview } from '../../../../../../panel-api-contracts'

export type DocumentContentKind = 'file' | 'markdown' | 'pdf' | 'docx' | 'xlsx' | 'web' | 'image' | 'video' | 'audio' | 'code'

export function isMarkdownDocument(preview: DocumentPreview): boolean {
  return preview.presentation.kind === 'markdown'
}

export function classifyReferencePreview(preview: DocumentPreview | undefined): DocumentContentKind {
  switch (preview?.presentation.kind) {
    case 'markdown': return 'markdown'
    case 'code': return 'code'
    case 'pdf': return 'pdf'
    case 'docx': return 'docx'
    case 'xlsx': return 'xlsx'
    case 'web': return 'web'
    case 'image': return 'image'
    case 'video': return 'video'
    case 'audio': return 'audio'
    default: return 'file'
  }
}
