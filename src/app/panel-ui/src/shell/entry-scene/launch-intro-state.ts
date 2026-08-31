export type DesktopLaunchMode = "installed" | "updated" | "ordinary";

export type LaunchIntroPhase = "card" | "expanding" | "settled" | "release" | "done";

export const CARD_HOLD_MS = 560;
export const EXPAND_MS = 720;
export const SETTLED_HOLD_MS = 340;
export const UPDATED_SETTLE_MS = 300;
// The release transition is intentionally no longer padded with an invisible
// waiting period: once the scene has settled, hand control back immediately.
export const RELEASE_MS = 360;
export const CARD_MAX_WIDTH = 780;

export function readDesktopLaunchMode(): DesktopLaunchMode {
  if (typeof window === "undefined") return "ordinary";
  const value = new URLSearchParams(window.location.search).get("launch");
  return value === "installed" || value === "updated" ? value : "ordinary";
}

/**
 * 呈现档位：普通启动或 reduced-motion 直接进入最终状态；
 * 安装后首次启动播放完整礼品卡；更新后启动播放缩短版场景展开。
 */
export function initialPhase(mode: DesktopLaunchMode, motionEnabled: boolean): LaunchIntroPhase {
  if (mode === "ordinary" || !motionEnabled) return "done";
  return mode === "installed" ? "card" : "settled";
}
