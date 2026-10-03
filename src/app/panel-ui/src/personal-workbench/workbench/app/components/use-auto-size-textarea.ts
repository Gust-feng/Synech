import { useLayoutEffect, useRef } from "react";

/** Match content height and remeasure when the conversation pane changes width. CSS owns the height limit. */
export function useAutoSizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (textarea === null) return;
    const resize = () => {
      textarea.style.height = "0px";
      textarea.style.height = `${textarea.scrollHeight}px`;
      if (document.activeElement === textarea) {
        textarea.closest(".ui-message-editor")?.scrollIntoView({ block: "nearest" });
      }
    };
    resize();
    let previousWidth = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === previousWidth) return;
      previousWidth = textarea.clientWidth;
      resize();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [value]);
  return ref;
}
