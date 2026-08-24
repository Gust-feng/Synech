import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertCircle, ChevronDown, RotateCcw } from 'lucide-react'

interface SurfaceErrorBoundaryProps {
  readonly children: ReactNode
  readonly resetKey: string
  readonly label: string
  readonly onRetry?: () => void
}

interface SurfaceErrorBoundaryState {
  readonly error?: Error
}

/** Keeps a failed deferred capability inside the workbench surface that owns it. */
export class SurfaceErrorBoundary extends Component<SurfaceErrorBoundaryProps, SurfaceErrorBoundaryState> {
  override state: SurfaceErrorBoundaryState = {}

  static getDerivedStateFromError(error: Error): SurfaceErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[SurfaceErrorBoundary]', error, info.componentStack)
  }

  override componentDidUpdate(previous: SurfaceErrorBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== undefined) {
      this.setState({ error: undefined })
    }
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children
    return (
      <DeferredFailure
        label={this.props.label}
        detail={this.state.error.message}
        onRetry={this.props.onRetry ?? (() => window.location.reload())}
      />
    )
  }
}

function DeferredFailure(props: {
  readonly label: string
  readonly detail: string
  readonly onRetry: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6" role="alert">
      <div
        className="w-full max-w-md border-l-2 py-1 pl-5"
        style={{ borderColor: 'var(--ui-status-error)' }}
      >
        <div className="flex items-center gap-2">
          <AlertCircle className="shrink-0" size={16} style={{ color: 'var(--ui-status-error)' }} />
          <p className="text-sm font-medium" style={{ color: 'var(--ui-text-1)' }}>{props.label}</p>
        </div>
        <p className="mt-2 text-xs leading-5" style={{ color: 'var(--ui-text-2)' }}>
          重新加载后再试。
        </p>
        <div className="relative mt-4 h-7">
          <button
            type="button"
            onClick={props.onRetry}
            className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors hover:bg-[var(--ui-hover-tint)] focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ background: 'var(--ui-accent-bg)', color: 'var(--ui-accent)' }}
          >
            <RotateCcw size={12} />
            重新加载
          </button>
          {props.detail.length > 0 && (
            <details className="group absolute top-0 left-24 z-10 min-w-0">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs transition-colors hover:opacity-75" style={{ color: 'var(--ui-text-3)' }}>
                错误详情
                <ChevronDown className="transition-transform group-open:rotate-180" size={13} />
              </summary>
              <pre
                className="absolute top-full mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border px-3 py-2.5 select-text text-xs leading-5 shadow-sm"
                style={{
                  left: '-6rem',
                  width: 'min(24rem, calc(100vw - 4rem))',
                  background: 'var(--ui-surface)',
                  borderColor: 'var(--ui-border)',
                  color: 'var(--ui-text-2)',
                }}
              >
                {props.detail}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
