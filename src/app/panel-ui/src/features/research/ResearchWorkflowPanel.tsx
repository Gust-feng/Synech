import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  FileText,
  Filter,
  Gauge,
  Layers,
  ListTree,
  Wrench,
  XCircle,
} from 'lucide-react'

import type {
  ResearchActionEventKindView,
  ResearchActionEventView,
  ResearchObservationView,
} from '@panel-api/research'
import { useResearchWorkflow, type ResearchWorkflowState } from './use-research-workflow'
import './research-workflow.css'

/**
 * 研究观察面（ADR 0001 §2.6 / 设计草案 D9·D10）：两层并存。
 *
 * 第一层 · 设计视图（状态树）：问题 / 证据计数 / 缺口 / 分歧 / ResourceState 事实，
 *   始终可见；缺口与分歧显式呈现、不折叠（产品硬约束）。
 * 第二层 · 可展开的详细工作流（事件流）：动作事件流，每条带 questionRefs，可按问题过滤；
 *   推理内容仅在端点返回时渲染，绝不渲染空白推理区。
 *
 * 用户可见面（S7 收口）：报告（title + spans + 自包含引用）、确定性硬门发布判定、
 * 抽样核验摘要与用量区插桩（turn / 每轮投影 token / 终态事实 / 支撑率）。
 * 数据只来自 detail 的权威快照投影，本组件不自行请求或编排。
 */

const RESOURCE_STATE_LABEL: Record<ResearchObservationView['stateTree']['resourceState'], string> = {
  normal: '资源正常',
  constrained: '资源趋紧',
  finalization_required: '请求收尾',
}

const STANCE_LABEL: Record<string, string> = {
  supports: '支持',
  contradicts: '反驳',
  qualifies: '限定',
}

const ATTRIBUTION_LABEL: Record<string, string> = {
  source_statement: '来源陈述',
  synthesis: '综合',
  inference: '推断',
}

const ACCESS_LEVEL_LABEL: Record<string, string> = {
  snippet: '摘要',
  partial: '部分正文',
  fulltext: '全文',
  unavailable: '不可用',
}

const COMPLETION_LABEL: Record<string, string> = {
  normal: '正常完成',
  forced: '强制收尾',
  incomplete: '未完成',
}

const CEILING_LABEL: Record<string, string> = {
  wall_clock: '墙钟',
  external_actions: '外部动作总数',
  no_progress: '连续无进展',
}

const VERDICT_LABEL: Record<string, string> = {
  supports: '支撑',
  partially_supports: '部分支撑',
  contradicts: '反驳',
  does_not_support: '不支持',
  insufficient_context: '上下文不足',
}

