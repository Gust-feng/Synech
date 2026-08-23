import { common, createLowlight } from 'lowlight'
import type { ReactNode } from 'react'
import './reference-preview.css'

type HighlightNode =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'element'; readonly properties: { readonly className?: unknown }; readonly children: readonly HighlightNode[] }

const syntaxHighlighter = createLowlight(common)

export interface CodeDocumentSurfaceProps {
  source: string
  filename?: string
  language?: string
  encoding?: string
  variant?: 'document' | 'cover'
}

export function CodeDocumentSurface({ source, filename, language, encoding, variant = 'document' }: CodeDocumentSurfaceProps) {
  const highlighted = language !== undefined && syntaxHighlighter.registered(language)
    ? syntaxHighlighter.highlight(language, source)
    : undefined

  return (
    <div className={`aa-code-document aa-code-document--${variant}`}>
      {variant === 'document' && <div className="aa-code-document__header">
          <span className="aa-code-document__filename">{filename ?? '代码'}</span>
          {language !== undefined && <span className="aa-code-document__language">{language}</span>}
          {encoding !== undefined && <span className="aa-code-document__encoding">{encoding}</span>}
        </div>}
      <pre className="aa-code-document__source">
        <code>{highlighted === undefined ? source : (highlighted.children as HighlightNode[]).map((node, index) => renderHighlightNode(node, index))}</code>
      </pre>
    </div>
  )
}

function renderHighlightNode(node: HighlightNode, key: number): ReactNode {
  if (node.type === 'text') return node.value
  const className = Array.isArray(node.properties.className) ? node.properties.className.join(' ') : undefined
  return <span key={key} className={className}>{node.children.map((child, index) => renderHighlightNode(child, index))}</span>
}