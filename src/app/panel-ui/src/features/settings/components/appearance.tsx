import { SvgMark } from "../../../components/svg-mark";
import { Monitor, Moon, Sun } from "lucide-react";
import { applyTheme, getInitialTheme, saveColorId, saveStyleId, type ThemeColorId } from "../../../shell/theme";
import React, { useState } from "react";
import { getModelIconStyle, setModelIconStyle, type ModelIconStyle } from "../../../shell/model-icon-preference";
import { resolveModelIconSvg } from "../model/icons";
import {
  applyMotionPreference,
  dispatchMotionSettingsChanged,
  getEffectiveMotionPreference,
  getSavedMotionPreference,
  saveMotionPreference,
  subscribeMotionSettingsChanged,
  type MotionPreferenceId,
} from "../../../shell/motion";
import {
  loadPrefs,
  readingBodySizePx,
  savePrefs,
  SIZE_PX,
  subscribeReadingPreferencesChanged,
  type ReadingSize,
} from "../../../shell/reading-preferences";

type AppearanceColorId = Extract<ThemeColorId, "system" | "light" | "dark">;

const THEME_OPTIONS: readonly { readonly id: AppearanceColorId; readonly label: string; readonly icon: typeof Sun }[] = [
  { id: "light", label: "浅色", icon: Sun },
  { id: "dark", label: "深色", icon: Moon },
  { id: "system", label: "跟随系统", icon: Monitor },
];

const MOTION_OPTIONS: readonly { readonly id: MotionPreferenceId; readonly label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "standard", label: "标准" },
  { id: "reduced", label: "减少动效" },
];

const READING_SIZE_OPTIONS: readonly { readonly id: ReadingSize; readonly label: string }[] = [
  { id: "small", label: "紧凑" },
  { id: "medium", label: "标准" },
  { id: "large", label: "大号" },
];

export function AppearanceSettings(): React.ReactElement {
  const [theme, setTheme] = useState(() => getInitialTheme());
  const [iconStyle, setIconStyle] = useState<ModelIconStyle>(() => getModelIconStyle());
  const [motionPreference, setMotionPreference] = useState(() => getSavedMotionPreference());
  const [readingPrefs, setReadingPrefs] = useState(() => loadPrefs());

  React.useEffect(() => subscribeMotionSettingsChanged(() => {
    setMotionPreference(getSavedMotionPreference());
  }), []);

  React.useEffect(() => subscribeReadingPreferencesChanged(() => {
    setReadingPrefs(loadPrefs());
  }), []);

  function changeTheme(colorId: AppearanceColorId): void {
    if (theme.styleId === "default" && theme.colorId === colorId) return;
    const nextTheme = applyTheme("default", colorId);
    saveStyleId(nextTheme.styleId);
    saveColorId(nextTheme.colorId);
    setTheme(nextTheme);
  }

  function changeMotionPreference(nextPreference: MotionPreferenceId): void {
    if (nextPreference === motionPreference) return;
    saveMotionPreference(nextPreference);
    applyMotionPreference(nextPreference);
    setMotionPreference(nextPreference);
    dispatchMotionSettingsChanged();
  }

  function changeReadingSize(size: ReadingSize): void {
    if (readingBodySizePx(readingPrefs) === SIZE_PX[size]) return;
    const next = { font: readingPrefs.font, width: readingPrefs.width, size };
    savePrefs(next);
    setReadingPrefs(next);
  }

  const effectiveMotionLabel = getEffectiveMotionPreference(motionPreference) === "reduced" ? "减少动效" : "标准";
  const currentReadingSizePx = readingBodySizePx(readingPrefs);

  return (
    <div className="workspace-settings-stack">
      <section className="settings-card appearance-preference-card">
        <div className="settings-card-title-row"><h3>主题</h3></div>
        <div className="appearance-preference-options" role="radiogroup" aria-label="界面主题">
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon;
            const active = theme.styleId === "default" && theme.colorId === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className={"appearance-preference-option appearance-theme-option" + (active ? " active" : "")}
                role="radio"
                aria-checked={active}
                onClick={() => changeTheme(option.id)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="settings-card appearance-icon-card">
        <div className="settings-card-title-row"><h3>模型与厂商图标</h3></div>
        <div className="appearance-icon-options" role="radiogroup" aria-label="模型与厂商图标">
          {([
            { id: "brand", label: "品牌原色", detail: "保留品牌配色" },
            { id: "monochrome", label: "主题单色", detail: "随界面主题变色" },
          ] as const).map((option) => (
            <button
              key={option.id}
              type="button"
              className={"appearance-icon-option" + (iconStyle === option.id ? " active" : "")}
              role="radio"
              aria-checked={iconStyle === option.id}
              onClick={() => { setModelIconStyle(option.id); setIconStyle(option.id); }}
            >
              <span className="appearance-icon-sample" data-preview-style={option.id} aria-hidden="true">
                {["deepseek", "glm", "gemini", "gpt"].map((identity) => (
                  <SvgMark key={identity} svg={resolveModelIconSvg(identity) ?? ""} />
                ))}
              </span>
              <span className="appearance-icon-label">{option.label}</span>
              <small>{option.detail}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card appearance-preference-card">
        <div className="settings-card-title-row">
          <h3>阅读字号</h3>
          <span>{currentReadingSizePx}px</span>
        </div>
        <div className="appearance-preference-options" role="radiogroup" aria-label="阅读字号">
          {READING_SIZE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`appearance-preference-option${currentReadingSizePx === SIZE_PX[option.id] ? " active" : ""}`}
              role="radio"
              aria-label={`${option.label} ${SIZE_PX[option.id]}px`}
              aria-checked={currentReadingSizePx === SIZE_PX[option.id]}
              onClick={() => changeReadingSize(option.id)}
            >
              <span>{option.label}</span>
              <small>{SIZE_PX[option.id]}px</small>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card appearance-motion-card">
        <div className="settings-card-title-row">
          <h3>动效</h3>
          <span>当前：{effectiveMotionLabel}</span>
        </div>

        <div className="appearance-motion-options" role="radiogroup" aria-label="动效偏好">
          {MOTION_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`appearance-motion-option${motionPreference === option.id ? " active" : ""}`}
              role="radio"
              aria-checked={motionPreference === option.id}
              onClick={() => changeMotionPreference(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

      </section>
    </div>
  );
}
