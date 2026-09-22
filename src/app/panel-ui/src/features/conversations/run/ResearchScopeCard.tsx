import React from 'react'
import { Compass, Play } from 'lucide-react'

import type { ResearchScopeGateFailureView } from '@panel-api/research'
import { researchScopeCardSections, type ResearchScopeCardState } from './research-scope-card'

/**
 * 研究范围卡：结构化提案 → 可确认卡片（ADR 0001 §2.2）。
 *
 * 与 ConfirmationCard 同一形态的用户决定模式：卡片只渲染事实与两个动作，
 * 不自行拼装载荷、不修改任何字段；用户点击产生的用户命令由
 * `run/research-scope-card.ts` 组装并经同一个 Application command 入队。
 *
 * 展示纪律：title/label 只做展示，程序分支走结构化字段与 code；
 * 范围门拒绝时按缺失字段清单逐条呈现，不回退成一条笼统消息。
 */

const PRIORITY_LABEL: Record<'critical' | 'normal' | 'optional', string> = {
  critical: '关键',
  normal: '常规',
  optional: '可选',
}

export function ResearchScopeCard(props: {
  readonly state: ResearchScopeCardState
  readonly busy: boolean
  /** 范围门拒绝的结构化缺失字段清单；null 表示当前没有待补齐字段。 */
  readonly missing: readonly ResearchScopeGateFailureView[] | null
  readonly error?: string
  readonly onApprove: () => void
}): React.ReactElement {
  const sections = researchScopeCardSections(props.state.proposal)
  const missing = props.missing ?? []
  return (
    <div
      className="space-y-3 py-3"
      data-testid="research-scope-card"
      style={{
        color: 'var(--ui-text-1)',
        borderLeft: '3px solid var(--ui-accent)',
        background: 'color-mix(in srgb, var(--ui-accent) 7%, transparent)',
        borderRadius: '6px',
        paddingLeft: '12px',
      }}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Compass size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--ui-accent)' }} aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <strong className="block text-xs font-medium">研究范围</strong>
          <p className="whitespace-pre-wrap text-xs leading-5" style={{ color: 'var(--ui-text-2)' }}>
            确认后即开始研究；研究启动后不可干预，改范围请发起新的澄清。
          </p>
        </div>
      </div>

      <dl className="ml-6 space-y-1.5 text-xs leading-5">
        <ScopeRow label="目标" value={sections.objective} />
        <ScopeRow label="受众" value={sections.audience} />
        <ScopeRow label="纳入" value={joinList(sections.inclusions)} />
        <ScopeRow label="排除" value={joinList(sections.exclusions)} />
        <ScopeRow label="答够了的标准" value={sections.answerCriteria} />
      </dl>

      <div className="ml-6 space-y-1">
        <span className="block text-xs font-medium" style={{ color: 'var(--ui-text-2)' }}>
          初始问题树（{sections.questions.length}）
        </span>
        <ol className="space-y-1">
          {sections.questions.map((question, index) => (
            <li key={`${index}-${question.text}`} className="text-xs leading-5">
              <span style={{ color: 'var(--ui-text-1)' }}>{question.text}</span>
              <span className="ml-1.5" style={{ color: 'var(--ui-text-2)' }}>
                [{PRIORITY_LABEL[question.priority]}]
              </span>
              <span className="ml-1.5" style={{ color: 'var(--ui-text-2)' }}>
                边界：{question.boundaryNote}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {sections.snippetSearches !== undefined && (
        <p className="ml-6 text-xs leading-5" style={{ color: 'var(--ui-text-2)' }}>
          澄清期联网检索 {sections.snippetSearches} 次（仅摘要级，不进入证据账本，不可被报告引用）。
        </p>
      )}

      {missing.length > 0 && (
        <ul
          className="ml-6 space-y-0.5 rounded px-2.5 py-2 text-xs leading-5"
          style={{ background: 'rgba(212, 144, 32, 0.08)', color: 'var(--ui-status-wait)' }}
          data-testid="research-scope-missing"
        >
          {missing.map((failure) => (
            <li key={`${failure.field}:${failure.code}`}>
              {failure.field}：{failure.message}
            </li>
          ))}
        </ul>
      )}

      {props.error !== undefined && (
        <p className="ml-6 text-xs leading-5" style={{ color: 'var(--ui-status-error)' }}>
          {props.error}
        </p>
      )}

      <div className="ml-6 flex items-center gap-2">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: 'var(--ui-accent)', color: '#fff' }}
          onClick={props.onApprove}
          disabled={props.busy}
        >
          <Play size={12} aria-hidden="true" />
          {props.busy ? '启动中' : '开始研究'}
        </button>
      </div>
    </div>
  )
}

function ScopeRow(props: { readonly label: string; readonly value: string }): React.ReactElement {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0" style={{ color: 'var(--ui-text-2)', minWidth: '5.5em' }}>
        {props.label}
      </dt>
      <dd className="min-w-0 whitespace-pre-wrap" style={{ color: 'var(--ui-text-1)' }}>
        {props.value}
      </dd>
    </div>
  )
}

function joinList(values: readonly string[]): string {
  return values.length === 0 ? '—' : values.join('、')
}

export type { ResearchScopeCardState }
