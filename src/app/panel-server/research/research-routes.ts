import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type {
  ResearchCreateResponse,
  ResearchDetailResponse,
  ResearchListResponse,
  ResearchSourceContentResponse,
  ResearchStartRejectedResponse,
  ResearchTaskDetailView,
  ResearchTaskSummaryView,
} from "../../panel-api/research.js";
import { ResearchError, type ResearchFeature } from "../../research/index.js";
import { ResearchScopeGateError, readResearchScopeGate } from "../../research/scope-gate.js";
import type { ResearchApplication } from "../../application/research-application.js";
import {
  projectResearchLedgerView,
  type ResearchLedgerInput,
} from "../../panel-api/read-model/research/research-ledger-view.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";

/**
 * 深度研究路由：只解析 HTTP、调用一个 Application/Feature 入口、映射错误。
 * 不编排流程、不访问 Repository：研究的执行由 Host worker 承接。
 *
 * 启动载荷是结构化 scope payload（ADR 0001 §2.2）：结构完整性由 Application 的
 * 范围门判定，这里只把它的结构化缺失字段清单映射为 400 响应体。
 */

const id = z.string().trim().min(1).max(512);

const createScopeSchema = z.object({
  brief: z.object({
    objective: z.string(),
    inclusions: z.array(z.string()),
    exclusions: z.array(z.string()),
    audience: z.string(),
    answerCriteria: z.string(),
  }).strict(),
  questions: z.array(z.object({
    text: z.string(),
    priority: z.enum(["critical", "normal", "optional"]),
    boundaryNote: z.string(),
  }).strict()).min(1),
  approval: z.object({
    payloadHash: z.string().optional(),
    approvedAt: z.number(),
    conversationRef: z.string(),
  }).strict(),
  scopeSearchDisclosure: z.object({
    snippetSearches: z.number().int().min(0),
  }).strict().optional(),
}).strict();

export type ResearchRouteDependencies = {
  readonly feature: Pick<ResearchFeature, "commands" | "queries">;
  readonly application: Pick<ResearchApplication, "start" | "cancel" | "readiness">;
  /** 新任务入队后唤醒执行 worker。 */
  readonly noteQueued: () => void;
};

