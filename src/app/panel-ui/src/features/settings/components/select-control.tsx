import React from "react";

export type SettingsSelectOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly disabledLabel?: string;
};

export function SettingsSelectControl(props: {
  readonly id: string;
  readonly ariaLabel: string;
  readonly value: string;
  readonly options: readonly SettingsSelectOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const selectedIndex = Math.max(0, props.options.findIndex((option) => option.value === props.value));
  const selectedOption = props.options[selectedIndex] ?? props.options[0];
  const availableOptions = props.options.filter((option) => option.disabled !== true);
  const listId = `${props.id}-listbox`;

  const updateSelection = (option: SettingsSelectOption): void => {
    if (option.disabled === true) return;
    props.onChange(option.value);
    setOpen(false);
  };

  const stepSelection = (direction: 1 | -1): void => {
    if (availableOptions.length === 0) return;
    const availableIndex = availableOptions.findIndex((option) => option.value === props.value);
    const startIndex = availableIndex < 0 ? 0 : availableIndex;
    const nextIndex = (startIndex + direction + availableOptions.length) % availableOptions.length;
    const nextOption = availableOptions[nextIndex];
    if (nextOption !== undefined) {
      props.onChange(nextOption.value);
      setOpen(true);
    }
  };

  return (
    <div
      className={`settings-select-control ${open ? "open" : ""}`}
      onBlur={(event) => {
        const nextFocus = event.relatedTarget as Node | null;
        if (!event.currentTarget.contains(nextFocus)) {
          setOpen(false);
        }
      }}
    >
      <button
        id={props.id}
        type="button"
        className="settings-select-trigger"
        aria-label={props.ariaLabel}
        aria-busy={props.busy === true ? "true" : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={props.disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            stepSelection(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            stepSelection(-1);
          } else if (event.key === "Home") {
            event.preventDefault();
            const firstOption = availableOptions[0];
            if (firstOption !== undefined) {
              props.onChange(firstOption.value);
              setOpen(true);
            }
          } else if (event.key === "End") {
            event.preventDefault();
            const lastOption = availableOptions[availableOptions.length - 1];
            if (lastOption !== undefined) {
              props.onChange(lastOption.value);
              setOpen(true);
            }
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      >
        <span>{selectedOption?.label ?? props.value}</span>
        <span className="settings-select-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div id={listId} className="settings-select-popover" role="listbox" aria-label={props.ariaLabel}>
          {props.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="settings-select-option"
              role="option"
              aria-selected={option.value === props.value}
              data-selected={option.value === props.value}
              disabled={option.disabled}
              onPointerDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => updateSelection(option)}
            >
              <span>{option.label}</span>
              {option.disabled === true ? (
                <span className="settings-select-option-status">{option.disabledLabel ?? "不可用"}</span>
              ) : (
                <span className="settings-select-option-mark" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
