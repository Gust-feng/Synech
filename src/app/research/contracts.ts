/**
 * 深度研究领域契约：研究任务、来源、检索记录与报告的结构事实，
 * 以及 Repository port、Feature 面与错误码。
 *
 * 归属说明：
 * - 本 Feature 拥有「用户提过什么问题、研究到什么程度、引用了哪些来源、最终报告是什么」。
 * - 模型调用、联网检索与正文抓取都不是本 Feature 的事实：它们由 Application 通过端口发起，
 *   本 Feature 只保存结果事实（如来源摘要、抓取到的正文）。
 * - 报告不写入 Knowledge：研究报告的 owner 是研究任务本身。
 */

export type ResearchTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type ResearchStage = "planning" | "searching" | "reading" | "analyzing" | "writing";

export type ResearchQuestionPriority = "high" | "normal";

export type ResearchPlanQuestion = {
  readonly id: string;
  readonly text: string;
  readonly priority: ResearchQuestionPriority;
};

export type ResearchPlan = {
  readonly objective: string;
  readonly questions: readonly ResearchPlanQuestion[];
};

export type ResearchCoverage = "supported" | "partial" | "contested" | "unanswered";

export type ResearchCoverageAnswer = {
  readonly questionId: string;
  readonly coverage: ResearchCoverage;
  readonly text: string;
  readonly gaps: readonly string[];
};

/** 一轮取证后的覆盖判断；按轮次累积保存。 */
export type ResearchCoverageRound = {
  readonly round: number;
  readonly answers: readonly ResearchCoverageAnswer[];
};

export type ResearchSourceStatus = "pending" | "ready" | "failed" | "skipped";

/**
 * 一条可引用来源。ordinal 是报告里的引用编号，由应用按入列顺序分配、跨轮稳定；
 * contentText 为 null 表示正文尚未抓取或抓取失败，此时证据只有 snippet（摘要）。
 */
export type ResearchSource = {
  readonly id: string;
  readonly taskId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly snippet: string;
  readonly contentText: string | null;
  readonly contentStatus: ResearchSourceStatus;
  readonly publishedAt: string | null;
  readonly retrievedAt: number;
};

/** 外部检索结果的最小形状：由 Application 从检索端口转换后交给 Feature 入列。 */
export type ResearchSourceDraft = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedAt?: string;
};

export type ResearchQueryRecord = {
  readonly id: string;
  readonly taskId: string;
  readonly round: number;
  readonly text: string;
  readonly status: "succeeded" | "failed";
  readonly resultCount: number;
  readonly createdAt: number;
};

/**
 * 已发生的用量：检索/抓取次数与模型 token 都是既成事实，
 * 额度耗尽时按实际值报告，不预测也不回填零。
 */
export type ResearchUsage = {
  readonly searchRequests: number;
  readonly fetchRequests: number;
  readonly modelRequests: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly elapsedMs: number;
};

export type ResearchTask = {
  readonly id: string;
  readonly question: string;
  readonly status: ResearchTaskStatus;
  readonly stage: ResearchStage | null;
  readonly plan: ResearchPlan | null;
  readonly coverage: readonly ResearchCoverageRound[];
  readonly reportTitle: string | null;
  readonly reportMarkdown: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly usage: ResearchUsage;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
};

export type ResearchTaskDetail = {
  readonly task: ResearchTask;
  readonly sources: readonly ResearchSource[];
  readonly queries: readonly ResearchQueryRecord[];
};

export type ResearchTaskSummary = {
  readonly id: string;
  readonly question: string;
  readonly status: ResearchTaskStatus;
  readonly stage: ResearchStage | null;
  readonly sourceCount: number;
  readonly questionCount: number;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly errorCode: string | null;
};

export type ResearchEvent = {
  readonly type: "research.task_changed";
  readonly taskId: string;
  readonly status: ResearchTaskStatus;
};

/**
 * 写入入口。全部命令在 Feature 的串行队列内执行；跨表的复合写入
 * （入列来源并按序编号、领取队列任务）由实现放进单个事务。
 */
