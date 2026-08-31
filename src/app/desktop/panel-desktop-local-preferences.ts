import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type DesktopLocalPreferenceStoreOptions = { readonly userDataDirectory: string };
export type DesktopLocalPreferenceStore = {
  readonly preferencePath: string;
  read(key: unknown): string | undefined;
  write(payload: unknown): boolean;
  readAll(): Record<string, string>;
};

const DESKTOP_LOCAL_PREFERENCE_FILE = "synech-local-preferences.json";

export function createDesktopLocalPreferenceStore(options: DesktopLocalPreferenceStoreOptions): DesktopLocalPreferenceStore {
  const preferencePath = desktopLocalPreferencePath(options.userDataDirectory);
  let cachedPreferences: Record<string, string> | undefined;
  const readAll = (): Record<string, string> => {
    cachedPreferences ??= readDesktopLocalPreferences(preferencePath);
    return { ...cachedPreferences };
  };
  return {
    preferencePath,
    read(key: unknown): string | undefined {
      const normalizedKey = normalizeDesktopLocalPreferenceKey(key);
      return normalizedKey === undefined ? undefined : readAll()[normalizedKey];
    },
    write(payload: unknown): boolean {
      const preference = readDesktopLocalPreferencePayload(payload);
      if (preference === undefined) return false;
      const preferences = readAll();
      preferences[preference.key] = preference.value;
      const saved = persistDesktopLocalPreferences(preferencePath, preferences);
      if (saved) cachedPreferences = preferences;
      return saved;
    },
    readAll,
  };
}

export function normalizeDesktopLocalPreferenceKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return /^synech\/v1:[a-z0-9][a-z0-9._-]*$/i.test(key) ? key : undefined;
}

function readDesktopLocalPreferencePayload(payload: unknown): { readonly key: string; readonly value: string } | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as { readonly key?: unknown; readonly value?: unknown };
  const key = normalizeDesktopLocalPreferenceKey(record.key);
  const value = typeof record.value === "string" ? record.value : undefined;
  return key === undefined || value === undefined ? undefined : { key, value };
}

function desktopLocalPreferencePath(userDataDirectory: string): string {
  return path.join(userDataDirectory, DESKTOP_LOCAL_PREFERENCE_FILE);
}

function readDesktopLocalPreferences(preferencePath: string): Record<string, string> {
  if (!existsSync(preferencePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(preferencePath, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object") return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      const normalizedKey = normalizeDesktopLocalPreferenceKey(key);
      if (normalizedKey !== undefined && typeof value === "string") result[normalizedKey] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function persistDesktopLocalPreferences(preferencePath: string, preferences: Record<string, string>): boolean {
  try {
    mkdirSync(path.dirname(preferencePath), { recursive: true });
    const tempPath = `${preferencePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
    renameSync(tempPath, preferencePath);
    return true;
  } catch {
    return false;
  }
}
