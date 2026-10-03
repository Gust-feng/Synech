import React from "react";
import type { ModelRunReasoningEffort } from "@panel-api/config";
import type { runReasoningEffortOptions } from "./capability-display";
import "./reasoning-control.css";

export type ModelReasoningSelection = {
  readonly value: "" | ModelRunReasoningEffort;
  readonly onChange: (value: "" | ModelRunReasoningEffort) => void;
};

export function ModelReasoningControl(props: {
  readonly options: ReturnType<typeof runReasoningEffortOptions>;
  readonly selection: ModelReasoningSelection;
}): React.ReactElement {
  const labelId = React.useId();
  const options = [{ value: "" as const, label: "自动" }, ...props.options];
  const maximum = options.length - 1;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === props.selection.value));
  const [dragPosition, setDragPosition] = React.useState<number | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const position = Math.min(maximum, dragPosition ?? selectedIndex);
  const currentIndex = Math.round(position);
  const selected = options[currentIndex];
  const sliderStyle = { "--reasoning-position": position / maximum } as React.CSSProperties;

  React.useEffect(() => {
    if (!dragging) return;
    const finishDrag = (): void => {
      setDragging(false);
      setDragPosition(null);
    };
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [dragging]);

  const changePosition = (next: number): void => {
    const clamped = Math.max(0, Math.min(maximum, next));
    const index = Math.round(clamped);
    setDragPosition(dragging ? clamped : null);
    if (options[index].value !== props.selection.value) props.selection.onChange(options[index].value);
  };

  return (
    <section className="model-reasoning" aria-labelledby={labelId}>
      <div className="model-reasoning__heading">
        <span id={labelId}>推理强度</span>
        <strong><span key={selected.value} className="model-reasoning__value">{selected.label}</span></strong>
      </div>
      <div className="model-reasoning__slider" data-dragging={dragging} style={sliderStyle}>
        <div className="model-reasoning__track" aria-hidden="true">
          <span className="model-reasoning__fill" />
          {options.map((option, index) => (
            <span
              key={option.value}
              className="model-reasoning__tick"
              data-active={index <= currentIndex}
              style={{ "--reasoning-stop": index / maximum } as React.CSSProperties}
            />
          ))}
        </div>
        <span className="model-reasoning__thumb" aria-hidden="true"><i /><i /></span>
        <input
          type="range"
          min={0}
          max={maximum}
          step="any"
          value={position}
          aria-labelledby={labelId}
          aria-valuenow={currentIndex}
          aria-valuetext={selected.label}
          onPointerDown={(event) => { if (event.button === 0) setDragging(true); }}
          onBlur={() => { setDragging(false); setDragPosition(null); }}
          onChange={(event) => changePosition(event.currentTarget.valueAsNumber)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? maximum : currentIndex + (["ArrowLeft", "ArrowDown"].includes(event.key) ? -1 : 1);
            changePosition(next);
          }}
        />
      </div>
    </section>
  );
}
