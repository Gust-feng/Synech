import React from "react";
import { Check, ChevronDown } from "lucide-react";

/**
 * 设置面板下拉选择控件的单项数据定义。
 */
export type SettingsSelectOption = {
  /** 选项值，用于唯一标识或持久化数据传输 */
  readonly value: string;
  /** 选项展示标签文本 */
  readonly label: string;
  /** 是否禁用该选项（禁用后不可选中） */
  readonly disabled?: boolean;
  /** 选项被禁用时展示的辅助说明标签（如“不可用”） */
  readonly disabledLabel?: string;
};

/**
 * 设置面板通用下拉选择组件属性定义。
 */
export type SettingsSelectControlProps = {
  /** HTML 元素唯一标识符（用于关联 ARIA 标签与 listbox） */
  readonly id: string;
  /** 无障碍屏幕阅读器 aria-label 属性 */
  readonly ariaLabel: string;
  /** 当前选中的选项值 */
  readonly value: string;
  /** 可供选择的候选列表 */
  readonly options: readonly SettingsSelectOption[];
  /** 选项发生改变时的通知回调 */
  readonly onChange: (value: string) => void;
  /** 是否整体禁用下拉控件交互 */
  readonly disabled?: boolean;
  /** 是否处于加载或执行操作的忙碌状态 */
  readonly busy?: boolean;
};

/**
 * 设置面板通用单选下拉组件。
 *
 * 特性：
 * - 键盘导航友好：支持 ArrowUp/ArrowDown 切换、Home/End 边界直达、Escape 关闭；
 * - 矢量图标居中：内置 Lucide ChevronDown 与 Check 图标，支持开合 180° 平滑翻转动画；
 * - 无障碍标准：规范集成 aria-expanded、aria-haspopup 与 listbox 语义，支持失焦自动收起。
 */
export function SettingsSelectControl(props: SettingsSelectControlProps): React.ReactElement {
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
        <span className="settings-select-label">{selectedOption?.label ?? props.value}</span>
        <ChevronDown size={14} className="settings-select-chevron" aria-hidden="true" />
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
              <span className="settings-select-option-label">{option.label}</span>
              {option.disabled === true ? (
                <span className="settings-select-option-status">{option.disabledLabel ?? "不可用"}</span>
              ) : (
                <span className="settings-select-option-mark" aria-hidden="true">
                  {option.value === props.value && <Check size={13} />}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
