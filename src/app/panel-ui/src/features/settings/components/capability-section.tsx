import React from "react";

export function CapabilitySettingsSection(props: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly actions?: React.ReactNode;
  readonly busy?: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="cap-card" aria-label={props.title} aria-busy={props.busy === true}>
      <header className="cap-card-head">
        <div className="cap-card-title-group">
          <span className="cap-card-icon-badge" aria-hidden="true">
            {props.icon}
          </span>
          <div className="cap-card-heading">
            <h3>{props.title}</h3>
          </div>
        </div>
        {props.actions !== undefined && <div className="cap-card-actions">{props.actions}</div>}
      </header>
      <div className="cap-card-body">{props.children}</div>
    </section>
  );
}
