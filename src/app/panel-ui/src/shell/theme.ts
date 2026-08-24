/**
 * Panel theme system.
 *
 * Themes have two independent axes:
 * - style: the structural visual language
 * - color: the palette available inside that style
 */

import { shouldUseMotion } from "./motion";
import { readLocalPreference, writeLocalPreference } from "./local-preferences";

export type StyleDefinition = {
  readonly id: ThemeStyleId;
  readonly label: string;
  readonly defaultColorId: ThemeColorId;
};

export type ThemeStyleId = "default" | "classic" | "glass";
export type ThemeColorId = "system" | "light" | "dark" | "warm" | "forest" | "slate" | "aurora" | "sunset" | "ocean";

export const STYLE_REGISTRY: readonly StyleDefinition[] = [
  {
    id: "default",
    label: "经典",
    defaultColorId: "light",
  },
  {
    id: "classic",
    label: "纸页",
    defaultColorId: "warm",
  },
  {
    id: "glass",
    label: "液态玻璃",
    defaultColorId: "aurora",
  },
];

export type ColorSwatch = {
  readonly label: string;
  readonly value: string;
};

export type ColorSchemeDefinition = {
  readonly id: ThemeColorId;
  readonly styleId: ThemeStyleId;
  readonly label: string;
  readonly swatches: readonly ColorSwatch[];
};

export const COLOR_REGISTRY: readonly ColorSchemeDefinition[] = [
  /* Default palettes */
  {
    id: "system",
    styleId: "default",
    label: "跟随系统",
    swatches: [
      { label: "背景", value: "#f5f7fa" },
      { label: "主色", value: "#2563eb" },
      { label: "辅色", value: "#0f131a" },
    ],
  },
  {
    id: "light",
    styleId: "default",
    label: "浅色",
    swatches: [
      { label: "背景", value: "#f7f8fa" },
      { label: "主色", value: "#2563eb" },
      { label: "辅色", value: "#14b8a6" },
    ],
  },
  {
    id: "dark",
    styleId: "default",
    label: "深色",
    swatches: [
      { label: "背景", value: "#1b1b20" },
      { label: "主色", value: "#9892b0" },
      { label: "辅色", value: "#777477" },
    ],
  },
  /* Classic palettes */
  {
    id: "warm",
    styleId: "classic",
    label: "晨纸",
    swatches: [
      { label: "背景", value: "#f1eee7" },
      { label: "主色", value: "#b85f2a" },
      { label: "辅色", value: "#1f7469" },
    ],
  },
  {
    id: "forest",
    styleId: "classic",
    label: "青苔",
    swatches: [
      { label: "背景", value: "#eef2ec" },
      { label: "主色", value: "#216f5d" },
      { label: "辅色", value: "#a06b2c" },
    ],
  },
  {
    id: "slate",
    styleId: "classic",
    label: "桑墨",
    swatches: [
      { label: "背景", value: "#f2efed" },
      { label: "主色", value: "#7a3f55" },
      { label: "辅色", value: "#63704a" },
    ],
  },
  /* Glass palettes */
  {
    id: "aurora",
    styleId: "glass",
    label: "极幕",
    swatches: [
      { label: "背景", value: "#edf7ff" },
      { label: "主色", value: "#775cff" },
      { label: "辅色", value: "#12b8ae" },
    ],
  },
  {
    id: "sunset",
    styleId: "glass",
    label: "暮霞",
    swatches: [
      { label: "背景", value: "#fff1e8" },
      { label: "主色", value: "#d86431" },
      { label: "辅色", value: "#d45c8d" },
    ],
  },
  {
    id: "ocean",
    styleId: "glass",
    label: "海窗",
    swatches: [
      { label: "背景", value: "#eaf8fb" },
      { label: "主色", value: "#1198ad" },
      { label: "辅色", value: "#5a77e6" },
    ],
  },
];

export const DEFAULT_STYLE_ID: ThemeStyleId = "default";
export const DEFAULT_COLOR_ID: ThemeColorId = "light";
export const STORAGE_STYLE_KEY = "theme.style";
export const STORAGE_COLOR_KEY = "theme.color";
const THEME_SWITCHING_CLASS = "theme-switching";
const THEME_TRANSITION_ATTRIBUTE = "data-theme-transition";
const THEME_SWITCHING_DURATION_MS = 300;
const THEME_SWEEP_SWITCHING_DURATION_MS = 720;

type ThemeTransitionKind = "theme-sweep";
type ThemeViewTransition = {
  readonly finished?: Promise<void>;
};
type ViewTransitionDocument = Document & {
  readonly startViewTransition?: (callback: () => void) => ThemeViewTransition;
};

