import type {
  ResearchDetailResponse,
  ResearchListResponse,
  ResearchSourceContentResponse,
  ResearchTaskDetailView,
  ResearchTaskSummaryView,
  ResearchReadinessView,
} from '@panel-api/research'
import { getJson, postJson } from '../../api'

/**
 * 深度研究 Panel API 客户端：只做路径、请求体与响应外壳的拆装。
 * DTO 直接引用 Panel API 契约，前端不复制第二份类型。
 */

export type ResearchList = {
  readonly tasks: readonly ResearchTaskSummaryView[]
  readonly readiness: ResearchReadinessView
}

export function fetchResearchList(signal?: AbortSignal): Promise<ResearchList> {
  return getJson<ResearchListResponse>('/api/research', { signal }).then((body) => ({
    tasks: body.tasks,
    readiness: body.readiness,
  }))
}

export function fetchResearchDetail(taskId: string, signal?: AbortSignal): Promise<ResearchTaskDetailView> {
  return getJson<ResearchDetailResponse>(`/api/research/${encodeURIComponent(taskId)}`, { signal }).then(
    (body) => body.task,
  )
}

export function createResearchTask(question: string): Promise<ResearchTaskSummaryView> {
  return postJson<{ task: ResearchTaskSummaryView }>('/api/research', { question }).then((body) => body.task)
}

export function cancelResearchTask(taskId: string): Promise<ResearchTaskDetailView> {
  return postJson<ResearchDetailResponse>(`/api/research/${encodeURIComponent(taskId)}/cancel`, {}).then(
    (body) => body.task,
  )
}

export function fetchResearchSourceContent(
  taskId: string,
  sourceId: string,
  signal?: AbortSignal,
): Promise<ResearchSourceContentResponse['source']> {
  return getJson<ResearchSourceContentResponse>(
    `/api/research/${encodeURIComponent(taskId)}/sources/${encodeURIComponent(sourceId)}`,
    { signal },
  ).then((body) => body.source)
}

/** 进行中的研究才需要轮询：终态不再变化，继续请求只是浪费。 */
export function isResearchActive(status: ResearchTaskSummaryView['status']): boolean {
  return status === 'queued' || status === 'running'
}
