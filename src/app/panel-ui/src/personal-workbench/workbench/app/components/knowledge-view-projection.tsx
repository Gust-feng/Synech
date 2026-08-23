import {
  Code2,
  FileSpreadsheet,
  FileText,
  FileType2,
  Film,
  Globe,
  Image as ImageIcon,
  Music,
  NotebookPen,
} from 'lucide-react'
import { getNote } from './notesStore'
import type { ResolvedPage } from './brainStore'

export type KnowledgeKind = 'all' | 'note' | 'file' | 'pdf' | 'docx' | 'xlsx' | 'web' | 'image' | 'video' | 'audio' | 'code'

export const KNOWLEDGE_FILTERS: readonly { readonly key: KnowledgeKind; readonly label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'note', label: '笔记' },
  { key: 'file', label: '文件' },
  { key: 'pdf', label: 'PDF' },
  { key: 'docx', label: '文档' },
  { key: 'xlsx', label: '表格' },
  { key: 'web', label: '网页' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'code', label: '代码' },
]

export function formatKnowledgeTimeAgo(timestamp: number): string {
  const seconds = (Date.now() - timestamp) / 1000
  if (seconds < 60) return '刚刚'
  const minutes = seconds / 60
  if (minutes < 60) return `${Math.floor(minutes)} 分钟前`
  const hours = minutes / 60
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  const days = hours / 24
  if (days < 7) return `${Math.floor(days)} 天前`
  return `${Math.floor(days / 7)} 周前`
}

export function knowledgePageIcon(page: ResolvedPage, size = 13) {
  if (page.kind === 'note') return <NotebookPen size={size} style={{ color: '#6f8778' }} />
  switch (page.contentKind) {
    case 'web':
      return <Globe size={size} style={{ color: '#6686a2' }} />
    case 'image':
      return <ImageIcon size={size} style={{ color: '#7d8a63' }} />
    case 'video':
      return <Film size={size} style={{ color: '#8a6aa0' }} />
    case 'audio':
      return <Music size={size} style={{ color: '#b0885a' }} />
    case 'code':
      return <Code2 size={size} style={{ color: '#5f8a86' }} />
    case 'docx':
      return <FileType2 size={size} style={{ color: '#6686a2' }} />
    case 'xlsx':
      return <FileSpreadsheet size={size} style={{ color: '#6f8778' }} />
    default:
      return <FileText size={size} style={{ color: '#c07a55' }} />
  }
}

export function knowledgeKindLabel(page: ResolvedPage): string | undefined {
  return page.kind === 'note'
    ? '笔记'
    : {
        file: '文件',
        pdf: 'PDF',
        docx: 'Word 文档',
        xlsx: 'Excel 表格',
        web: '网页',
        image: '图片',
        video: '视频',
        markdown: 'Markdown',
        audio: '音频',
        code: '代码',
      }[page.contentKind ?? 'pdf']
}

export function matchesKnowledgeFilter(page: ResolvedPage, filter: KnowledgeKind): boolean {
  if (filter === 'all') return true
  if (filter === 'note') return page.kind === 'note'
  return page.kind !== 'note' && page.contentKind === filter
}

export function cleanKnowledgeText(source: string | undefined): string {
  if (!source) return ''
  return source
    .replace(/\\n/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
}

/** Uses each reference's real body for previews instead of inventing a summary. */
export function getKnowledgePreviewText(page: ResolvedPage): string {
  if (page.kind === 'note') return cleanKnowledgeText(getNote(page.refId)?.bodyMarkdown).slice(0, 280)
  return cleanKnowledgeText(page.previewText).slice(0, 280)
}