let themeSwitchingTimer: number | undefined;
let themeTransitionVersion = 0;
let systemColorMedia: MediaQueryList | undefined;
let systemColorMediaListener: (() => void) | undefined;

function shouldUseThemeSwitchMotion(): boolean {
  if (typeof window === "undefined") return false;
  return shouldUseMotion();
}

/** Return color schemes available for a given style. */
export function getColorSchemesForStyle(styleId: string): readonly ColorSchemeDefinition[] {
  return COLOR_REGISTRY.filter((c) => c.styleId === styleId);
}

/** Return the default color id for a given style. */
export function getDefaultColorForStyle(styleId: string): ThemeColorId {
  const style = STYLE_REGISTRY.find((candidate) => candidate.id === styleId);
  if (style !== undefined) return style.defaultColorId;
  return DEFAULT_COLOR_ID;
}

/** Validate that a style id exists. */
export function isValidStyle(styleId: string): styleId is ThemeStyleId {
  return STYLE_REGISTRY.some((s) => s.id === styleId);
}

/** Validate that a color id exists (optionally scoped to a style). */
export function isValidColor(colorId: string, styleId?: string): colorId is ThemeColorId {
  return COLOR_REGISTRY.some(
    (c) => c.id === colorId && (styleId === undefined || c.styleId === styleId),
  );
}

export type AppliedTheme = {
  readonly styleId: ThemeStyleId;
  readonly colorId: ThemeColorId;
};

export function normalizeTheme(styleId: string | undefined, colorId: string | undefined): AppliedTheme {
  const normalizedStyleId = styleId !== undefined && isValidStyle(styleId) ? styleId : DEFAULT_STYLE_ID;
  const normalizedColorId = colorId !== undefined && isValidColor(colorId, normalizedStyleId)
    ? colorId
    : getDefaultColorForStyle(normalizedStyleId);
  return {
    styleId: normalizedStyleId,
    colorId: normalizedColorId,
  };
}

/** Apply style by setting [data-style] on <html>. */
export function applyStyle(styleId: string): AppliedTheme {
  const currentColorId = typeof document === "undefined"
    ? undefined
    : currentColorPreference();
  return applyTheme(styleId, currentColorId);
}

/** Apply color by setting [data-color] on <html>. */
export function applyColor(colorId: string): AppliedTheme {
  const currentStyleId = typeof document === "undefined"
    ? undefined
    : document.documentElement.getAttribute("data-style") ?? undefined;
  return applyTheme(currentStyleId, colorId);
}

/** Apply both style and color at once. */
export function applyTheme(styleId: string | undefined, colorId: string | undefined): AppliedTheme {
  const theme = normalizeTheme(styleId, colorId);
  if (typeof document === "undefined") return theme;

  const root = document.documentElement;
  const effectiveColorId = effectiveColorIdForTheme(theme);
  const previousStyleId = root.getAttribute("data-style");
  const previousColorPreference = root.getAttribute("data-color-preference") ?? root.getAttribute("data-color");
  const previousColorId = root.getAttribute("data-color");
  const hasAppliedTheme = previousStyleId !== null && previousColorId !== null;
  const isChanged =
    previousStyleId !== theme.styleId ||
    previousColorPreference !== theme.colorId ||
    previousColorId !== effectiveColorId;
  const shouldTransition = hasAppliedTheme && isChanged && shouldUseThemeSwitchMotion();
  const transitionKind: ThemeTransitionKind | undefined = shouldTransition ? "theme-sweep" : undefined;

  if (themeSwitchingTimer !== undefined) {
    window.clearTimeout(themeSwitchingTimer);
    themeSwitchingTimer = undefined;
  }
  const transitionVersion = ++themeTransitionVersion;

  const prepareTransition = (options: { readonly includeElementTransitions: boolean }): void => {
    if (options.includeElementTransitions) {
      root.classList.add(THEME_SWITCHING_CLASS);
    } else {
      root.classList.remove(THEME_SWITCHING_CLASS);
    }
    if (transitionKind !== undefined) {
      root.setAttribute(THEME_TRANSITION_ATTRIBUTE, transitionKind);
    } else {
      root.removeAttribute(THEME_TRANSITION_ATTRIBUTE);
    }
  };
  const clearTransition = (): void => {
    root.classList.remove(THEME_SWITCHING_CLASS);
    root.removeAttribute(THEME_TRANSITION_ATTRIBUTE);
  };
  const commitTheme = (): void => {
    root.setAttribute("data-style", theme.styleId);
    root.setAttribute("data-color", effectiveColorId);
    root.setAttribute("data-color-preference", theme.colorId);
    configureSystemColorListener(theme);
  };

  if (!shouldTransition) {
    clearTransition();
    commitTheme();
    return theme;
  }

  const viewTransition = transitionKind === "theme-sweep" ? startThemeViewTransition(() => {
    prepareTransition({ includeElementTransitions: false });
    commitTheme();
  }) : undefined;
  if (viewTransition !== undefined) {
    clearAfterViewTransition(viewTransition, transitionVersion, clearTransition);
  } else {
    prepareTransition({ includeElementTransitions: true });
    commitTheme();
    themeSwitchingTimer = window.setTimeout(() => {
      if (transitionVersion !== themeTransitionVersion) return;
      clearTransition();
      themeSwitchingTimer = undefined;
    }, transitionKind === "theme-sweep" ? THEME_SWEEP_SWITCHING_DURATION_MS : THEME_SWITCHING_DURATION_MS);
  }

  return theme;
}

