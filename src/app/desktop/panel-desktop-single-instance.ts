export function acquireDesktopSingleInstance(input: {
  readonly requestLock: () => boolean;
  readonly onSecondInstance: (listener: () => void) => void;
  readonly focusCurrentWindow: () => void;
  readonly quit: () => void;
}): boolean {
  if (!input.requestLock()) {
    input.quit();
    return false;
  }
  input.onSecondInstance(input.focusCurrentWindow);
  return true;
}
