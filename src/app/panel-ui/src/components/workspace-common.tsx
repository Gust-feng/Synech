import React from "react";

export function EmptyBlock({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <div className="workspace-empty">{children}</div>;
}

export function SettingRow(props: { readonly label: string; readonly children: React.ReactNode }): React.ReactElement {
  return (
    <div className="settings-row">
      <span>{props.label}</span>
      <div>{props.children}</div>
    </div>
  );
}