import React, { useEffect, useRef, useState } from "react";
import type { CommandShellConfig, CommandShellKind, ConfiguredCommandShellKind } from "../contracts/config";
import { SettingsSelectControl } from "./settings-select-control";
import { SettingRow } from "./workspace-common";

export function CommandShellSelection(props: {
  readonly commandShell?: CommandShellConfig;
  readonly savingCommandShell?: boolean;
  readonly onSaveCommandShell: (kind: ConfiguredCommandShellKind) => Promise<void> | void;
}): React.ReactElement {
  const commandShellSaveVersionRef = useRef(0);
  const persistedCommandShellKind = props.commandShell?.configuredKind ?? props.commandShell?.kind ?? "auto";
  const [selectedCommandShellKind, setSelectedCommandShellKind] = useState<ConfiguredCommandShellKind>(persistedCommandShellKind);

  useEffect(() => {
    setSelectedCommandShellKind(persistedCommandShellKind);
  }, [persistedCommandShellKind]);

  function saveCommandShell(nextKind: ConfiguredCommandShellKind): void {
    const saveVersion = commandShellSaveVersionRef.current + 1;
    commandShellSaveVersionRef.current = saveVersion;
    setSelectedCommandShellKind(nextKind);
    void Promise.resolve(props.onSaveCommandShell(nextKind)).catch(() => {
      if (commandShellSaveVersionRef.current === saveVersion) {
        setSelectedCommandShellKind(persistedCommandShellKind);
      }
    });
  }

  const commandShellPending = props.savingCommandShell === true && selectedCommandShellKind !== persistedCommandShellKind;

  return (
    <section className="settings-card">
      <h3>命令 Shell</h3>
      <SettingRow label="运行环境">
        <SettingsSelectControl
          id="command-shell"
          ariaLabel="运行环境"
          value={selectedCommandShellKind}
          options={[
            { value: "auto", label: "自动" },
            ...commandShellOptions(props.commandShell).map((option) => ({
              value: option.kind,
              label: option.label,
              disabled: option.disabled,
              ...(option.disabledLabel === undefined ? {} : { disabledLabel: option.disabledLabel }),
            })),
          ]}
          busy={commandShellPending}
          onChange={(value) => saveCommandShell(commandShellKind(value))}
        />
      </SettingRow>
      <SettingRow label="当前执行">
        <span className="settings-value">{commandShellSummary(props.commandShell, commandShellPending ? selectedCommandShellKind : undefined)}</span>
      </SettingRow>
    </section>
  );
}

function commandShellKind(value: string): ConfiguredCommandShellKind {
  return value === "cmd" ||
    value === "powershell" ||
    value === "pwsh" ||
    value === "bash" ||
    value === "sh"
    ? value
    : "auto";
}

function commandShellOptions(shell: CommandShellConfig | undefined): readonly {
  readonly kind: CommandShellKind;
  readonly label: string;
  readonly disabled: boolean;
  readonly disabledLabel?: string;
}[] {
  const detected = shell?.availableShells?.filter((option): option is {
    readonly kind: CommandShellKind;
    readonly label?: string;
    readonly availability?: "available" | "missing";
  } => option.kind === "cmd" ||
    option.kind === "powershell" ||
    option.kind === "pwsh" ||
    option.kind === "bash" ||
    option.kind === "sh");
  if (detected !== undefined && detected.length > 0) {
    return detected.map((option) => ({
      kind: option.kind,
      label: option.label ?? defaultShellOptionLabel(option.kind),
      disabled: option.availability === "missing" && option.kind !== shell?.configuredKind,
      ...(option.availability === "missing" && option.kind !== shell?.configuredKind
        ? { disabledLabel: "未检测到" }
        : {}),
    }));
  }
  return [
    { kind: "cmd", label: "cmd", disabled: false },
    { kind: "powershell", label: "Windows PowerShell", disabled: false },
    { kind: "pwsh", label: "PowerShell", disabled: false },
    { kind: "bash", label: "Bash", disabled: false },
    { kind: "sh", label: "POSIX sh", disabled: false },
  ];
}

function commandShellSummary(shell: CommandShellConfig | undefined, pendingKind?: ConfiguredCommandShellKind): string {
  if (pendingKind !== undefined) {
    return `保存中：${defaultShellOptionLabel(pendingKind)}`;
  }
  if (shell === undefined) {
    return "自动";
  }
  const label = shell.label ?? shell.kind ?? "自动";
  const executable = shell.executable;
  const syntax = shell.syntax;
  const mode = shell.configuredKind === "auto" || shell.autoDetected === true ? "自动" : undefined;
  return [mode, label, executable, syntax === undefined ? undefined : `语法：${syntax}`]
    .filter((item): item is string => item !== undefined && item.trim().length > 0)
    .join(" · ");
}

function defaultShellOptionLabel(kind: ConfiguredCommandShellKind): string {
  if (kind === "auto") return "自动";
  if (kind === "cmd") return "cmd";
  if (kind === "powershell") return "Windows PowerShell";
  if (kind === "pwsh") return "PowerShell";
  if (kind === "bash") return "Bash";
  return "POSIX sh";
}