import { readLocalPreference, writeLocalPreference } from "../../../shell/local-preferences";

const STORAGE_MODEL_USAGE_DISPLAY_KEY = "model.usage-display";

export const MODEL_USAGE_DISPLAY_CHANGED_EVENT = "synech:model-usage-display-changed";

export function getModelUsageDisplayEnabled(): boolean {
  return readLocalPreference(STORAGE_MODEL_USAGE_DISPLAY_KEY) === "true";
}

export function saveModelUsageDisplayEnabled(enabled: boolean): void {
  writeLocalPreference(STORAGE_MODEL_USAGE_DISPLAY_KEY, enabled ? "true" : "false");
  dispatchModelUsageDisplayChanged();
}

export function subscribeModelUsageDisplayChanged(callback: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(MODEL_USAGE_DISPLAY_CHANGED_EVENT, callback);
  return () => window.removeEventListener(MODEL_USAGE_DISPLAY_CHANGED_EVENT, callback);
}

function dispatchModelUsageDisplayChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MODEL_USAGE_DISPLAY_CHANGED_EVENT));
}
