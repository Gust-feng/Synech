import React, { useState } from "react";
import {
  DESKTOP_CLOSE_BEHAVIOR_PREFERENCE_NAME,
  parseDesktopCloseBehavior,
  type DesktopCloseBehavior,
} from "@panel-api/desktop-lifecycle";
import { readLocalPreference, writeLocalPreference } from "../../../shell/local-preferences";
import { SettingRow } from "../../../components/workspace-common";
import { SettingsSelectControl } from "./select-control";

export function DesktopCloseBehaviorSettings(): React.ReactElement | null {
  const platform = typeof window === "undefined" ? "other" : window.desktopHost?.platform ?? "other";
  const [behavior, setBehavior] = useState<DesktopCloseBehavior>(() =>
    parseDesktopCloseBehavior(readLocalPreference(DESKTOP_CLOSE_BEHAVIOR_PREFERENCE_NAME))
  );

  if (platform === "darwin") {
    return (
      <section className="settings-card">
        <h3>关闭窗口</h3>
        <SettingRow label="应用行为">
          <span className="settings-value">关闭窗口后继续运行，使用 ⌘Q 退出 Synech。</span>
        </SettingRow>
      </section>
    );
  }

  if (platform !== "win32") return null;

  function changeBehavior(nextBehavior: DesktopCloseBehavior): void {
    if (nextBehavior === behavior) return;
    if (writeLocalPreference(DESKTOP_CLOSE_BEHAVIOR_PREFERENCE_NAME, nextBehavior)) {
      setBehavior(nextBehavior);
    }
  }

  return (
    <section className="settings-card">
      <h3>关闭窗口</h3>
      <SettingRow label="关闭窗口时">
        <SettingsSelectControl
          id="desktop-close-behavior"
          ariaLabel="关闭窗口时"
          value={behavior}
          options={[
            { value: "quit", label: "退出 Synech" },
            { value: "hide-to-tray", label: "关闭到通知区域" },
          ]}
          onChange={(value) => changeBehavior(value === "hide-to-tray" ? "hide-to-tray" : "quit")}
        />
      </SettingRow>
      <p className="settings-value">关闭到通知区域后，Synech 会继续运行，可从托盘图标重新打开。</p>
    </section>
  );
}
