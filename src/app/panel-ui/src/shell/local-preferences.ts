import { PRODUCT_DATA_FORMAT_ID } from "@panel-api/product";

export const PANEL_PREFERENCE_STORAGE_PREFIX = `${PRODUCT_DATA_FORMAT_ID}:`;

export function panelStorageKey(name: string): string {
  return `${PANEL_PREFERENCE_STORAGE_PREFIX}${name}`;
}

export function readLocalPreference(key: string): string | undefined {
  const storageKey = panelStorageKey(key);
  const desktopValue = readDesktopLocalPreference(storageKey);
  if (desktopValue !== undefined) return desktopValue;
  if (typeof localStorage === "undefined") return undefined;
  try {
    return localStorage.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeLocalPreference(key: string, value: string): boolean {
  const storageKey = panelStorageKey(key);
  const desktopSaved = writeDesktopLocalPreference(storageKey, value);
  if (typeof localStorage === "undefined") return desktopSaved;
  let browserSaved = false;
  try {
    localStorage.setItem(storageKey, value);
    browserSaved = true;
  } catch {
    // Browser storage is best-effort; desktop builds persist through the preload bridge.
  }
  return desktopSaved || browserSaved;
}

function readDesktopLocalPreference(key: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.desktopHost?.getLocalPreference(key);
  } catch {
    return undefined;
  }
}

function writeDesktopLocalPreference(key: string, value: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.desktopHost?.setLocalPreference(key, value) === true;
  } catch {
    return false;
  }
}
