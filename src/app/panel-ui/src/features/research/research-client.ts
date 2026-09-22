import type {
  ResearchDetailResponse,
  ResearchListResponse,
  ResearchSourceContentResponse,
  ResearchStartPayload,
  ResearchStartRejectedResponse,
  ResearchScopeGateFailureView,
  ResearchTaskDetailView,
  ResearchTaskSummaryView,
  ResearchReadinessView,
} from '@panel-api/research'
import { ApiError, getJson, postJson } from '../../api'

/**
 * 深度研究 Panel API 客户端：只做路径、请求体与响应外壳的拆装。
 * DTO 直接引用 Panel API 契约，前端不复制第二份类型。
 *
 * 启动载荷是结构化 scope payload（brief + questions + approval）：范围卡是唯一
 * 启动路径，feature 层不接受「只给一个问题」的旧形状，免确认入口在这里就没有。
 */

export type ResearchList = {
  readonly tasks: readonly ResearchTaskSummaryView[]
  readonly readiness: ResearchReadinessView
}

/** 范围门拒绝：调用方拿到的结构化缺失字段清单（对话侧据此继续追问）。 */
export class ResearchScopeRejected extends Error {
  constructor(
    readonly failures: readonly ResearchScopeGateFailureView[],
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'ResearchScopeRejected'
  }
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

export async function createResearchTask(payload: ResearchStartPayload): Promise<ResearchTaskSummaryView> {
  let response: Response
  try {
    response = await fetch('/api/research', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (reason) {
    throw new ApiError(0, undefined, messageOf(reason))
  }
  const text = await response.text()
  const parsed = text.length === 0 ? {} : (JSON.parse(text) as unknown)
  if (!response.ok) {
    // 结构校验门拒绝：缺失字段清单必须完整带回（不得只留一条人类可读消息）。
    const rejected = asScopeRejection(parsed)
    if (rejected !== undefined) throw rejected
    throw new ApiError(response.status, errorCodeOf(parsed), errorMessageOf(parsed, response.status))
  }
  return (parsed as { task: ResearchTaskSummaryView }).task
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

function asScopeRejection(parsed: unknown): ResearchScopeRejected | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const body = parsed as Partial<ResearchStartRejectedResponse>
  if (body.ok !== false || !Array.isArray(body.missing)) return undefined
  return new ResearchScopeRejected(
    body.missing,
    body.error?.code,
    body.error?.message ?? '研究范围未通过结构校验。',
  )
}

function errorCodeOf(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const error = (parsed as { error?: { code?: unknown } }).error
  return typeof error?.code === 'string' ? error.code : undefined
}

function errorMessageOf(parsed: unknown, status: number): string {
  if (typeof parsed === 'object' && parsed !== null) {
    const error = (parsed as { error?: { message?: unknown } }).error
    if (typeof error?.message === 'string') return error.message
  }
  return `请求失败：${status}`
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
