import React from "react";
import { ChevronDown, Search } from "lucide-react";
import type { ChatModelOption } from "../contracts/composer";
import { modelCapabilitySummary } from "../model-capability-display";
import "../styles/model-option-picker.css";

type ModelOptionPickerVariant = "composer" | "settings";
type ModelOptionPickerPlacement = "top" | "bottom";

export function ModelOptionPicker(props: {
  readonly options: readonly ChatModelOption[];
  readonly selectedId: string;
  readonly onSelect: (modelId: string) => void | Promise<void>;
  readonly emptyLabel?: string;
  readonly onEmptyAction?: () => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly variant?: ModelOptionPickerVariant;
  readonly placement?: ModelOptionPickerPlacement;
  readonly className?: string;
}): React.ReactElement {
  const variant = props.variant ?? "settings";
  const placement = props.placement ?? "bottom";
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const selected = props.options.find((option) => option.id === props.selectedId);
  const popoverId = React.useId();
  const searchVisible = variant === "settings" && props.options.length > 12;
  const normalizedQuery = searchVisible ? normalizeModelSearch(query) : "";
  const groups = React.useMemo(
    () => groupModelOptions(filterModelOptions(props.options, normalizedQuery)),
    [normalizedQuery, props.options]
  );
  const optionCount = props.options.length;

  React.useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    if (!searchVisible) return;
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [open, searchVisible]);

  if (optionCount === 0) {
    return (
      <button
        type="button"
        className={modelPickerClassName("model-picker-empty-trigger", props.className)}
        data-variant={variant}
        onClick={props.onEmptyAction}
        disabled={props.disabled === true || props.onEmptyAction === undefined}
      >
        {props.emptyLabel ?? "配置模型"}
      </button>
    );
  }

  const select = (option: ChatModelOption): void => {
    setOpen(false);
    void Promise.resolve(props.onSelect(option.id));
  };

  return (
    <div
      ref={rootRef}
      className={modelPickerClassName("model-option-picker", props.className)}
      data-variant={variant}
      data-placement={placement}
    >
      <button
        type="button"
        className="model-picker-trigger"
        aria-label={props.ariaLabel ?? "选择模型"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((current) => !current)}
        disabled={props.disabled === true}
      >
        <ModelPickerIcon option={selected} />
        <span className="model-picker-trigger-copy">
          <span className="model-picker-trigger-name">{modelPickerTriggerLabel(selected, variant)}</span>
          {selected !== undefined && variant === "settings" && (
            <span className="model-picker-trigger-provider">{selected.providerLabel}</span>
          )}
        </span>
        <ChevronDown size={12} className="model-picker-trigger-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div id={popoverId} className="model-picker-popover" role="listbox" aria-label={props.ariaLabel ?? "选择模型"}>
          {searchVisible && (
            <label className="model-picker-search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索模型"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
              />
            </label>
          )}
          <div className="model-picker-list">
            {groups.length === 0 ? (
              <div className="model-picker-empty">没有匹配模型</div>
            ) : (
              groups.map((group) => (
                <section className="model-picker-group" key={group.label}>
                  <h3>
                    <span>{group.label}</span>
                    <small>{group.items.length}</small>
                  </h3>
                  {group.items.map((option) => {
                    const selectedOption = option.id === props.selectedId;
                    const capabilitySummary = modelCapabilitySummary(option.capabilities);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={selectedOption ? "model-picker-row selected" : "model-picker-row"}
                        role="option"
                        aria-selected={selectedOption}
                        onClick={() => select(option)}
                      >
                        <ModelPickerIcon option={option} />
                        <span className="model-picker-row-copy">
                          <strong>{option.name}</strong>
                          {capabilitySummary !== undefined && <small>{capabilitySummary}</small>}
                        </span>
                      </button>
                    );
                  })}
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function modelPickerTriggerLabel(option: ChatModelOption | undefined, variant: ModelOptionPickerVariant): string {
  if (option === undefined) return "选择模型";
  if (variant !== "settings") return option.name;
  return option.providerLabel === option.name ? option.name : `${option.providerLabel} / ${option.name}`;
}

function ModelPickerIcon(props: { readonly option?: ChatModelOption }): React.ReactElement {
  if (props.option === undefined) {
    return <span className="model-picker-icon" aria-hidden="true">M</span>;
  }
  return (
    <span className="model-picker-icon" aria-hidden="true">
      {props.option.iconSvg === undefined ? (
        <span className="model-picker-initial">{modelOptionInitial(props.option)}</span>
      ) : (
        <span dangerouslySetInnerHTML={{ __html: props.option.iconSvg }} />
      )}
    </span>
  );
}

function groupModelOptions(
  options: readonly ChatModelOption[]
): readonly { readonly label: string; readonly items: readonly ChatModelOption[] }[] {
  const groups = new Map<string, ChatModelOption[]>();
  for (const option of options) {
    const label = option.providerLabel === option.name ? "模型服务" : option.providerLabel;
    groups.set(label, [...(groups.get(label) ?? []), option]);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
}

function filterModelOptions(
  options: readonly ChatModelOption[],
  normalizedQuery: string
): readonly ChatModelOption[] {
  if (normalizedQuery.length === 0) return options;
  return options.filter((option) => normalizeModelSearch([
    option.providerLabel,
    option.name,
    option.modelId,
    option.profileId,
  ].join(" ")).includes(normalizedQuery));
}

function modelOptionInitial(option: ChatModelOption): string {
  return (option.providerLabel.trim() || option.name.trim() || "M").slice(0, 1).toUpperCase();
}

function normalizeModelSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function modelPickerClassName(base: string, extra: string | undefined): string {
  return extra === undefined || extra.trim().length === 0 ? base : `${base} ${extra}`;
}
