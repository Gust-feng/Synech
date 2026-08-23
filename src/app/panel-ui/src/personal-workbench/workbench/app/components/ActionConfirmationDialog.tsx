import { AlertTriangle, ArrowRight, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'

export type ActionConfirmationRequest = {
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly consequence?: string
  readonly confirmLabel: string
  readonly destructive?: boolean
}

export function ActionConfirmationDialog(props: {
  readonly request?: ActionConfirmationRequest
  readonly onCancel: () => void
  readonly onConfirm: () => void | Promise<void>
}): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (props.request === undefined) return undefined
    setBusy(false)
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined
    dialogRef.current?.querySelector<HTMLButtonElement>('[data-confirm-cancel]')?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      props.onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previousActiveElement?.isConnected) previousActiveElement.focus()
    }
  }, [busy, props.onCancel, props.request])

  if (props.request === undefined || typeof document === 'undefined') return null

  const titleElementId = `action-confirmation-title-${titleId.replace(/:/gu, '')}`
  const descriptionElementId = `action-confirmation-description-${descriptionId.replace(/:/gu, '')}`
  const tone = props.request.destructive === false ? 'standard' : 'danger'

  const confirm = (): void => {
    if (busy) return
    setBusy(true)
    void Promise.resolve(props.onConfirm()).finally(() => setBusy(false))
  }

  return createPortal(
    <div className="aa-action-confirmation-layer">
      <button
        type="button"
        className="aa-action-confirmation-backdrop"
        aria-label="取消确认"
        onClick={props.onCancel}
        disabled={busy}
      />
      <div
        ref={dialogRef}
        className="aa-action-confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleElementId}
        aria-describedby={descriptionElementId}
        data-tone={tone}
      >
        <header className="aa-action-confirmation-header">
          <span className="aa-action-confirmation-icon" aria-hidden="true">
            <AlertTriangle size={18} strokeWidth={1.8} />
          </span>
          <div className="aa-action-confirmation-eyebrow">
            <span>{props.request.eyebrow}</span>
            <small>需要确认</small>
          </div>
          <button
            type="button"
            className="aa-action-confirmation-close"
            aria-label="取消确认"
            onClick={props.onCancel}
            disabled={busy}
          >
            <X size={16} />
          </button>
        </header>

        <div className="aa-action-confirmation-copy">
          <h2 id={titleElementId}>{props.request.title}</h2>
          <p id={descriptionElementId}>{props.request.description}</p>
        </div>

        {props.request.consequence !== undefined && (
          <div className="aa-action-confirmation-consequence">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{props.request.consequence}</span>
          </div>
        )}

        <footer className="aa-action-confirmation-actions">
          <button
            type="button"
            className="aa-action-confirmation-cancel"
            data-confirm-cancel
            onClick={props.onCancel}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="aa-action-confirmation-confirm"
            data-confirm-submit
            data-tone={tone}
            onClick={confirm}
            disabled={busy}
          >
            <span>{busy ? '处理中...' : props.request.confirmLabel}</span>
            {!busy && <ArrowRight size={14} aria-hidden="true" />}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
