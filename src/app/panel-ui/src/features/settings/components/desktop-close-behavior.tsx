import React, { useState } from "react";
import { Monitor, PanelBottomClose, Power } from "lucide-react";
import {
  DESKTOP_CLOSE_BEHAVIOR_PREFERENCE_NAME,
  parseDesktopCloseBehavior,
  type DesktopCloseBehavior,
} from "@panel-api/desktop-lifecycle";
import { readLocalPreference, writeLocalPreference } from "../../../shell/local-preferences";
import { CapabilitySettingsSection } from "./capability-section";

export function DesktopCloseBehaviorSettings(): React.ReactElement | null {
  const platform = typeof window === "undefined" ? "other" : window.desktopHost?.platform ?? "other";
  const [behavior, setBehavior] = useState<DesktopCloseBehavior>(() =>
    parseDesktopCloseBehavior(readLocalPreference(DESKTOP_CLOSE_BEHAVIOR_PREFERENCE_NAME))
  );

  if (platform === "darwin") {
    return (
      <CapabilitySettingsSection icon={<Monitor size={16} />} title="桌面行为">
        <div className="capability-preference-row">
          <strong>关闭主窗口时</strong>
          <span className="settings-value">保留后台运行</span>
        </div>
      </CapabilitySettingsSection>
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
    <CapabilitySettingsSection icon={<Monitor size={16} />} title="桌面行为">
      <div className="capability-preference-row">
        <div className="capability-preference-copy"><strong id="desktop-close-label">关闭主窗口时</strong></div>
        <div className="capability-choice-group" role="radiogroup" aria-labelledby="desktop-close-label">
          <label>
            <input type="radio" name="desktop-close-behavior" value="hide-to-tray"
              checked={behavior === "hide-to-tray"} onChange={() => changeBehavior("hide-to-tray")} />
            <span><PanelBottomClose size={15} />最小化到托盘</span>
          </label>
          <label>
            <input type="radio" name="desktop-close-behavior" value="quit"
              checked={behavior === "quit"} onChange={() => changeBehavior("quit")} />
            <span><Power size={15} />退出应用</span>
          </label>
        </div>
      </div>
    </CapabilitySettingsSection>
  );
}
