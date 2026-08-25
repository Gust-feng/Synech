import { useState, type ReactElement } from "react";
import { AlertCircle, ChevronDown, RotateCcw, X } from "lucide-react";

export type WorkbenchStatusNotice = {
  readonly id: string;
  readonly message: string;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  readonly onDismiss?: () => void;
};

export function WorkbenchStatusCenter(props: {
  readonly notices: readonly WorkbenchStatusNotice[];
}): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  const primary = props.notices[0];
  if (primary === undefined) return null;

  return (
    <div className="ui-workbench-status-center" role="status" aria-live="polite">
      <div className="ui-workbench-status-notice" role="alert">
        <AlertCircle className="ui-workbench-status-notice__icon" size={14} aria-hidden="true" />
        <span className="ui-workbench-status-notice__message">{primary.message}</span>
        <NoticeActions notice={primary} />
      </div>
      {props.notices.length > 1 && (
        <>
          <button
            type="button"
            className="ui-workbench-status-center__toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{expanded ? "收起其他问题" : `还有 ${props.notices.length - 1} 个问题`}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {expanded && (
            <div className="ui-workbench-status-center__details">
              {props.notices.slice(1).map((notice) => (
                <div key={notice.id} className="ui-workbench-status-center__detail">
                  <AlertCircle className="ui-workbench-status-notice__icon" size={13} aria-hidden="true" />
                  <span className="ui-workbench-status-notice__message">{notice.message}</span>
                  <NoticeActions notice={notice} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NoticeActions(props: { readonly notice: WorkbenchStatusNotice }): ReactElement {
  return (
    <span className="ui-workbench-status-notice__actions">
      {props.notice.onRetry !== undefined && (
        <button
          type="button"
          aria-label="重试"
          onClick={props.notice.onRetry}
          className="ui-workbench-status-notice__action"
          disabled={props.notice.retrying}
        >
          <RotateCcw className={props.notice.retrying ? "animate-spin" : undefined} size={12} aria-hidden="true" />
        </button>
      )}
      {props.notice.onDismiss !== undefined && (
        <button
          type="button"
          aria-label="关闭"
          onClick={props.notice.onDismiss}
          className="ui-workbench-status-notice__action"
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}