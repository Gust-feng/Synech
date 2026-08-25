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
      className="ui-workbench-status-notice"
      role="alert"
    >
      <AlertCircle className="ui-workbench-status-notice__icon" size={14} />
      <span className="ui-workbench-status-notice__message">{props.message}</span>
      {props.onRetry !== undefined && (
        <button
          type="button"
          aria-label="重新加载工作台数据"
          onClick={props.onRetry}
          className="ui-workbench-status-notice__action"
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
          className="ui-workbench-status-notice__action"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
