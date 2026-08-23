import { useEffect, useState } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import {
  getCachedDocxPreviewMarkup,
  loadDocxPreviewMarkup,
  type DocxPreviewMarkup,
} from './officePreviewRuntime'
import './office-document.css'

export function DocxDocumentSurface({ url, byteLength, sourceVersion }: {
  url: string
  byteLength?: number
  sourceVersion?: string
}) {
  const [markup, setMarkup] = useState<DocxPreviewMarkup | undefined>(() => getCachedDocxPreviewMarkup(url, sourceVersion))
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(() => markup === undefined ? 'loading' : 'ready')
  const [message, setMessage] = useState('正在读取文档...')

  useEffect(() => {
    const controller = new AbortController()
    const cached = getCachedDocxPreviewMarkup(url, sourceVersion)
    if (cached !== undefined) {
      setMarkup(cached)
      setState('ready')
      return () => controller.abort()
    }
    setMarkup(undefined)
    setState('loading')
    setMessage('正在读取文档...')

    void loadDocxPreviewMarkup({ url, byteLength, sourceVersion, signal: controller.signal }).then((nextMarkup) => {
      if (controller.signal.aborted) return
      setMarkup(nextMarkup)
      setState('ready')
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setMessage(reason instanceof Error ? reason.message : '无法读取这个 Word 文档。')
      setState('error')
    })

    return () => controller.abort()
  }, [byteLength, sourceVersion, url])

  return (
    <div className="aa-docx-document" data-state={state} data-document-scroll="content">
      {state !== 'ready' && (
        <div className="aa-office-document__state" role={state === 'error' ? 'alert' : 'status'}>
          {state === 'error' ? <AlertTriangle size={20} /> : <LoaderCircle size={20} className="aa-office-document__spinner" />}
          <span>{message}</span>
        </div>
      )}
      <div
        className="aa-docx-document__styles"
        aria-hidden="true"
        dangerouslySetInnerHTML={markup === undefined ? undefined : { __html: markup.styleHtml }}
      />
      <div
        className="aa-docx-document__body"
        aria-label="Word 文档内容"
        dangerouslySetInnerHTML={markup === undefined ? undefined : { __html: markup.bodyHtml }}
      />
    </div>
  )
}