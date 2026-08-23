import { readLocalPreference, writeLocalPreference } from "./app-local-preferences";

const DEVELOPER_MODE_STORAGE_KEY = "developer-mode.enabled";

export function getDeveloperModeEnabled(): boolean {
  return readLocalPreference(DEVELOPER_MODE_STORAGE_KEY) === "true";
}

export function saveDeveloperModeEnabled(enabled: boolean): void {
  writeLocalPreference(DEVELOPER_MODE_STORAGE_KEY, enabled ? "true" : "false");
}
