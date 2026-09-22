import { useEffect, useMemo, useState } from 'react'

import type {
  ResearchActionEventView,
  ResearchCitationCheckSummaryView,
  ResearchInstrumentationView,
  ResearchReportGateView,
  ResearchReportView,
  ResearchStateTreeView,
} from '@panel-api/research'
import { filterResearchEventsByQuestion } from '@panel-api/ui-read-model'

/**
 * 观察面工作流状态：包装研究账本的有界投影（状态树 + 事件流 + 用户可见面），
 * 只经 ui-read-model facade 读取过滤（基线规则 6，不直接 import panel-api/read-model）。
 *
 * 「按问题过滤事件流」是客户端纯过滤（全量投影已随 detail 权威快照到达，
 * 分页 / 服务端过滤归 S4a）；选中问题在账本变化后不再存在时自动重置，
 * 避免残留一个无效过滤把轨迹清空。
 *
 * report / reportGate / citationChecks / instrumentation 是 S7 收口的用户可见面
 * （报告 title、发布判定、抽样核验摘要、用量区插桩）：与状态树同源权威快照，
 * 缺省值让「账本未到位」与「账本确实没有这些事实」可区分（null vs 空）。
 */
export type ResearchWorkflowState = {
  readonly stateTree: ResearchStateTreeView | null
  readonly events: readonly ResearchActionEventView[]
  readonly report: ResearchReportView | null
  readonly reportGate: ResearchReportGateView
  readonly citationChecks: readonly ResearchCitationCheckSummaryView[]
  readonly instrumentation: ResearchInstrumentationView | null
  readonly selectedQuestion: string | null
  readonly questionOptions: readonly { readonly id: string; readonly text: string }[]
  readonly reasoningAvailable: boolean
  selectQuestion(questionId: string | null): void
}

export function useResearchWorkflow(ledger: {
  readonly stateTree: ResearchStateTreeView
  readonly events: readonly ResearchActionEventView[]
  readonly report: ResearchReportView | null
  readonly reportGate: ResearchReportGateView
  readonly citationChecks: readonly ResearchCitationCheckSummaryView[]
  readonly instrumentation: ResearchInstrumentationView
} | null | undefined): ResearchWorkflowState {
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null)

  const stateTree = ledger?.stateTree ?? null

  const questionOptions = useMemo(
    () => (stateTree === null ? [] : stateTree.questions.map((question) => ({ id: question.id, text: question.text }))),
    [stateTree],
  )

  const events = useMemo(
    () => (ledger === null || ledger === undefined ? [] : filterResearchEventsByQuestion(ledger.events, selectedQuestion)),
    [ledger, selectedQuestion],
  )

  useEffect(() => {
    if (selectedQuestion === null) return
    if (!questionOptions.some((question) => question.id === selectedQuestion)) {
      setSelectedQuestion(null)
    }
  }, [questionOptions, selectedQuestion])

  return {
    stateTree,
    events,
    report: ledger?.report ?? null,
    reportGate: ledger?.reportGate ?? { outcome: 'not_reached', failureCodes: [] },
    citationChecks: ledger?.citationChecks ?? [],
    instrumentation: ledger?.instrumentation ?? null,
    selectedQuestion,
    questionOptions,
    reasoningAvailable: stateTree?.reasoningAvailable ?? false,
    selectQuestion: setSelectedQuestion,
  }
}