export async function handlePanelResearchRoute(
  dependencies: ResearchRouteDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === "/api/research" && request.method === "GET") {
    const [tasks, readiness] = await Promise.all([
      dependencies.feature.queries.summaryList({ limit: 50 }),
      dependencies.application.readiness(),
    ]);
    const body: ResearchListResponse = {
      ok: true,
      status: "completed",
      tasks: tasks.map(toSummaryView),
      readiness: { search: readiness.search },
    };
    writeJson(response, 200, body);
    return true;
  }

  if (url.pathname === "/api/research" && request.method === "POST") {
    const parsed = createScopeSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      throw new PanelHttpError(400, "invalid_research_scope", "研究启动载荷不是有效的范围卡数据。");
    }
    const readiness = await dependencies.application.readiness();
    if (!readiness.search.available) {
      throw new PanelHttpError(
        503,
        "research_search_unavailable",
        "尚未配置联网搜索服务，无法开始研究。请在设置中配置搜索服务后重试。",
      );
    }
    let started: { readonly taskId: string };
    try {
      started = await dependencies.application.start(parsed.data);
    } catch (error) {
      // 范围门拒绝：结构化缺失字段清单必须原样回到调用方（对话侧据此继续追问）。
      if (error instanceof ResearchScopeGateError) {
        const body: ResearchStartRejectedResponse = {
          ok: false,
          status: "failed",
          error: { code: error.code, message: error.message },
          missing: error.failures.map((failure) => ({
            field: failure.field,
            code: failure.code,
            message: failure.message,
          })),
        };
        writeJson(response, 400, body);
        return true;
      }
      throw error;
    }
    dependencies.noteQueued();
    const detail = await dependencies.feature.queries.detail(started.taskId);
    if (detail === undefined) {
      throw new PanelHttpError(500, "research_task_missing", "研究任务创建后无法读取。");
    }
    const body: ResearchCreateResponse = {
      ok: true,
      status: "completed",
      task: toSummaryView({
        id: detail.task.id,
        question: detail.task.question,
        status: detail.task.status,
        stage: detail.task.stage,
        sourceCount: detail.sources.length,
        questionCount: detail.task.plan?.questions.length ?? 0,
        createdAt: detail.task.createdAt,
        endedAt: detail.task.endedAt,
        errorCode: detail.task.errorCode,
      }),
    };
    writeJson(response, 201, body);
    return true;
  }

  const detailMatch = /^\/api\/research\/([^/]+)$/u.exec(url.pathname);
  if (detailMatch !== null && request.method === "GET") {
    const taskId = decodeURIComponent(detailMatch[1] ?? "");
    if (!id.safeParse(taskId).success) {
      throw new PanelHttpError(400, "invalid_research_input", "研究任务标识无效。");
    }
    // detail 与 ledger 是两次只读查询的组合（观察面投影随权威 detail 快照一起返回）。
    const [detail, ledger] = await Promise.all([
      dependencies.feature.queries.detail(taskId),
      dependencies.feature.queries.ledger(taskId),
    ]);
    if (detail === undefined || ledger === undefined) {
      throw new PanelHttpError(404, "research_task_not_found", "研究任务不存在。");
    }
    const body: ResearchDetailResponse = { ok: true, status: "completed", task: toDetailView(detail, ledger) };
    writeJson(response, 200, body);
    return true;
  }

  const sourceMatch = /^\/api\/research\/([^/]+)\/sources\/([^/]+)$/u.exec(url.pathname);
  if (sourceMatch !== null && request.method === "GET") {
    const taskId = decodeURIComponent(sourceMatch[1] ?? "");
    const sourceId = decodeURIComponent(sourceMatch[2] ?? "");
    if (!id.safeParse(taskId).success || !id.safeParse(sourceId).success) {
      throw new PanelHttpError(400, "invalid_research_input", "来源标识无效。");
    }
    const detail = await dependencies.feature.queries.detail(taskId);
    const source = detail?.sources.find((item) => item.id === sourceId);
    if (source === undefined) {
      throw new PanelHttpError(404, "research_source_not_found", "来源不存在。");
    }
    const body: ResearchSourceContentResponse = {
      ok: true,
      status: "completed",
      source: {
        id: source.id,
        ordinal: source.ordinal,
        title: source.title,
        url: source.url,
        contentStatus: source.contentStatus,
        contentText: source.contentText,
      },
    };
    writeJson(response, 200, body);
    return true;
  }

  const cancelMatch = /^\/api\/research\/([^/]+)\/cancel$/u.exec(url.pathname);
  if (cancelMatch !== null && request.method === "POST") {    const taskId = decodeURIComponent(cancelMatch[1] ?? "");
    if (!id.safeParse(taskId).success) {
      throw new PanelHttpError(400, "invalid_research_input", "研究任务标识无效。");
    }
    const result = await dependencies.application.cancel(taskId);
    if (!result.cancelled) {
      if (result.reason === "task_not_found") {
        throw new PanelHttpError(404, "research_task_not_found", "研究任务不存在。");
      }
      // 已进入终态的任务不能再取消：这是既成事实，如实返回而不是假装成功。
      throw new PanelHttpError(409, "research_task_not_cancellable", "研究已经结束，无需停止。");
    }
    const [detail, ledger] = await Promise.all([
      dependencies.feature.queries.detail(taskId),
      dependencies.feature.queries.ledger(taskId),
    ]);
    if (detail === undefined || ledger === undefined) {
      throw new PanelHttpError(404, "research_task_not_found", "研究任务不存在。");
    }
    const body: ResearchDetailResponse = { ok: true, status: "completed", task: toDetailView(detail, ledger) };
    writeJson(response, 200, body);
    return true;
  }

  return false;
}

