import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronDown, FileText, Plus, ShieldCheck, X } from 'lucide-react'
import type { ChatInputProps } from '../../../../contracts/composer'
import type { ComposerToolConfirmationPolicy } from '../../../../app-config-projection'
import { formatCompactTokenCount, formatContextUsagePercent } from '../../../../context-window-usage'
import { ModelOptionPicker } from '../../../../components/model-option-picker'
import { ActionConfirmationDialog } from './ActionConfirmationDialog'
import { composerSurface } from './tokens'
import { QueuedMessageList } from './QueuedMessageList'

interface ConversationComposerProps {
  readonly input: ChatInputProps
  readonly onCompositionChange?: (composing: boolean) => void
}

export function ConversationComposer({ input, onCompositionChange }: ConversationComposerProps) {
  const [focused, setFocused] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const canEdit = !input.busy || input.allowInputWhileBusy === true
  const canSend = input.value.trim().length > 0 && canEdit

  useEffect(() => {
    const textarea = ref.current
    if (textarea === null) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`
  }, [input.value])

  useEffect(() => {
    if (input.autoFocus === true) ref.current?.focus()
  }, [input.autoFocus])

  const submit = (): void => {
    if (canSend) input.onSubmit()
  }

  return (
    <div className="aa-conversation-composer" style={composerSurface(focused)}>
      {input.queuedMessages !== undefined && input.queuedMessages.length > 0 && (
        <QueuedMessageList
          messages={input.queuedMessages}
          onRemove={input.onRemoveQueuedMessage ?? (() => undefined)}
          onUpdate={input.onUpdateQueuedMessage ?? (() => undefined)}
          onGuide={input.onGuideQueuedMessage ?? (async () => false)}
        />
      )}
      {input.attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {input.attachments.map((attachment) => (
            <span
              key={attachment.attachmentId}
              className="flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
              style={{ background: 'var(--aa-surface-hover)', color: 'var(--aa-text-2)' }}
            >
              <FileText size={11} className="shrink-0" />
              <span className="truncate">{attachment.title}</span>
              <button
                type="button"
                onClick={() => input.onRemoveAttachment(attachment.attachmentId)}
                className="shrink-0 hover:opacity-70"
                aria-label={`移除${attachment.title}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={input.value}
        onChange={(event) => input.onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onCompositionStart={() => onCompositionChange?.(true)}
        onCompositionEnd={() => onCompositionChange?.(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder={input.placeholder ?? runningPlaceholder(input)}
        rows={1}
        spellCheck={false}
        disabled={!canEdit}
        className="aa-conversation-composer__input w-full resize-none px-3 pt-2 pb-1 outline-none disabled:cursor-not-allowed"
        style={{ color: 'var(--aa-text-1)', background: 'transparent', lineHeight: 1.5 }}
      />
      <div className="aa-conversation-composer__toolbar">
        <div className="aa-conversation-composer__toolbar-left">
          <button
            type="button"
            onClick={input.onSelectAttachment}
            className="aa-conversation-composer__icon-button"
            style={{ color: 'var(--aa-text-3)' }}
            aria-label="添加引用"
          >
            <Plus size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <div className="aa-conversation-composer__toolbar-right">
          {input.contextUsage !== undefined && <ComposerContextUsage usage={input.contextUsage} />}
          <ComposerAccessSelect input={input} />
          <ComposerModelSelect input={input} />
          {input.running && input.onCancel !== undefined && (
            <button
              type="button"
              onClick={input.onCancel}
              className="rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
              style={{ background: 'rgba(200,64,64,0.1)', color: 'var(--aa-status-error)' }}
            >
              {input.cancelLabel ?? '停止'}
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="发送"
            className="aa-conversation-composer__send disabled:cursor-not-allowed"
            data-active={canSend}
          >
            <ArrowUp size={17} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

function runningPlaceholder(input: ChatInputProps): string {
  if (!input.running) return '继续对话…';
  return '运行中，继续输入…';
}

function ComposerModelSelect({ input }: { readonly input: ChatInputProps }) {
  return (
    <ModelOptionPicker
      options={input.models}
      selectedId={input.selectedModelId}
      onSelect={input.onModelSelect}
      emptyLabel="配置模型"
      onEmptyAction={input.onOpenSettings}
      ariaLabel="选择模型"
      variant="composer"
      placement="top"
    />
  )
}

function ComposerContextUsage({ usage }: { readonly usage: NonNullable<ChatInputProps['contextUsage']> }) {
  const progressColor = usage.tone === 'danger'
    ? 'var(--aa-status-error)'
    : usage.tone === 'warning'
      ? 'var(--aa-status-wait)'
      : usage.tone === 'muted'
        ? 'var(--aa-border)'
        : 'var(--aa-accent)'
  const progress = Math.min(100, Math.max(0, usage.ringPercent))
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={popoverRef} className="aa-context-usage relative hidden shrink-0 sm:block">
      <button
        type="button"
        className="aa-context-usage__trigger flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--aa-hover-tint)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--aa-accent)]"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={usage.label}
        onClick={() => setOpen((current) => !current)}
      >
        <ContextUsageRing progress={progress} color={progressColor} />
      </button>
      {open && <ContextUsagePopover usage={usage} onClose={() => setOpen(false)} />}
    </div>
  )
}

function ContextUsagePopover({
  usage,
  onClose,
}: {
  readonly usage: NonNullable<ChatInputProps['contextUsage']>
  readonly onClose: () => void
}) {
  const percent = usage.percent === undefined ? undefined : formatContextUsagePercent(usage.percent)
  const used = usage.usedTokens === undefined ? undefined : formatCompactTokenCount(usage.usedTokens)
  const max = formatCompactTokenCount(usage.maxTokens)
  const tone = usage.tone === 'danger' ? 'danger' : usage.tone === 'warning' ? 'warning' : 'normal'
  return (
    <div
      role="dialog"
      aria-label="上下文用量"
      aria-labelledby="aa-context-usage-title"
      className="aa-context-usage__popover absolute bottom-[calc(100%+8px)] right-0 z-30 rounded-xl p-3.5"
    >
      <div className="flex items-center justify-between gap-3">
        <strong id="aa-context-usage-title" className="text-sm font-medium" style={{ color: 'var(--aa-text-1)' }}>上下文用量</strong>
        <div className="flex items-center gap-2">
          <span className="aa-context-usage__popover-percent" data-tone={tone}>
            {percent === undefined ? '--' : `${percent}%`}
          </span>
          <button
            type="button"
            aria-label="关闭上下文用量"
            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--aa-hover-tint)]"
            style={{ color: 'var(--aa-text-3)' }}
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="text-[11px]" style={{ color: 'var(--aa-text-3)' }}>
          {used === undefined ? '暂无用量' : `已使用 ${used} / ${max}`}
        </span>
        <span className="text-[11px]" style={{ color: 'var(--aa-text-3)' }}>
          {usage.source === 'provider_usage' ? '输入上下文' : '等待用量'}
        </span>
      </div>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-label="上下文已用比例"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usage.percent === undefined ? undefined : Math.round(usage.percent)}
        style={{ background: 'var(--aa-surface-hover)' }}
      >
        <span
          className="block h-full rounded-full transition-[width,background-color] duration-200"
          style={{
            width: `${Math.min(100, Math.max(0, usage.ringPercent))}%`,
            background: tone === 'danger' ? 'var(--aa-status-error)' : tone === 'warning' ? 'var(--aa-status-wait)' : 'var(--aa-accent)',
          }}
        />
      </div>
    </div>
  )
}

function ContextUsageRing({ progress, color }: { readonly progress: number; readonly color: string }) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - progress / 100)
  return (
    <svg
      className="aa-context-usage__ring"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <circle className="aa-context-usage__ring-track" cx="8" cy="8" r={radius} fill="none" strokeWidth="2" />
      <circle
        className="aa-context-usage__ring-value"
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

function ComposerReasoningSelect({ input }: { readonly input: ChatInputProps }) {
  return (
    <label className="relative shrink-0">
      <span className="sr-only">推理力度</span>
      <select
        aria-label="推理力度"
        value={input.reasoningEffort}
        onChange={(event) => input.onReasoningEffortChange(event.target.value as ChatInputProps['reasoningEffort'])}
        className="h-6 appearance-none rounded-md bg-transparent py-0 pl-2 pr-6 text-[11px] outline-none transition-colors hover:bg-[var(--aa-hover-tint)] focus-visible:ring-1 focus-visible:ring-[var(--aa-accent)]"
        style={{ color: 'var(--aa-text-2)' }}
      >
        <option value="">自动</option>
        <option value="low">轻量</option>
        <option value="medium">标准</option>
        <option value="high">深入</option>
      </select>
      <ChevronDown size={10} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--aa-text-3)' }} aria-hidden="true" />
    </label>
  )
}

function accessPolicyLabel(policy: ComposerToolConfirmationPolicy): string {
  return policy === 'full_access' ? '完全访问' : '标准访问'
}

function ComposerAccessSelect({ input }: { readonly input: ChatInputProps }) {
  const policy = input.toolConfirmationPolicy
  const [open, setOpen] = useState(false)
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const select = (nextPolicy: ComposerToolConfirmationPolicy): void => {
    setOpen(false)
    if (nextPolicy === 'full_access' && policy !== 'full_access') {
      setConfirmingFullAccess(true)
      return
    }
    input.onToolConfirmationPolicyChange(nextPolicy)
  }

  return (
    <div ref={rootRef} className="aa-composer-access hidden shrink-0 sm:inline-flex">
      <button
        type="button"
        className="aa-composer-access__chip"
        data-policy={policy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="命令确认方式"
        onClick={() => setOpen((current) => !current)}
      >
        <ShieldCheck size={12} strokeWidth={1.8} aria-hidden="true" />
        <span>{accessPolicyLabel(policy)}</span>
        <ChevronDown size={10} className="aa-composer-access__chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="aa-composer-access__popover" role="listbox" aria-label="命令确认方式">
          <AccessOption policy="prompt" selected={policy === 'prompt'} onSelect={select} />
          <AccessOption policy="full_access" selected={policy === 'full_access'} onSelect={select} />
        </div>
      )}
      <ActionConfirmationDialog
        request={confirmingFullAccess ? {
          eyebrow: '完全访问',
          title: '要开启完全访问权限吗？',
          description: '开启后，Agent 可以在不逐条询问的情况下运行命令，并访问当前引用范围之外的文件。',
          consequence: '请只在你信任当前任务和执行结果时开启。',
          confirmLabel: '开启完全访问',
          destructive: false,
        } : undefined}
        onCancel={() => setConfirmingFullAccess(false)}
        onConfirm={() => {
          setConfirmingFullAccess(false)
          input.onToolConfirmationPolicyChange('full_access')
        }}
      />
    </div>
  )
}

function AccessOption({
  policy,
  selected,
  onSelect,
}: {
  readonly policy: ComposerToolConfirmationPolicy
  readonly selected: boolean
  readonly onSelect: (policy: ComposerToolConfirmationPolicy) => void
}) {
  const fullAccess = policy === 'full_access'
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={selected ? 'aa-composer-access__option selected' : 'aa-composer-access__option'}
      onClick={() => onSelect(policy)}
    >
      <span className="aa-composer-access__option-copy">
        <strong>{fullAccess ? '完全访问' : '标准访问'}</strong>
        <small>{fullAccess ? '运行命令时不再逐条询问' : '运行命令前会先询问'}</small>
      </span>
      {selected && <Check size={13} className="aa-composer-access__option-check" aria-hidden="true" />}
    </button>
  )
}
