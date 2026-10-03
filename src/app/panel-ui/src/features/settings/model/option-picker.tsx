import { SvgMark } from "../../../components/svg-mark";
import React from "react";
import { ChevronDown, Search } from "lucide-react";
import type { ChatModelOption } from "../../../contracts/composer";
import { modelCapabilitySummary, runReasoningEffortOptions } from "./capability-display";
import { ModelReasoningControl, type ModelReasoningSelection } from "./reasoning-control";
import "./option-picker.css";

type ModelOptionPickerVariant = "composer" | "settings";
type ModelOptionPickerPlacement = "top" | "bottom";
type OpenModelPicker = "models" | "reasoning" | null;

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
  readonly reasoning?: ModelReasoningSelection;
}): React.ReactElement {
  const variant = props.variant ?? "settings";
  const placement = props.placement ?? "bottom";
  const [open, setOpen] = React.useState<OpenModelPicker>(null);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const reasoningTriggerRef = React.useRef<HTMLButtonElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const modelPopoverRef = React.useRef<HTMLDivElement>(null);
  const modelListRef = React.useRef<HTMLDivElement>(null);
  const selected = props.options.find((option) => option.id === props.selectedId);
  const effortOptions = props.reasoning === undefined ? [] : runReasoningEffortOptions(selected?.capabilities);
  const reasoning = variant === "composer" && effortOptions.length > 0 ? props.reasoning : undefined;
  const hasReasoning = reasoning !== undefined;
  const selectedEffortIndex = reasoning === undefined ? -1 : effortOptions.findIndex((option) => option.value === reasoning.value);
  const effortLabel = selectedEffortIndex < 0 ? "自动" : effortOptions[selectedEffortIndex].label;
  const meterLevel = selectedEffortIndex < 0 ? 0 : Math.ceil((selectedEffortIndex + 1) / effortOptions.length * 4);
  const popoverId = React.useId();
  const reasoningPopoverId = React.useId();
  const searchVisible = variant === "settings" && props.options.length > 12;
  const normalizedQuery = searchVisible ? normalizeModelSearch(query) : "";
  const groups = React.useMemo(
    () => groupModelOptions(filterModelOptions(props.options, normalizedQuery)),
    [normalizedQuery, props.options]
  );

  React.useLayoutEffect(() => {
    if (open !== "models") return undefined;
    const updatePosition = (): void => {
      const trigger = triggerRef.current;
      const popover = modelPopoverRef.current;
      if (trigger === null || popover === null) return;
      const rect = trigger.getBoundingClientRect();
      const space = { top: rect.top - 24, bottom: window.innerHeight - rect.bottom - 24 };
      const alternative = placement === "top" ? "bottom" : "top";
      const direction = space[placement] < Math.min(240, space[alternative]) ? alternative : placement;
      popover.dataset.placement = direction;
      popover.style.setProperty("--model-picker-available-height", Math.max(0, space[direction]) + "px");
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, placement]);

  React.useLayoutEffect(() => {
    if (open === "models" && modelListRef.current !== null) modelListRef.current.scrollTop = 0;
  }, [open, normalizedQuery]);

  React.useEffect(() => {
    if (open === null) return undefined;
    const closeOutside = (event: Event): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(null);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        setOpen(null);
        (open === "models" ? triggerRef : reasoningTriggerRef).current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  React.useEffect(() => {
    if (open === null) return;
    setQuery("");
    const frame = window.requestAnimationFrame(() => {
      const list = modelListRef.current;
      const row = list?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
        ?? list?.querySelector<HTMLButtonElement>('[role="option"]');
      if (open === "models" && list !== null && row != null) {
        list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - row.offsetHeight) / 2;
      }
      const target = open === "reasoning"
        ? rootRef.current?.querySelector<HTMLInputElement>('input[type="range"]')
        : searchVisible ? searchInputRef.current : row;
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, searchVisible]);

  React.useEffect(() => {
    if (props.disabled === true || (open === "reasoning" && !hasReasoning)) setOpen(null);
  }, [open, props.disabled, hasReasoning]);

  if (props.options.length === 0) {
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
    setOpen(null);
    triggerRef.current?.focus();
    void Promise.resolve(props.onSelect(option.id));
  };
  const navigateModels = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || !(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "option") return;
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const index = rows.indexOf(event.target as HTMLButtonElement);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + rows.length) % rows.length;
    rows[nextIndex]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={modelPickerClassName("model-option-picker", props.className)}
      data-variant={variant}
      data-placement={placement}
      data-reasoning={reasoning !== undefined}
    >
      <div className="model-picker-model-control">
        <button
          type="button"
          ref={triggerRef}
          className="model-picker-trigger"
          aria-label={props.ariaLabel ?? "选择模型"}
          title="选择模型"
          aria-haspopup="listbox"
          aria-expanded={open === "models"}
          aria-controls={open === "models" ? popoverId : undefined}
          onClick={() => setOpen((current) => current === "models" ? null : "models")}
          disabled={props.disabled === true}
        >
          <ModelPickerIcon option={selected} />
          <span className="model-picker-trigger-copy">
            <span className="model-picker-trigger-name">{modelPickerTriggerLabel(selected, variant)}</span>
            {selected !== undefined && variant === "settings" && (
              <span className="model-picker-trigger-provider">{selected.providerLabel}</span>
            )}
          </span>
          {variant === "settings" && <ChevronDown size={11} className="model-picker-trigger-chevron" aria-hidden="true" />}
        </button>
        {open === "models" && (
          <div ref={modelPopoverRef} className="model-picker-popover" data-placement={placement} onKeyDown={navigateModels}>
            {searchVisible && (
              <label className="model-picker-search">
                <Search size={13} aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索模型"
                  aria-label="搜索模型"
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                />
              </label>
            )}
            <div ref={modelListRef} id={popoverId} className="model-picker-list" role="listbox" aria-label="选择模型">
              {groups.length === 0 ? (
                <div className="model-picker-empty">没有匹配模型</div>
              ) : groups.map((group) => (
                <section className="model-picker-group" key={group.id} role="group" aria-label={group.label}>
                  <h3>{group.label}</h3>
                  {group.items.map((option) => {
                    const selectedOption = option.id === props.selectedId;
                    const capabilitySummary = variant === "settings" ? modelCapabilitySummary(option.capabilities) : undefined;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={selectedOption ? "model-picker-row selected" : "model-picker-row"}
                        role="option"
                        aria-selected={selectedOption}
                        tabIndex={selectedOption || selected === undefined && option === groups[0].items[0] ? 0 : -1}
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
              ))}
            </div>
          </div>
        )}
      </div>
      {reasoning !== undefined && (
        <>
          <div className="model-picker-reasoning-control">
            <button
              ref={reasoningTriggerRef}
              type="button"
              className="model-picker-reasoning-trigger"
              aria-label={"推理强度，当前" + effortLabel}
              title="推理强度"
              aria-haspopup="dialog"
              aria-expanded={open === "reasoning"}
              aria-controls={open === "reasoning" ? reasoningPopoverId : undefined}
              disabled={props.disabled === true}
              onClick={() => setOpen((current) => current === "reasoning" ? null : "reasoning")}
            >
              <span className="model-picker-effort-meter" aria-hidden="true">
                {[0, 1, 2, 3].map((index) => <i key={index} data-active={index < meterLevel} />)}
              </span>
            </button>
            {open === "reasoning" && (
              <div id={reasoningPopoverId} className="model-picker-reasoning-popover" role="dialog" aria-label={selected?.name + " 的推理强度"}>
                <ModelReasoningControl key={props.selectedId} options={effortOptions} selection={reasoning} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function modelPickerTriggerLabel(option: ChatModelOption | undefined, variant: ModelOptionPickerVariant): string {
  if (option === undefined) return "选择模型";
  if (variant !== "settings") return option.name;
  return option.providerLabel === option.name ? option.name : option.providerLabel + " / " + option.name;
}

function ModelPickerIcon(props: { readonly option?: ChatModelOption }): React.ReactElement {
  return (
    <span className="model-picker-icon" aria-hidden="true">
      {props.option?.iconSvg === undefined ? (
        <span className="model-picker-initial">{props.option === undefined ? "M" : modelOptionInitial(props.option)}</span>
      ) : (
        <SvgMark svg={props.option.iconSvg} />
      )}
    </span>
  );
}

function groupModelOptions(options: readonly ChatModelOption[]): readonly { readonly id: string; readonly label: string; readonly items: readonly ChatModelOption[] }[] {
  // Connection identity owns grouping; display labels need not be unique.
  const groups = new Map<string, { id: string; label: string; items: ChatModelOption[] }>();
  for (const option of options) {
    const group = groups.get(option.profileId);
    if (group === undefined) groups.set(option.profileId, { id: option.profileId, label: option.providerLabel, items: [option] });
    else group.items.push(option);
  }
  return [...groups.values()];
}

function filterModelOptions(options: readonly ChatModelOption[], normalizedQuery: string): readonly ChatModelOption[] {
  if (normalizedQuery.length === 0) return options;
  return options.filter((option) => normalizeModelSearch([
    option.providerLabel, option.name, option.modelId, option.profileId,
  ].join(" ")).includes(normalizedQuery));
}

function modelOptionInitial(option: ChatModelOption): string {
  return (option.providerLabel.trim() || option.name.trim() || "M").slice(0, 1).toUpperCase();
}

function normalizeModelSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function modelPickerClassName(base: string, extra: string | undefined): string {
  return extra === undefined || extra.trim().length === 0 ? base : base + " " + extra;
}
