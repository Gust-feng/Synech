import { PRODUCT_DATA_FORMAT_ID } from "../../platform/product-identity.js";

export const DESKTOP_CLOSE_BEHAVIOR_PREFERENCE_NAME = "desktop.close-behavior" as const;
export const DESKTOP_CLOSE_BEHAVIOR_PREFERENCE_KEY = `${PRODUCT_DATA_FORMAT_ID}:${DESKTOP_CLOSE_BEHAVIOR_PREFERENCE_NAME}` as const;

export type DesktopCloseBehavior = "quit" | "hide-to-tray";
export type DesktopWindowCloseAction = "quit" | "hide";
export type DesktopPlatform = "win32" | "darwin" | "linux" | "other";

export const DEFAULT_DESKTOP_CLOSE_BEHAVIOR: DesktopCloseBehavior = "quit";

export function parseDesktopCloseBehavior(value: unknown): DesktopCloseBehavior {
  return value === "hide-to-tray" ? "hide-to-tray" : DEFAULT_DESKTOP_CLOSE_BEHAVIOR;
}

export function normalizeDesktopPlatform(platform: string): DesktopPlatform {
  if (platform === "win32" || platform === "darwin" || platform === "linux") return platform;
  return "other";
}

export function desktopWindowCloseAction(
  platform: DesktopPlatform,
  behavior: DesktopCloseBehavior,
  appQuitting = false,
): DesktopWindowCloseAction {
  if (appQuitting) return "quit";
  return platform === "win32" && behavior === "hide-to-tray" ? "hide" : "quit";
}

export function shouldQuitWhenAllWindowsClosed(platform: DesktopPlatform): boolean {
  return platform !== "darwin";
}
