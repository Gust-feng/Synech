import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

/**
 * Inline feedback for the memory and collaboration-rules pages. The note hides
 * itself after `dismissAfterMs` until the parent supplies different content;
 * errors stay readable while shown and the parent keeps the underlying state.
 */
export function MemoryFeedback(props: {
  readonly kind: "error" | "success" | "warning";
  readonly children: ReactNode;
  readonly dismissAfterMs?: number;
}): React.ReactElement | null {
  const content = props.children;
  const [hidden, setHidden] = useState(false);
  const key = typeof content === "string" ? content : undefined;
  useEffect(() => {
    if (key === undefined || props.dismissAfterMs === undefined) {
      setHidden(false);
      return;
    }
    setHidden(false);
    const timer = window.setTimeout(() => setHidden(true), props.dismissAfterMs);
    return () => window.clearTimeout(timer);
  }, [key, props.dismissAfterMs]);
  if (key !== undefined && hidden) return null;
  const Icon = props.kind === "success" ? CheckCircle2 : AlertCircle;
  return <div className="memory-feedback" data-kind={props.kind} role={props.kind === "error" ? "alert" : "status"}>
    <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    <span>{content}</span>
  </div>;
}
