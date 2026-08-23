import { readLocalPreference, writeLocalPreference } from "./app-local-preferences";

export type MotionPreferenceId = "system" | "standard" | "reduced";
export type EffectiveMotionId = "standard" | "reduced";

export const STORAGE_MOTION_KEY = "theme.motion";
export const MOTION_SETTINGS_CHANGED_EVENT = "synech:motion-settings-changed";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

let systemMotionMedia: MediaQueryList | undefined;
let systemMotionMediaListener: (() => void) | undefined;

export function isValidMotionPreference(value: string | null | undefined): value is MotionPreferenceId {
  return value === "system" || value === "standard" || value === "reduced";
}

export function getSavedMotionPreference(): MotionPreferenceId {
  const value = readLocalPreference(STORAGE_MOTION_KEY);
  if (isValidMotionPreference(value)) return value;
  return "system";
}

export function saveMotionPreference(preference: MotionPreferenceId): void {
  writeLocalPreference(STORAGE_MOTION_KEY, preference);
}

export function getEffectiveMotionPreference(
  preference: MotionPreferenceId = getSavedMotionPreference(),
): EffectiveMotionId {
  if (preference === "reduced") return "reduced";
  if (preference === "standard") return "standard";
  return readSystemReducedMotion() ? "reduced" : "standard";
}

export function applyMotionPreference(preference: MotionPreferenceId = getSavedMotionPreference()): EffectiveMotionId {
  const effectiveMotion = getEffectiveMotionPreference(preference);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.dataset.motion = preference;
    root.dataset.motionEffective = effectiveMotion;
  }
  configureSystemMotionListener(preference);
  return effectiveMotion;
}

export function isReducedMotionEffective(): boolean {
  return getEffectiveMotionPreference() === "reduced";
}

export function shouldUseMotion(): boolean {
  return getEffectiveMotionPreference() === "standard";
}

export function dispatchMotionSettingsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MOTION_SETTINGS_CHANGED_EVENT));
}

export function subscribeMotionSettingsChanged(callback: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(MOTION_SETTINGS_CHANGED_EVENT, callback);
  return () => window.removeEventListener(MOTION_SETTINGS_CHANGED_EVENT, callback);
}

function readSystemReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function configureSystemMotionListener(preference: MotionPreferenceId): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  if (preference !== "system") {
    removeSystemMotionListener();
    return;
  }
  if (systemMotionMedia !== undefined && systemMotionMediaListener !== undefined) return;
  systemMotionMedia = window.matchMedia(REDUCED_MOTION_QUERY);
  systemMotionMediaListener = () => {
    if (getSavedMotionPreference() !== "system") return;
    applyMotionPreference("system");
    dispatchMotionSettingsChanged();
  };
  systemMotionMedia.addEventListener("change", systemMotionMediaListener);
}

function removeSystemMotionListener(): void {
  if (systemMotionMedia !== undefined && systemMotionMediaListener !== undefined) {
    systemMotionMedia.removeEventListener("change", systemMotionMediaListener);
  }
  systemMotionMedia = undefined;
  systemMotionMediaListener = undefined;
}
