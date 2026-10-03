import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Layers } from 'lucide-react'
import type { ConversationOwnerSelection } from '../../../../workbench/navigation-state'


interface HomeOwnerOption {
  readonly id: string
  readonly title: string
}

interface HomeOwnerPickerProps {
  readonly spaces?: readonly { readonly spaceId: string; readonly title: string }[]
  readonly value: ConversationOwnerSelection | null
  readonly onChange: (owner: ConversationOwnerSelection | null) => void
}

/**
 * 首页任务入口的对话空间选择器：与 composer 模型选择器保持同一套
 * 自定义下拉视觉语言，替代原生 select，避免弹出面板与工作台割裂。
 */
export function HomeOwnerPicker({ spaces = [], value, onChange }: HomeOwnerPickerProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverId = useId()

  const spaceOptions: HomeOwnerOption[] = spaces.map((space) => ({
    id: space.spaceId,
    title: space.title,
  }))
  const allOptions = spaceOptions
  const empty = allOptions.length === 0
  const selected = value === null ? undefined : allOptions.find((option) => option.id === value.id)
  const triggerLabel = selected?.title ?? (empty ? '请选择空间' : '选择空间')

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const select = (option: HomeOwnerOption): void => {
    setOpen(false)
    onChange({ kind: 'space', id: option.id })
  }

  return (
    <div ref={rootRef} className="ui-home-owner-picker">
      <button
        type="button"
        className="ui-home-owner-picker__trigger"
        aria-label="对话空间"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={empty}
        onClick={() => setOpen((current) => !current)}
      >
        <Layers size={13} strokeWidth={1.8} aria-hidden="true" />
        <span className="ui-home-owner-picker__trigger-label">{triggerLabel}</span>
        <ChevronDown size={12} className="ui-home-owner-picker__chevron" aria-hidden="true" />
      </button>
      {open && !empty && (
        <div id={popoverId} className="ui-home-owner-picker__popover" role="listbox" aria-label="对话空间">
          {spaceOptions.length > 0 && (
            <section className="ui-home-owner-picker__group">
              <h3>空间</h3>
              {spaceOptions.map((option) => (
                <HomeOwnerRow
                  key={option.id}
                  option={option}
                  selected={value?.id === option.id}
                  onSelect={select}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function HomeOwnerRow(props: {
  readonly option: HomeOwnerOption
  readonly selected: boolean
  readonly onSelect: (option: HomeOwnerOption) => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={props.selected}
      className={props.selected ? 'ui-home-owner-picker__row selected' : 'ui-home-owner-picker__row'}
      onClick={() => props.onSelect(props.option)}
    >
      <span className="ui-home-owner-picker__row-title">{props.option.title}</span>
      {props.selected && <Check size={12} className="ui-home-owner-picker__row-check" aria-hidden="true" />}
    </button>
  )
}