export interface ResearchRepository {
  insertTask(task: ResearchTask): Promise<void>;
  readTask(id: string): Promise<ResearchTask | undefined>;
  listTasks(input: { readonly limit: number }): Promise<readonly ResearchTaskSummary[]>;
  /** 队列领取（CAS）：把最早的 queued 任务置为 running 并返回；没有则 undefined。 */
  claimNextQueued(input: { readonly startedAt: number }): Promise<ResearchTask | undefined>;
  /** 队列是否有待处理任务：worker 据此决定是否继续轮询。 */
  hasQueuedTasks(): Promise<boolean>;
  updateProgress(input: {
    readonly id: string;
    readonly stage: ResearchStage;
    readonly usage: ResearchUsage;
  }): Promise<void>;
  savePlan(input: { readonly id: string; readonly plan: ResearchPlan }): Promise<void>;
  saveCoverage(input: {
    readonly id: string;
    readonly coverage: readonly ResearchCoverageRound[];
  }): Promise<void>;
  /**
   * 入列来源：按 canonicalUrl 去重，为新来源分配递增 ordinal；达到 limit 即停止。
   * 返回本次真正入列的来源（含编号）；已存在的重复项不返回。
   * limit 由应用层给值（策略归应用层），仓储在事务内执行，保证不越过上限。
   */
  appendSources(input: {
    readonly taskId: string;
    readonly drafts: readonly ResearchSourceDraft[];
    readonly retrievedAt: number;
    readonly limit: number;
  }): Promise<readonly ResearchSource[]>;
  markSourceContent(input: {
    readonly taskId: string;
    readonly sourceId: string;
    readonly status: ResearchSourceStatus;
    readonly contentText: string | null;
  }): Promise<void>;
  listSources(taskId: string): Promise<readonly ResearchSource[]>;
  appendQueries(input: {
    readonly taskId: string;
    readonly records: readonly Omit<ResearchQueryRecord, "taskId">[];
  }): Promise<void>;
  listQueries(taskId: string): Promise<readonly ResearchQueryRecord[]>;
  /** 完成：报告与终态在同一事务内写入，重复提交不覆盖已有终态。 */
  finishTask(input: {
    readonly id: string;
    readonly status: "completed" | "failed" | "cancelled" | "interrupted";
    readonly reportTitle?: string;
    readonly reportMarkdown?: string;
    readonly errorCode?: string;
    readonly errorMessage?: string;
    readonly usage: ResearchUsage;
    readonly endedAt: number;
  }): Promise<ResearchTask | undefined>;
  isCancelRequested(id: string): Promise<boolean>;
  /** 请求取消：只置标记，不改终态；执行侧在步骤边界读取并自行收敛。 */
  requestCancel(id: string): Promise<void>;
  /** 启动恢复：把残留 running 标记为 interrupted；返回恢复数量。不自动重放。 */
  recoverInterrupted(input: { readonly endedAt: number }): Promise<number>;
}

export type ResearchFeature = {
  readonly commands: {
    createTask(input: { readonly question: string }): Promise<ResearchTask>;
    claimNextQueued(input?: { readonly startedAt?: number }): Promise<ResearchTask | undefined>;
    updateProgress(input: {
      readonly id: string;
      readonly stage: ResearchStage;
      readonly usage: ResearchUsage;
    }): Promise<void>;
    savePlan(input: { readonly id: string; readonly plan: ResearchPlan }): Promise<void>;
    saveCoverage(input: {
      readonly id: string;
      readonly coverage: readonly ResearchCoverageRound[];
    }): Promise<void>;
    appendSources(input: {
      readonly taskId: string;
      readonly drafts: readonly ResearchSourceDraft[];
      readonly limit: number;
    }): Promise<readonly ResearchSource[]>;
    markSourceContent(input: {
      readonly taskId: string;
      readonly sourceId: string;
      readonly status: ResearchSourceStatus;
      readonly contentText: string | null;
    }): Promise<void>;
    appendQueries(input: {
      readonly taskId: string;
      readonly records: readonly Omit<ResearchQueryRecord, "taskId">[];
    }): Promise<void>;
    finishTask(input: {
      readonly id: string;
      readonly status: "completed" | "failed" | "cancelled" | "interrupted";
      readonly reportTitle?: string;
      readonly reportMarkdown?: string;
      readonly errorCode?: string;
      readonly errorMessage?: string;
      readonly usage: ResearchUsage;
    }): Promise<ResearchTask | undefined>;
  };
  readonly queries: {
    summaryList(input?: { readonly limit?: number }): Promise<readonly ResearchTaskSummary[]>;
    detail(id: string): Promise<ResearchTaskDetail | undefined>;
    isCancelRequested(id: string): Promise<boolean>;
    hasQueuedTasks(): Promise<boolean>;
  };
  /** 取消请求：置标记并唤醒执行侧；不改终态。 */
  readonly cancel: (id: string) => Promise<void>;
  readonly events: { subscribe(listener: (event: ResearchEvent) => void): () => void };
  /** 启动恢复：running 残留标记为 interrupted（不重放）。 */
  readonly ready: () => Promise<number>;
  release(): Promise<void>;
};

export type ResearchErrorCode =
  | "research_released"
  | "research_invalid_input"
  | "research_task_not_found"
  | "research_task_not_terminal"
  | "research_repository_failure";

export class ResearchError extends Error {
  readonly name = "ResearchError";

  constructor(readonly code: ResearchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
