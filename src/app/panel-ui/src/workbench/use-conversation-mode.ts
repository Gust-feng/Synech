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

  useEffect(() => () => {
    focusTransitionRef.current?.cancel();
    focusTransitionRef.current = null;
  }, []);

  const setMode = useCallback((next: ConversationMode, after?: () => void): void => {
    if (next === mode) {
      after?.();
      return;
    }
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

  return { mode, setMode };
}