import React from "react"
import { AlertCircle, RotateCcw } from "lucide-react"

type ErrorBoundaryState = {
  readonly error?: Error
}

/**
 * 应用级错误边界
 * 捕获子组件树中未处理的渲染异常，显示友好错误页并提供刷新入口
 */
export class ErrorBoundary extends React.Component<
  { readonly children: React.ReactNode },
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = {}

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack)
  }

  override render(): React.ReactNode {
    if (this.state.error !== undefined) {
      return <ErrorFallback error={this.state.error} />
    }
    return this.props.children
  }
}

function ErrorFallback({ error }: { readonly error: Error }): React.ReactElement {
  return (
    <div className="aa-global-error">
      <div className="aa-global-error__panel" role="alert">
        <AlertCircle className="aa-global-error__icon" size={18} />
        <h1>工作台遇到问题</h1>
        <p>
          页面发生了意外错误，可以尝试刷新恢复。
        </p>
        <pre>{error.message}</pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
        >
          <RotateCcw size={13} />
          刷新页面
        </button>
      </div>
    </div>
  )
}