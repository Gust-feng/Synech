import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { runFocusModeTransition, type FocusModeTransitionHandle } from "../personal-workbench/workbench/app/components/focus-mode-transition";

export type ConversationMode = "normal" | "focus";

export type ConversationModeController = {
  readonly mode: ConversationMode;
  readonly setMode: (next: ConversationMode, after?: () => void) => void;
};

export function useConversationMode(rootRef: RefObject<HTMLDivElement | null>): ConversationModeController {
  const [mode, setModeState] = useState<ConversationMode>("normal");
  const focusTransitionRef = useRef<FocusModeTransitionHandle | null>(null);
  const focusTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => () => {
    focusTransitionRef.current?.cancel();
    focusTransitionRef.current = null;
  }, []);

  const setMode = useCallback((next: ConversationMode, after?: () => void): void => {
    if (next === mode) {
      after?.();
      return;
    }
    if (next === "focus") focusTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusTransitionRef.current?.cancel();
    focusTransitionRef.current = runFocusModeTransition({
      root: rootRef.current,
      direction: next === "focus" ? "enter" : "exit",
      update: () => flushSync(() => {
        setModeState(next);
        after?.();
      }),
    });
  }, [mode, rootRef]);

  useEffect(() => {
    if (mode !== "focus") {
      if (focusTriggerRef.current?.isConnected) focusTriggerRef.current.focus({ preventScroll: true });
      focusTriggerRef.current = null;
      return;
    }
    rootRef.current?.querySelector<HTMLButtonElement>(".ui-focus-header button")?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setMode("normal");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, rootRef, setMode]);

  return { mode, setMode };
}