/** Read saved style id from localStorage. */
export function getSavedStyleId(): ThemeStyleId | undefined {
  const value = readLocalPreference(STORAGE_STYLE_KEY);
  if (value !== undefined && isValidStyle(value)) return value;
  return undefined;
}

/** Read saved color id from localStorage. */
export function getSavedColorId(): ThemeColorId | undefined {
  const value = readLocalPreference(STORAGE_COLOR_KEY);
  if (value !== undefined && isValidColor(value)) return value;
  return undefined;
}

/** Persist style id. */
export function saveStyleId(styleId: string): void {
  if (!isValidStyle(styleId)) return;
  writeLocalPreference(STORAGE_STYLE_KEY, styleId);
}

/** Persist color id. */
export function saveColorId(colorId: string): void {
  if (!isValidColor(colorId)) return;
  writeLocalPreference(STORAGE_COLOR_KEY, colorId);
}

/** Return the initial style + color to use on startup. */
export function getInitialTheme(): AppliedTheme {
  return normalizeTheme(getSavedStyleId(), getSavedColorId());
}

function currentColorPreference(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const root = document.documentElement;
  return root.getAttribute("data-color-preference") ?? root.getAttribute("data-color") ?? undefined;
}

function effectiveColorIdForTheme(theme: AppliedTheme): ThemeColorId {
  if (theme.styleId === "default" && theme.colorId === "system") {
    return systemColorPreference();
  }
  return theme.colorId;
}

function startThemeViewTransition(commit: () => void): ThemeViewTransition | undefined {
  const transitionDocument = document as ViewTransitionDocument;
  if (typeof transitionDocument.startViewTransition !== "function") {
    return undefined;
  }
  let committed = false;
  try {
    return transitionDocument.startViewTransition(() => {
      committed = true;
      commit();
    });
  } catch {
    if (!committed) {
      commit();
    }
    return { finished: Promise.resolve() };
  }
}

function clearAfterViewTransition(
  transition: ThemeViewTransition,
  transitionVersion: number,
  clearTransition: () => void,
): void {
  const finished = transition.finished ?? wait(THEME_SWEEP_SWITCHING_DURATION_MS);
  void finished
    .catch(() => undefined)
    .then(() => afterNextPaint(() => {
      if (transitionVersion !== themeTransitionVersion) return;
      clearTransition();
    }));
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function afterNextPaint(callback: () => void): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(callback);
  });
}

function systemColorPreference(): "light" | "dark" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function configureSystemColorListener(theme: AppliedTheme): void {
  const shouldListen = theme.styleId === "default" && theme.colorId === "system";
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return;
  }
  if (!shouldListen) {
    removeSystemColorListener();
    return;
  }
  if (systemColorMedia !== undefined && systemColorMediaListener !== undefined) {
    return;
  }
  systemColorMedia = window.matchMedia("(prefers-color-scheme: dark)");
  systemColorMediaListener = () => {
    const root = document.documentElement;
    if (root.getAttribute("data-style") === "default" && currentColorPreference() === "system") {
      applyTheme("default", "system");
    }
  };
  systemColorMedia.addEventListener("change", systemColorMediaListener);
}

function removeSystemColorListener(): void {
  if (systemColorMedia !== undefined && systemColorMediaListener !== undefined) {
    systemColorMedia.removeEventListener("change", systemColorMediaListener);
  }
  systemColorMedia = undefined;
  systemColorMediaListener = undefined;
}
