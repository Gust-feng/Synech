import { readLocalPreference, writeLocalPreference } from "./local-preferences";

export type ModelIconStyle = "brand" | "monochrome";
const MODEL_ICON_STYLE_KEY = "appearance.modelIcons";

export function getModelIconStyle(): ModelIconStyle {
  return readLocalPreference(MODEL_ICON_STYLE_KEY) === "monochrome" ? "monochrome" : "brand";
}

export function applyModelIconStyle(style: ModelIconStyle = getModelIconStyle()): void {
  document.documentElement.dataset.modelIconStyle = style;
}

export function setModelIconStyle(style: ModelIconStyle): void {
  writeLocalPreference(MODEL_ICON_STYLE_KEY, style);
  applyModelIconStyle(style);
}
