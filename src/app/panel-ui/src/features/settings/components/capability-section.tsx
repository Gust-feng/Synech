import React from "react";

export function CapabilitySettingsSection(props: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly actions?: React.ReactNode;
  readonly busy?: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="cap-node" aria-label={props.title} aria-busy={props.busy === true}>
      <div className="cap-node-rail" aria-hidden="true">
        <span className="cap-node-dot">{props.icon}</span>
      </div>
      <div className="cap-node-card">
        <header className="cap-group-head">
          <div className="cap-group-heading">
            <h3>{props.title}</h3>
          </div>
          {props.actions !== undefined && <div className="cap-group-actions">{props.actions}</div>}
        </header>
        <div className="cap-group-body">{props.children}</div>
      </div>
    </section>
  );
}
