import { useEffect, useState } from "react";

/**
 * Hides transient feedback `timeoutMs` after the message appears, until the
 * parent supplies a different message. Undefined clears nothing to show; the
 * parent decides whether to render at all.
 */
export function useAutoHidden(message: string | undefined, timeoutMs = 8_000): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (message === undefined) {
      setHidden(false);
      return;
    }
    setHidden(false);
    const timer = window.setTimeout(() => setHidden(true), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [message, timeoutMs]);
  return message !== undefined && hidden;
}
