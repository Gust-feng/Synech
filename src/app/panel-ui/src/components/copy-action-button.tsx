import React, { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

type CopyState = "idle" | "copied" | "failed";

export function CopyActionButton(props: {
  readonly value: string;
  readonly label: string;
  readonly className?: string;
}): React.ReactElement {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimerRef.current !== undefined) {
      window.clearTimeout(resetTimerRef.current);
    }
  }, []);

  const title = state === "copied"
    ? "已复制"
    : state === "failed"
      ? "复制失败"
      : props.label;
  const Icon = state === "copied" ? Check : Copy;

  return (
    <button
      type="button"
      className={props.className === undefined ? "copy-action-button" : `copy-action-button ${props.className}`}
      data-state={state}
      aria-label={title}
      onClick={() => {
        void copyText(props.value).then((copied) => {
          setState(copied ? "copied" : "failed");
          if (resetTimerRef.current !== undefined) {
            window.clearTimeout(resetTimerRef.current);
          }
          resetTimerRef.current = window.setTimeout(() => setState("idle"), 1_600);
        });
      }}
    >
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

async function copyText(value: string): Promise<boolean> {
  if (navigator.clipboard === undefined) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}