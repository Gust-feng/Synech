import { readLocalPreference, writeLocalPreference } from "./local-preferences";

const DEVELOPER_MODE_STORAGE_KEY = "developer-mode.enabled";

export function getDeveloperModeEnabled(): boolean {
  return readLocalPreference(DEVELOPER_MODE_STORAGE_KEY) === "true";
}

export function saveDeveloperModeEnabled(enabled: boolean): void {
  writeLocalPreference(DEVELOPER_MODE_STORAGE_KEY, enabled ? "true" : "false");
}

const TOOL_METRICS_STORAGE_KEY = "developer-mode.record-tool-metrics";
export function getToolMetricsRecordingEnabled(): boolean {
  return readLocalPreference(TOOL_METRICS_STORAGE_KEY) === "true";
}
export function saveToolMetricsRecordingEnabled(enabled: boolean): void {
  writeLocalPreference(TOOL_METRICS_STORAGE_KEY, enabled ? "true" : "false");
}
