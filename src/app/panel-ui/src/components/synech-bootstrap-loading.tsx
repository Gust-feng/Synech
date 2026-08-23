import React from "react";
import "./synech-bootstrap-loading.css";

export function SynechBootstrapLoading(): React.ReactElement {
  return (
    <div
      className="synech-bootstrap-loading"
      role="status"
      aria-live="polite"
      aria-label="正在准备工作台"
    >
      <div className="synech-bootstrap-loading__visual" aria-hidden="true">
        <span className="synech-bootstrap-loading__frame">
          <span className="synech-bootstrap-loading__header" />
          <span className="synech-bootstrap-loading__rail" />
          <span className="synech-bootstrap-loading__canvas">
            <span />
            <span />
          </span>
        </span>
        <span className="synech-bootstrap-loading__progress">
          <span />
        </span>
      </div>
    </div>
  );
}