export function researchHttpError(error: ResearchError): PanelHttpError {
  switch (error.code) {
    case "research_released":
      return new PanelHttpError(503, "panel_runtime_quiescing", "应用正在关闭，暂时无法开始研究。");
    case "research_invalid_input":
      return new PanelHttpError(400, "invalid_research_input", error.message);
    case "research_task_not_found":
      return new PanelHttpError(404, "research_task_not_found", error.message);
    case "research_task_not_terminal":
      return new PanelHttpError(409, "research_task_not_terminal", error.message);
    case "research_scope_incomplete":
      return new PanelHttpError(400, "invalid_research_scope", error.message);
    case "research_scope_approval_mismatch":
      return new PanelHttpError(400, "research_scope_approval_mismatch", error.message);
    case "research_scope_approval_failed":
      return new PanelHttpError(500, "research_scope_approval_failed", error.message);
    case "research_repository_failure":
      return new PanelHttpError(500, "research_storage_failed", "研究数据读写失败。");
  }
}

type ResearchDetail = NonNullable<Awaited<ReturnType<ResearchFeature["queries"]["detail"]>>>;

function toDetailView(detail: ResearchDetail, ledger: ResearchLedgerInput): ResearchTaskDetailView {
  return {
    id: detail.task.id,
    question: detail.task.question,
    status: detail.task.status,
    stage: detail.task.stage,
    plan: detail.task.plan === null
      ? null
      : {
          objective: detail.task.plan.objective,
          questions: detail.task.plan.questions.map((question) => ({
            id: question.id,
            text: question.text,
            priority: question.priority,
          })),
        },
    coverage: detail.task.coverage.map((round) => ({
      round: round.round,
      answers: round.answers.map((answer) => ({
        questionId: answer.questionId,
        coverage: answer.coverage,
        text: answer.text,
        gaps: answer.gaps,
      })),
    })),
    reportTitle: detail.task.reportTitle,
    reportMarkdown: detail.task.reportMarkdown,
    errorCode: detail.task.errorCode,
    errorMessage: detail.task.errorMessage,
    usage: detail.task.usage,
    createdAt: detail.task.createdAt,
    startedAt: detail.task.startedAt,
    endedAt: detail.task.endedAt,
    // 正文只在界面按需读取：列表与详情都只带元数据，避免把长正文塞进每个响应。
    sources: detail.sources.map((source) => ({
      id: source.id,
      ordinal: source.ordinal,
      title: source.title,
      url: source.url,
      snippet: source.snippet,
      hasContent: source.contentText !== null,
      contentStatus: source.contentStatus,
      contentChars: source.contentText?.length ?? 0,
      publishedAt: source.publishedAt,
    })),
    queries: detail.queries.map((query) => ({
      id: query.id,
      round: query.round,
      text: query.text,
      status: query.status,
      resultCount: query.resultCount,
    })),
    // 观察面：状态树 + 动作事件流的有界投影（ADR §2.6）；DTO 已做有界截断，不含上下文炸弹。
    ledger: projectResearchLedgerView(ledger),
  };
}

function toSummaryView(summary: {
  readonly id: string;
  readonly question: string;
  readonly status: ResearchTaskSummaryView["status"];
  readonly stage: ResearchTaskSummaryView["stage"];
  readonly sourceCount: number;
  readonly questionCount: number;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly errorCode: string | null;
}): ResearchTaskSummaryView {
  return {
    id: summary.id,
    question: summary.question,
    status: summary.status,
    stage: summary.stage,
    sourceCount: summary.sourceCount,
    questionCount: summary.questionCount,
    createdAt: summary.createdAt,
    endedAt: summary.endedAt,
    errorCode: summary.errorCode,
  };
}
