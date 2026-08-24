import React, { useState } from "react";
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
  const [motionPreference, setMotionPreference] = useState(() => getSavedMotionPreference());
  const [readingPrefs, setReadingPrefs] = useState(() => loadPrefs());

  React.useEffect(() => subscribeMotionSettingsChanged(() => {
    setMotionPreference(getSavedMotionPreference());
  }), []);

  React.useEffect(() => subscribeReadingPreferencesChanged(() => {
    setReadingPrefs(loadPrefs());
  }), []);

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
