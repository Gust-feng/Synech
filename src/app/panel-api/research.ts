/**
 * 深度研究的 Panel API DTO（前后端共用，纯类型）。
 *
 * 只描述产品事实：任务、来源、检索记录、报告与可用性。
 * 不透传模型原始响应，也不暴露端口实现细节。
 */

export type ResearchTaskStatusView =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type ResearchStageView = "planning" | "searching" | "reading" | "analyzing" | "writing";

export type ResearchCoverageView = "supported" | "partial" | "contested" | "unanswered";

export type ResearchPlanQuestionView = {
  readonly id: string;
  readonly text: string;
  readonly priority: "high" | "normal";
};

export type ResearchPlanView = {
  readonly objective: string;
  readonly questions: readonly ResearchPlanQuestionView[];
};

export type ResearchCoverageRoundView = {
  readonly round: number;
  readonly answers: readonly {
    readonly questionId: string;
    readonly coverage: ResearchCoverageView;
    readonly text: string;
    readonly gaps: readonly string[];
  }[];
};

export type ResearchUsageView = {
  readonly searchRequests: number;
  readonly fetchRequests: number;
  readonly modelRequests: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly elapsedMs: number;
};

export type ResearchSourceView = {
  readonly id: string;
  readonly ordinal: number;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly hasContent: boolean;
  readonly contentStatus: "pending" | "ready" | "failed" | "skipped";
  readonly contentChars: number;
  readonly publishedAt: string | null;
};

export type ResearchQueryView = {
  readonly id: string;
  readonly round: number;
  readonly text: string;
  readonly status: "succeeded" | "failed";
  readonly resultCount: number;
};

export type ResearchTaskSummaryView = {
  readonly id: string;
  readonly question: string;
  readonly status: ResearchTaskStatusView;
  readonly stage: ResearchStageView | null;
  readonly sourceCount: number;
  readonly questionCount: number;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly errorCode: string | null;
};

export type ResearchTaskDetailView = {
  readonly id: string;
  readonly question: string;
  readonly status: ResearchTaskStatusView;
  readonly stage: ResearchStageView | null;
  readonly plan: ResearchPlanView | null;
  readonly coverage: readonly ResearchCoverageRoundView[];
  readonly reportTitle: string | null;
  readonly reportMarkdown: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly usage: ResearchUsageView;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly sources: readonly ResearchSourceView[];
  readonly queries: readonly ResearchQueryView[];
};

export type ResearchReadinessView = {
  readonly search: { readonly available: boolean; readonly reason?: string };
};

export type ResearchListResponse = {
  readonly ok: true;
  readonly status: "completed";
  readonly tasks: readonly ResearchTaskSummaryView[];
  readonly readiness: ResearchReadinessView;
};

export type ResearchDetailResponse = {
  readonly ok: true;
  readonly status: "completed";
  readonly task: ResearchTaskDetailView;
};

export type ResearchCreateResponse = {
  readonly ok: true;
  readonly status: "completed";
  readonly task: ResearchTaskSummaryView;
};

/** 单条来源的正文摘录：研究时实际读到的内容（不是全文，按抓取截断）。 */
export type ResearchSourceContentResponse = {
  readonly ok: true;
  readonly status: "completed";
  readonly source: {
    readonly id: string;
    readonly ordinal: number;
    readonly title: string;
    readonly url: string;
    readonly contentStatus: ResearchSourceView["contentStatus"];
    readonly contentText: string | null;
  };
};
