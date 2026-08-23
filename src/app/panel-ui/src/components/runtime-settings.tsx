import React from "react";
import type { CommandShellConfig, ConfiguredCommandShellKind } from "../contracts/config";
import { CommandShellSelection } from "./command-shell-selection";
import { RuntimeEnvironmentSettings } from "./runtime-environment-settings";

export function RuntimeSettings(props: {
  readonly commandShell?: CommandShellConfig;
  readonly savingCommandShell?: boolean;
  readonly onSaveCommandShell: (kind: ConfiguredCommandShellKind) => Promise<void> | void;
}): React.ReactElement {
  return (
    <div className="workspace-settings-stack">
      <CommandShellSelection
        commandShell={props.commandShell}
        savingCommandShell={props.savingCommandShell}
        onSaveCommandShell={props.onSaveCommandShell}
      />
      <RuntimeEnvironmentSettings tools={props.commandShell?.runtimeTools} />
    </div>
  );
}
