export type DesktopWindowControlTarget = {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(fullScreen: boolean): void;
  isMaximized(): boolean;
  maximize(): void;
  unmaximize(): void;
};

export type DesktopWindowPresentationState = {
  readonly maximized: boolean;
};

export type DesktopWindowNativeEventState = {
  maximized: boolean;
};

export function createDesktopWindowNativeEventState(): DesktopWindowNativeEventState {
  return { maximized: false };
}

export function recordDesktopWindowMaximized(
  state: DesktopWindowNativeEventState,
  maximized: boolean
): void {
  state.maximized = maximized;
}

export function toggleDesktopWindowMaximize(
  window: DesktopWindowControlTarget,
  state: DesktopWindowNativeEventState
): void {
  if (window.isDestroyed()) return;

  if (window.isFullScreen()) {
    window.setFullScreen(false);
  } else if (window.isMaximized() || state.maximized) {
    window.unmaximize();
  } else {
    // The OS owns window geometry and motion. Electron's native events are the
    // only source of presentation state; the renderer must not predict success.
    window.maximize();
  }
}

export function readDesktopWindowPresentationState(
  window: DesktopWindowControlTarget,
  state: DesktopWindowNativeEventState
): DesktopWindowPresentationState {
  return {
    maximized: window.isFullScreen() || window.isMaximized() || state.maximized,
  };
}
