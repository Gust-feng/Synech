import React from "react";
import "./workbench-bootstrap-loading.css";

export function WorkbenchBootstrapLoading(): React.ReactElement {
  return (
    <div
      className="workbench-bootstrap-loading"
      role="status"
      aria-live="polite"
      aria-label="正在准备工作台"
    >
      <div className="workbench-bootstrap-loading__visual" aria-hidden="true">
        <span className="workbench-bootstrap-loading__frame">
          <span className="workbench-bootstrap-loading__header" />
          <span className="workbench-bootstrap-loading__rail" />
          <span className="workbench-bootstrap-loading__canvas">
            <span />
            <span />
          </span>
        </span>
        <span className="workbench-bootstrap-loading__progress">
          <span />
        </span>
      </div>
    </div>
  );
}
