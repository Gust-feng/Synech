import { useCallback, useEffect, useRef, useState } from 'react'

import type { ResearchReadinessView, ResearchTaskDetailView, ResearchTaskSummaryView } from '@panel-api/research'
import { ApiError } from '../../api'
import {
  cancelResearchTask,
  createResearchTask,
  fetchResearchDetail,
  fetchResearchList,
  isResearchActive,
} from './research-client'

/**
 * 深度研究视图状态：列表 + 当前研究详情。
 *
 * 纪律（对齐架构基线「UI 乐观状态必须能被权威 HTTP snapshot 覆盖」）：
 * - HTTP snapshot 是唯一权威；这里不推断进度、不按定时器演算阶段；
 * - 只有进行中的研究才轮询（终态不再变化），页签不可见时跳过请求；
 * - 命令一律「提交 → 重读权威快照」，不本地拼接终态。
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
  select(taskId: string | null): void
  submit(question: string): Promise<void>
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
      }
    } catch (reason) {
      setError(messageOf(reason))
      setErrorCode(reason instanceof ApiError ? (reason.code ?? null) : null)
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

  const submit = useCallback(async (question: string): Promise<void> => {
    setSubmitting(true)
    setError(null)
    setErrorCode(null)
    try {
      const created = await createResearchTask(question)
      setSelectedId(created.id)
      await load()
    } catch (reason) {
      setError(messageOf(reason))
      setErrorCode(reason instanceof ApiError ? (reason.code ?? null) : null)
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
    select,
    submit,
    cancel,
    refresh: async () => await load(),
  }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
