import { useLayoutEffect } from "react";
import { LoaderCircle } from "lucide-react";
import { useAutoSizeTextarea } from "./use-auto-size-textarea";

export function MessageEditor(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly submitting?: boolean;
  readonly submitLabel?: string;
  readonly ariaLabel?: string;
  readonly compact?: boolean;
  readonly allowEmpty?: boolean;
}) {
  const ref = useAutoSizeTextarea(props.value);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (textarea === null) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.closest(".ui-message-editor")?.scrollIntoView({ block: "nearest" });
  }, [ref]);

  return (
    <div className="ui-message-editor" data-compact={props.compact === true} aria-busy={props.submitting === true}>
      <textarea
        ref={ref}
        className="ui-message-editor__input"
        aria-label={props.ariaLabel ?? "编辑消息"}
        value={props.value}
        readOnly={props.submitting}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || props.submitting) return;
          if (event.key === "Escape") { event.preventDefault(); props.onCancel(); }
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            if (props.allowEmpty || props.value.trim().length > 0) props.onSubmit();
          }
        }}
        rows={1}
        spellCheck={false}
      />
      <div className="ui-message-editor__actions">
        <button type="button" className="ui-message-editor__cancel" disabled={props.submitting} onClick={props.onCancel}>取消</button>
        <button type="button" className="ui-message-editor__submit" disabled={props.submitting || !props.allowEmpty && props.value.trim().length === 0}
          onClick={props.onSubmit} title="Ctrl / ⌘ + Enter">
          {props.submitting && <LoaderCircle size={14} className="ui-message-editor__spinner" aria-hidden="true" />}
          {props.submitLabel ?? "发送"}
        </button>
      </div>
    </div>
  );
}