export function ResearchWorkflowPanel({
  ledger,
  active,
}: {
  ledger?: ResearchObservationView | null
  active: boolean
}) {
  const workflow = useResearchWorkflow(ledger)
  const [expanded, setExpanded] = useState(false)

  if (ledger === null || ledger === undefined) return null

  const { stateTree } = workflow
  const questionIndex = useMemo(() => indexOfQuestion(workflow.questionOptions), [workflow.questionOptions])

  const stanceCounts = tallyStance(stateTree)
  const modelContentCount = ledger.events.filter((event) => event.kind === 'model_content').length
  const reasoningMissing = modelContentCount > 0 && workflow.reasoningAvailable === false

  return (
    <section className="rw-panel" aria-label="研究过程">
      <div className="rw-panel__header">
        <span className="rw-panel__title">
          <Activity size={14} />
          <span>研究过程</span>
        </span>
        {stateTree !== null && (
          <span className="rw-resource" data-state={stateTree.resourceState}>
            <Gauge size={12} />
            <span>{RESOURCE_STATE_LABEL[stateTree.resourceState]}</span>
          </span>
        )}
        {stateTree !== null && (
          <div className="rw-counts">
            <span><b>{stateTree.counts.questions}</b> 问题</span>
            <span><b>{stateTree.counts.evidence}</b> 证据</span>
            <span><b>{stateTree.counts.gaps}</b> 缺口</span>
            <span><b>{stateTree.counts.conflicts}</b> 分歧</span>
            <span><b>{stateTree.counts.claims}</b> 论断</span>
          </div>
        )}
      </div>

      {active && stateTree !== null && stateTree.counts.events === 0 && (
        <p className="rw-hint">研究正在启动，动作事件落地后此处实时呈现…</p>
      )}

      {/* ── 第一层：设计视图（状态树） ── */}
      {stateTree !== null && (
        <div className="rw-state">
          <StateBlock title="问题树" wide>
            {stateTree.questions.length === 0 ? (
              <p className="rw-state__empty">研究开始拆解问题后呈现。</p>
            ) : (
              <ol className="rw-qlist">
                {stateTree.questions.map((question, index) => (
                  <li key={question.id} className="rw-q">
                    <span className="rw-q__num">{index + 1}</span>
                    <span className="rw-q__body">
                      <span className="rw-q__text">{question.text}</span>
                      <span className="rw-q__meta">
                        <span className="rw-tag" data-status={question.status}>{statusLabel(question.status)}</span>
                        {question.priority === 'critical' && <span className="rw-tag">重点</span>}
                        <span>{question.evidenceCount} 条证据</span>
                        {question.evidenceStatus === 'no_external_evidence' && (
                          <span className="rw-tag">无外部证据</span>
                        )}
                        {question.reopenedCount > 0 && (
                          <span>已重开 {question.reopenedCount} 次</span>
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </StateBlock>

          <StateBlock title={`缺口 ${stateTree.gaps.length}`}>
            {stateTree.gaps.length === 0 ? (
              <p className="rw-state__empty">暂无缺口。</p>
            ) : (
              <ul className="rw-glist">
                {stateTree.gaps.map((gap) => (
                  <li key={gap.id}>
                    <p className="rw-g__desc">{gap.description}</p>
                    <div className="rw-g__meta">
                      <span className="rw-tag" data-status={gap.status}>{statusLabel(gap.status)}</span>
                      <span>重要性 {gap.importance}</span>
                      {gap.origin === 'possible_counterevidence' && <span className="rw-tag"><AlertTriangle size={9} /> 可能有反证</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </StateBlock>

          <StateBlock title={`分歧 ${stateTree.conflicts.length}`}>
            {stateTree.conflicts.length === 0 ? (
              <p className="rw-state__empty">暂无分歧。</p>
            ) : (
              <ul className="rw-clist">
                {stateTree.conflicts.map((conflict) => (
                  <li key={conflict.id}>
                    <p className="rw-c__note">
                      {conflict.resolutionNote.length > 0 ? conflict.resolutionNote : `分歧性质：${conflict.nature}`}
                    </p>
                    <div className="rw-c__meta">
                      <span className="rw-tag" data-status={conflict.status}>{statusLabel(conflict.status)}</span>
                      <span>双边证据 {conflict.evidenceAIds.length} / {conflict.evidenceBIds.length}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </StateBlock>
        </div>
      )}

      {stanceCounts.total > 0 && (
        <div className="rw-counts">
          <span>证据立场</span>
          {Object.entries(stanceCounts.byStance).map(([stance, count]) => (
            <span key={stance}>{STANCE_LABEL[stance] ?? stance} <b>{count}</b></span>
          ))}
        </div>
      )}

      {/* ── 用户可见面：报告与发布判定（ADR §2.4/§2.5）── */}
      <ReportSection workflow={workflow} />

      {/* ── 用户可见面：用量区（评估插桩，只进用户面）── */}
      <UsageSection workflow={workflow} />

      {/* ── 第二层：可展开的详细工作流（事件流） ── */}
      <button
        type="button"
        className="rw-stream__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown size={14} />
        <span>详细工作流 · {workflow.events.length} 条事件</span>
      </button>

      {expanded && (
        <div>
          {workflow.questionOptions.length > 0 && (
            <div className="rw-stream__filters" role="group" aria-label="按问题过滤">
              <span className="rw-ref"><Filter size={11} /> 过滤</span>
              <button
                type="button"
                className="rw-chip"
                aria-pressed={workflow.selectedQuestion === null}
                onClick={() => workflow.selectQuestion(null)}
              >
                全部问题
              </button>
              {workflow.questionOptions.map((question, index) => (
                <button
                  key={question.id}
                  type="button"
                  className="rw-chip"
                  aria-pressed={workflow.selectedQuestion === question.id}
                  onClick={() => workflow.selectQuestion(question.id)}
                >
                  {index + 1}. {question.text}
                </button>
              ))}
            </div>
          )}

          {reasoningMissing && (
            <p className="rw-hint">本任务端点未捕获推理内容（reasoning_available = false）。</p>
          )}

          {workflow.events.length === 0 ? (
            <p className="rw-empty">
              {active ? '动作事件落地后实时呈现。' : '暂无动作事件。'}
            </p>
          ) : (
            <ol className="rw-events">
              {workflow.events.map((event) => (
                <EventRow key={event.id} event={event} questionIndex={questionIndex} />
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}

function StateBlock({
  title,
  wide,
  children,
}: {
  title: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className={`rw-state__block${wide ? ' rw-state__block--wide' : ''}`}>
      <div className="rw-state__heading"><ListTree size={12} /> {title}</div>
      {children}
    </div>
  )
}

/**
 * 报告与发布判定（用户可见面）。
 *
 * 报告只以 spans 呈现：引用是自包含的来源指向（标题 + URL + access_level），
 * evidenceId / sourceId 等内部标识不出现在这里（ADR §2.5 / D13）。
 * 硬门拒绝时如实呈现失败码（结构值），不生成报告也不折叠事实。
 */
function ReportSection({ workflow }: { workflow: ResearchWorkflowState }) {
  const { report, reportGate } = workflow
  if (report === null && reportGate.outcome !== 'rejected') return null
  return (
    <div className="rw-report">
      <div className="rw-state__heading"><FileText size={12} /> 报告</div>
      {reportGate.outcome === 'rejected' && (
        <p className="rw-report__rejected">
          <AlertTriangle size={11} /> 报告未通过确定性硬门，未发布
          {reportGate.failureCodes.length > 0 && `（${reportGate.failureCodes.join('、')}）`}
        </p>
      )}
      {report !== null && (
        <>
          <div className="rw-report__head">
            <h4 className="rw-report__title">{report.title}</h4>
            <span className="rw-tag" data-status="passed">硬门通过</span>
          </div>
          <ol className="rw-report__spans">
            {report.spans.map((span) => (
              <li key={span.ordinal} className="rw-report__span">
                <p className="rw-report__text">{span.text}</p>
                <div className="rw-report__meta">
                  <span className="rw-tag">{ATTRIBUTION_LABEL[span.attributionType] ?? span.attributionType}</span>
                  {span.citations.map((citation, index) => (
                    <a
                      key={`${span.ordinal}-${index}`}
                      className="rw-report__cite"
                      href={citation.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {citation.title.length > 0 ? citation.title : citation.url}
                      <span className="rw-tag">{ACCESS_LEVEL_LABEL[citation.accessLevel] ?? citation.accessLevel}</span>
                    </a>
                  ))}
                  {span.citations.length === 0 && <span className="rw-ref">无引用（推断）</span>}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

/**
 * 用量区（评估插桩，S7）。
 *
 * turn / 每轮投影 token / 检索抓取模型用量 / 终态事实 / 抽样支撑率：
 * 全部是用户可见面的结构事实（Phase 4 标定参数的实测数据来源），
 * 不进模型上下文。token 计量身份如实标注（固定通用编码的近似测量）。
 */
function UsageSection({ workflow }: { workflow: ResearchWorkflowState }) {
  const { instrumentation, citationChecks } = workflow
  if (instrumentation === null) return null
  const { usage, completion, reason, ceilingHit, citationSupport, tokenizer } = instrumentation
  const verdictTally = tallyVerdicts(citationChecks)
  return (
    <div className="rw-usage">
      <div className="rw-state__heading"><Gauge size={12} /> 用量与评估</div>
      <div className="rw-usage__grid">
        <span><b>{instrumentation.turns}</b> 轮投影</span>
        <span><b>{formatCount(instrumentation.projectionTokens)}</b> 投影 token</span>
        <span><b>{usage.searchRequests}</b> 次检索</span>
        <span><b>{usage.fetchRequests}</b> 次抓取</span>
        <span><b>{usage.modelRequests}</b> 次模型调用</span>
        <span>用时 {formatDuration(usage.elapsedMs)}</span>
      </div>
      {completion !== null && (
        <p className="rw-usage__line">
          终态：{COMPLETION_LABEL[completion] ?? completion}
          {reason !== null && `（${reason}）`}
          {ceilingHit !== null && ` · 天花板 ${CEILING_LABEL[ceilingHit] ?? ceilingHit}`}
        </p>
      )}
      {completion === null && instrumentation.turns > 0 && (
        <p className="rw-usage__line">研究进行中（终态与原因收敛后呈现）。</p>
      )}
      {citationSupport !== null && (
        <p className="rw-usage__line">
          抽样引用支撑率：
          {citationSupport.supportRate === null
            ? '本任务无抽样项'
            : `${Math.round(citationSupport.supportRate * 100)}%（${citationSupport.supporting}/${citationSupport.sampled}）`}
          {citationSupport.rejected > 0 && ` · ${citationSupport.rejected} 条判定未入枚举`}
        </p>
      )}
      {verdictTally.total > 0 && (
        <p className="rw-usage__line">
          抽样核验 {verdictTally.total} 条：
          {Object.entries(verdictTally.byVerdict).map(([verdict, count]) => (
            <span key={verdict} className="rw-ref">{VERDICT_LABEL[verdict] ?? verdict} {count}</span>
          ))}
        </p>
      )}
      {tokenizer !== null && instrumentation.projectionTurns.length > 0 && (
        <details className="rw-usage__turns">
          <summary>每轮投影 token（{tokenizer.encoding} 计量，近似值）</summary>
          <ol className="rw-usage__turnlist">
            {instrumentation.projectionTurns.map((turn) => (
              <li key={turn.turn}>
                <span>第 {turn.turn} 轮</span>
                <span><b>{formatCount(turn.totalTokens)}</b> token</span>
                <span className="rw-ref">指令 {formatCount(turn.instructionTokens)} / 状态 {formatCount(turn.stateTokens)}</span>
                <span className="rw-ref">{turn.slotsIncluded} 槽位</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}

function tallyVerdicts(checks: readonly { readonly verdict: string }[]): {
  readonly total: number
  readonly byVerdict: Record<string, number>
} {
  const byVerdict: Record<string, number> = {}
  for (const check of checks) {
    byVerdict[check.verdict] = (byVerdict[check.verdict] ?? 0) + 1
  }
  return { total: checks.length, byVerdict }
}

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

function EventRow({
  event,
  questionIndex,
}: {
  event: ResearchActionEventView
  questionIndex: Map<string, number>
}) {
  const failed = event.failureClass !== undefined
  const icon = kindIcon(event)
  return (
    <li
      className="rw-event"
      data-kind={event.kind}
      data-failed={failed ? 'true' : undefined}
    >
      <span className="rw-event__icon">{icon}</span>
      <div className="rw-event__body">
        <div className="rw-event__head">
          <span className="rw-event__label">{event.label}</span>
          {event.tool !== undefined && <span className="rw-ref">{event.tool}</span>}
          <span className="rw-event__time">{formatClock(event.createdAt)}</span>
        </div>
        {event.summary.length > 0 && <p className="rw-event__summary">{event.summary}</p>}
        {event.questionRefs.length > 0 && (
          <div className="rw-event__refs">
            {event.questionRefs.map((ref) => (
              <span key={ref} className="rw-ref">Q{questionIndex.get(ref) ?? '?'}</span>
            ))}
          </div>
        )}
        {event.reasoning !== undefined && event.reasoning.length > 0 && (
          <div className="rw-event__reasoning">{event.reasoning}</div>
        )}
      </div>
    </li>
  )
}

function kindIcon(event: ResearchActionEventView) {
  switch (event.kind) {
    case 'model_content':
      return <Brain size={13} />
    case 'tool_call':
      return <Wrench size={13} />
    case 'tool_result':
      return event.failureClass === undefined ? <CheckCircle2 size={13} /> : <XCircle size={13} />
    case 'source_fetch':
      return <FileText size={13} />
    case 'resource_state_change':
      return <Gauge size={13} />
    case 'checkpoint_summary':
      return <ListTree size={13} />
    case 'ledger_change':
    default:
      return <Layers size={13} />
  }
}

function indexOfQuestion(
  options: readonly { readonly id: string; readonly text: string }[],
): Map<string, number> {
  const map = new Map<string, number>()
  options.forEach((question, index) => map.set(question.id, index + 1))
  return map
}

function tallyStance(stateTree: ResearchObservationView['stateTree'] | null): {
  readonly total: number
  readonly byStance: Record<string, number>
} {
  if (stateTree === null) return { total: 0, byStance: {} }
  const byStance: Record<string, number> = {}
  for (const item of stateTree.evidence) {
    byStance[item.stance] = (byStance[item.stance] ?? 0) + 1
  }
  return { total: stateTree.evidence.length, byStance }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    open: '开放',
    investigating: '调查中',
    covered: '已覆盖',
    disputed: '有争议',
    blocked: '受阻',
    abandoned: '已放弃',
    mitigated: '已缓解',
    unresolved: '未解决',
    impossible: '无法获得',
    reconciled: '已调解',
    scoped: '已限定范围',
  }
  return labels[status] ?? status
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
