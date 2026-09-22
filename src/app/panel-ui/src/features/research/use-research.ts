import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  ResearchReadinessView,
  ResearchScopeGateFailureView,
  ResearchStartPayload,
  ResearchTaskDetailView,
  ResearchTaskSummaryView,
} from '@panel-api/research'
import { ApiError } from '../../api'
import {
  cancelResearchTask,
  createResearchTask,
  fetchResearchDetail,
  fetchResearchList,
  isResearchActive,
  ResearchScopeRejected,
} from './research-client'

/**
 * 深度研究视图状态：列表 + 当前研究详情。
 *
 * 纪律（对齐架构基线「UI 乐观状态必须能被权威 HTTP snapshot 覆盖」）：
 * - HTTP snapshot 是唯一权威；这里不推断进度、不按定时器演算阶段；
 * - 只有进行中的研究才轮询（终态不再变化），页签不可见时跳过请求；
 * - 命令一律「提交 → 重读权威快照」，不本地拼接终态。
 *
 * `submit` 只接受范围卡批准过的结构化载荷（brief + questions + approval）：
 * 范围卡是唯一启动路径；范围门拒绝时把结构化缺失字段清单交给调用方，
 * 由对话侧继续追问，不在这里替用户补齐任何字段。
 */

const POLL_INTERVAL_MS = 2_000

export type ResearchState = {
  readonly tasks: readonly ResearchTaskSummaryView[]
  readonly detail: ResearchTaskDetailView | null
  readonly readiness: ResearchReadinessView | null
  readonly loading: boolean
  readonly submitting: boolean
  readonly cancelling: boolean
  readonly error: string | null
  readonly errorCode: string | null
  /** 范围门拒绝时的结构化缺失字段清单；null 表示当前没有待补齐字段。 */
  readonly missingFields: readonly ResearchScopeGateFailureView[] | null
  select(taskId: string | null): void
  submit(payload: ResearchStartPayload): Promise<void>
  cancel(): Promise<void>
  refresh(): Promise<void>
}

export function useResearch(): ResearchState {
  const [tasks, setTasks] = useState<readonly ResearchTaskSummaryView[]>([])
  const [detail, setDetail] = useState<ResearchTaskDetailView | null>(null)
  const [readiness, setReadiness] = useState<ResearchReadinessView | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [missingFields, setMissingFields] = useState<readonly ResearchScopeGateFailureView[] | null>(null)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  /** 拉权威快照：列表始终刷新，详情只在有选中项时同步。 */
  const load = useCallback(async (options: { readonly silent?: boolean } = {}): Promise<void> => {
    try {
      const list = await fetchResearchList()
      setTasks(list.tasks)
      setReadiness(list.readiness)
      const current = selectedRef.current
      if (current !== null) {
        const next = await fetchResearchDetail(current)
        setDetail(next)
      }
      if (options.silent !== true) {
        setError(null)
        setErrorCode(null)
        setMissingFields(null)
      }
    } catch (reason) {
      setError(messageOf(reason))
      setErrorCode(reason instanceof ApiError ? (reason.code ?? null) : null)
      setMissingFields(missingFieldsOf(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 选中项变化时读取详情；选中不再存在的任务时回到列表态。
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    let cancelled = false
    void fetchResearchDetail(selectedId)
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageOf(reason))
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  // 进行中才轮询；页签不可见时跳过（回到可见后下一轮自然补上）。
  const active = detail !== null && isResearchActive(detail.status)
  useEffect(() => {
    if (!active || selectedId === null) return
    let cancelled = false
    const timer = setInterval(() => {
      if (document.hidden) return
      void fetchResearchDetail(selectedId)
        .then((next) => {
          if (!cancelled) setDetail(next)
        })
        .catch(() => undefined)
      void fetchResearchList()
        .then((list) => {
          if (!cancelled) setTasks(list.tasks)
        })
        .catch(() => undefined)
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, selectedId])

  const select = useCallback((taskId: string | null) => {
    setSelectedId(taskId)
  }, [])

  const submit = useCallback(async (payload: ResearchStartPayload): Promise<void> => {
    setSubmitting(true)
    setError(null)
    setErrorCode(null)
    setMissingFields(null)
    try {
      const created = await createResearchTask(payload)
      setSelectedId(created.id)
      await load()
    } catch (reason) {
      setError(messageOf(reason))
      setErrorCode(reason instanceof ApiError ? (reason.code ?? null) : null)
      setMissingFields(missingFieldsOf(reason))
      // 失败一律原样上抛（与收紧入参前的契约一致）：调用方自行决定如何呈现。
      // 范围门拒绝额外带上结构化缺失字段清单，调用方据此回到「继续追问」状态。
      throw reason
    } finally {
      setSubmitting(false)
    }
  }, [load])

  const cancel = useCallback(async (): Promise<void> => {
    const taskId = selectedRef.current
    if (taskId === null) return
    setCancelling(true)
    try {
      const next = await cancelResearchTask(taskId)
      setDetail(next)
      await load({ silent: true })
    } catch (reason) {
      setError(messageOf(reason))
      setErrorCode(reason instanceof ApiError ? (reason.code ?? null) : null)
    } finally {
      setCancelling(false)
    }
  }, [load])

  return {
    tasks,
    detail,
    readiness,
    loading,
    submitting,
    cancelling,
    error,
    errorCode,
    missingFields,
    select,
    submit,
    cancel,
    refresh: async () => await load(),
  }
}

function missingFieldsOf(reason: unknown): readonly ResearchScopeGateFailureView[] | null {
  return reason instanceof ResearchScopeRejected ? reason.failures : null
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
