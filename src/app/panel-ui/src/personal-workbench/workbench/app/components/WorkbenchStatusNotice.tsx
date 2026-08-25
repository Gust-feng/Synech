import type { ReactElement } from "react";
import { AlertCircle, RotateCcw, X } from "lucide-react";

export type WorkbenchStatusNoticeProps = {
  readonly message: string;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  readonly onDismiss?: () => void;
};

export function WorkbenchStatusNotice(props: WorkbenchStatusNoticeProps): ReactElement {
  return (
    <div
      className="fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-2.5 rounded-md px-3 py-2.5 shadow-sm"
      style={{ background: "var(--ui-surface)", border: "1px solid var(--ui-border)", color: "var(--ui-text-2)" }}
      role="alert"
    >
      <AlertCircle className="mt-0.5 shrink-0" size={14} style={{ color: "var(--ui-status-error)" }} />
      <span className="min-w-0 flex-1 break-words text-xs leading-5">{props.message}</span>
      {props.onRetry !== undefined && (
        <button
          type="button"
          aria-label="重新加载工作台数据"
          onClick={props.onRetry}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--ui-hover-tint)] disabled:opacity-40"
          style={{ color: "var(--ui-text-3)" }}
          disabled={props.retrying}
        >
          <RotateCcw className={props.retrying ? "animate-spin" : undefined} size={12} />
        </button>
      )}
      {props.onDismiss !== undefined && (
        <button
          type="button"
          aria-label="关闭错误提示"
          onClick={props.onDismiss}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--ui-hover-tint)]"
          style={{ color: "var(--ui-text-3)" }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
