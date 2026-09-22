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
  /** 终态时的完成方式（normal/forced/incomplete）；未终态为 null。与语义充分性分离。 */
  readonly completion: ResearchCompletion | null;
  /** 终态原因的结构字段，如 provider_unavailable；展示层不得改写其语义。 */
  readonly reason: string | null;
  /** 触发的运行安全天花板标识；未触发为 null。 */
  readonly ceilingHit: string | null;
  /** 用户批准范围的事实（payload 哈希 + 时间 + 会话引用）；未批准为 null。 */
  readonly scopeApproval: ResearchScopeApproval | null;
  /** 关联的 ResearchBrief id；未落账为 null。 */
  readonly briefId: string | null;
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

// ---------------------------------------------------------------------------
// 研究账本实体（ADR 0001 §2.1 / 设计草案 §6）
//
// 与上方 legacy 形状的关系：旧流水线（plan/coverage JSON 列、research_source /
// research_query 表）在 S4 移除前原样工作；本节实体是行级账本，coexistence
// 期两者并存，新写入只进新表。所有 ID 由框架分配、单调递增、不回收；
// 模型输入（JSON）在 port 边界经 strict zod 校验，不得自带 ID。
// ---------------------------------------------------------------------------

/** 终态完成方式：normal=语义充分后成稿；forced=资源天花板强制收尾；incomplete=未能成稿。 */
export type ResearchCompletion = "normal" | "forced" | "incomplete";

/** 用户批准范围的事实：payload 哈希 + 批准时间 + 会话引用（D3，不设免确认）。 */
export type ResearchScopeApproval = {
  readonly payloadHash: string;
  readonly approvedAt: number;
  readonly conversationRef: string;
  /** 澄清期受限检索的披露事实：仅摘要级、不进入证据账本、不可被报告引用。 */
  readonly scopeSearchDisclosure?: ResearchScopeSearchDisclosure;
};

/** 澄清期联网检索披露：用户批准范围时一并看到的摘要级检索次数（ADR 0001 §2.2）。 */
export type ResearchScopeSearchDisclosure = {
  readonly snippetSearches: number;
};

// ---------------------------------------------------------------------------
// 范围闸门入参（ADR 0001 §2.2 / 设计草案 §8.1）
//
// 这是 `ResearchApplication.start` 的唯一公开入参形状：用户/Agent/HTTP 三个入口
// 共用它，语义充分性由用户在范围卡上判定，框架只做结构完整性校验。
// ---------------------------------------------------------------------------

export type ResearchScopeBriefInput = {
  readonly objective: string;
  readonly inclusions: readonly string[];
  readonly exclusions: readonly string[];
  readonly audience: string;
  readonly answerCriteria: string;
};

export type ResearchScopeQuestionInput = {
  readonly text: string;
  readonly priority: ResearchQuestionNodePriority;
  readonly boundaryNote: string;
};

export type ResearchScopeApprovalInput = {
  /**
   * 批准载荷的 sha256 摘要；**可选**：框架按规范化 payload 自行计算并落账，
   * 调用方（能就地计算同一摘要的一方）提供时必须与框架计算值一致，否则拒绝。
   * 客户端自述的哈希不构成「确定后不能改」的可审计事实。
   */
  readonly payloadHash?: string;
  readonly approvedAt: number;
  readonly conversationRef: string;
};

export type ResearchScopeStartInput = {
  readonly brief: ResearchScopeBriefInput;
  readonly questions: readonly ResearchScopeQuestionInput[];
  readonly approval: ResearchScopeApprovalInput;
  readonly scopeSearchDisclosure?: ResearchScopeSearchDisclosure;
};

export type ResearchBrief = {
  readonly id: string;
  readonly taskId: string;
  readonly objective: string;
  readonly inclusions: readonly string[];
  readonly exclusions: readonly string[];
  readonly audience: string;
  readonly answerCriteria: string;
  readonly createdAt: number;
};

export type ResearchBriefDraft = {
  readonly objective: string;
  readonly inclusions: readonly string[];
  readonly exclusions: readonly string[];
  readonly audience: string;
  readonly answerCriteria: string;
};

export type ResearchQuestionNodePriority = "critical" | "normal" | "optional";

export type ResearchQuestionStatus =
  | "open"
  | "investigating"
  | "covered"
  | "disputed"
  | "blocked"
  | "abandoned";

/** Question 状态机：covered/disputed/blocked/abandoned 都可经 reopen 回到 investigating。 */
export const RESEARCH_QUESTION_STATUS_TRANSITIONS: Readonly<
  Record<ResearchQuestionStatus, readonly ResearchQuestionStatus[]>
> = {
  open: ["investigating"],
  investigating: ["open", "covered", "disputed", "blocked", "abandoned"],
  covered: ["investigating", "disputed", "abandoned"],
  disputed: ["investigating", "covered", "blocked", "abandoned"],
  blocked: ["investigating", "abandoned"],
  abandoned: ["investigating"],
};

/** 新增 Question 的出处：必须可追溯地落在批准范围内（D8）。 */
export type ResearchQuestionOrigin =
  | { readonly kind: "brief"; readonly scopeBasis: string }
  | { readonly kind: "question"; readonly questionId: string; readonly scopeBasis: string }
  | { readonly kind: "evidence"; readonly evidenceId: string; readonly scopeBasis: string };

export type ResearchQuestionNode = {
  readonly id: string;
  readonly taskId: string;
  readonly parentId: string | null;
  readonly text: string;
  readonly boundaryNote: string;
  readonly priority: ResearchQuestionNodePriority;
  readonly status: ResearchQuestionStatus;
  readonly origin: ResearchQuestionOrigin;
  readonly reopenedCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/**
 * 读取时按来源计数派生，不建存储列——存储它就会形成第二事实源。
 * evidenceStatus 只描述「有没有外部证据」，不描述证据是否充分。
 */
export type ResearchEvidenceStatus = "has_sources" | "no_external_evidence";

export type ResearchQuestionNodeRead = ResearchQuestionNode & {
  readonly evidenceCount: number;
  readonly evidenceStatus: ResearchEvidenceStatus;
};

export type ResearchQuestionNodeDraft = {
  readonly text: string;
  readonly boundaryNote: string;
  readonly priority: ResearchQuestionNodePriority;
  readonly origin: ResearchQuestionOrigin;
  readonly parentId?: string | null;
};

export type ResearchQuestionEdgeKind = "split" | "merge" | "related";

export type ResearchQuestionEdge = {
  readonly id: string;
  readonly taskId: string;
  readonly fromQuestionId: string;
  readonly toQuestionId: string;
  readonly kind: ResearchQuestionEdgeKind;
  readonly createdAt: number;
};

export type ResearchQuestionEdgeDraft = {
  readonly fromQuestionId: string;
  readonly toQuestionId: string;
  readonly kind: ResearchQuestionEdgeKind;
};

/**
 * 读取深度：只能由框架依据真实抓取结果写入。
 * snippet=只有检索摘要；partial=部分正文；fulltext=完整正文；unavailable=抓取失败。
 */
export type ResearchSourceAccessLevel = "snippet" | "partial" | "fulltext" | "unavailable";

/** 来源 Provenance 复核结果；新建时为 unchecked。 */
export type ResearchSourceProvenanceStatus = "unchecked" | "confirmed" | "changed" | "unavailable";

export type ResearchSourceEntry = {
  readonly id: string;
  readonly taskId: string;
  /** 去重键：同任务内唯一；由框架按 URL 规范化计算。 */
  readonly canonicalUrl: string;
  readonly title: string;
  readonly domain: string;
  readonly snippet: string;
  readonly accessLevel: ResearchSourceAccessLevel;
  readonly contentHash: string | null;
  readonly provenanceStatus: ResearchSourceProvenanceStatus;
  readonly createdAt: number;
};

export type ResearchSourceEntryDraft = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly canonicalUrl?: string;
  readonly domain?: string;
  readonly accessLevel?: ResearchSourceAccessLevel;
};

export type ResearchEvidenceStance = "supports" | "contradicts" | "qualifies";

export type ResearchEvidenceItem = {
  readonly id: string;
  readonly taskId: string;
  readonly sourceId: string;
  readonly excerpt: string;
  readonly locator: string;
  readonly extractedClaim: string;
  readonly stance: ResearchEvidenceStance;
  /** 写入时从来源行快照的读取深度；模型输入无法设定（草稿无此字段）。 */
  readonly accessLevelSnapshot: ResearchSourceAccessLevel;
  readonly createdByModelCall: string | null;
  readonly createdAt: number;
};

export type ResearchEvidenceItemRead = ResearchEvidenceItem & {
  readonly questionIds: readonly string[];
};

/**
 * 证据草稿没有 access_level 字段：快照只能由框架按来源行的真实读取深度派生，
 * 模型不能把 snippet 声称成 fulltext（ADR §2.1）。
 */
export type ResearchEvidenceItemDraft = {
  readonly sourceId: string;
  readonly excerpt: string;
  readonly locator: string;
  readonly extractedClaim: string;
  readonly stance: ResearchEvidenceStance;
  readonly questionIds: readonly string[];
  readonly createdByModelCall?: string | null;
};

export type ResearchClaimType = "sourced" | "synthesis" | "inference";

export type ResearchClaimStatus =
  | "provisional"
  | "supported"
  | "disputed"
  | "unsupported"
  | "withdrawn";

/** Claim 状态机：withdrawn 是终态；其余状态都可被新证据改写。 */
export const RESEARCH_CLAIM_STATUS_TRANSITIONS: Readonly<
  Record<ResearchClaimStatus, readonly ResearchClaimStatus[]>
> = {
  provisional: ["supported", "disputed", "unsupported", "withdrawn"],
  supported: ["disputed", "unsupported", "withdrawn"],
  disputed: ["supported", "unsupported", "withdrawn"],
  unsupported: ["supported", "disputed", "withdrawn"],
  withdrawn: [],
};

export type ResearchClaim = {
  readonly id: string;
  readonly taskId: string;
  readonly text: string;
  readonly type: ResearchClaimType;
  readonly status: ResearchClaimStatus;
  readonly scope: string | null;
  readonly qualifier: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ResearchClaimRead = ResearchClaim & {
  readonly evidenceIds: readonly string[];
};

export type ResearchClaimDraft = {
  readonly text: string;
  readonly type: ResearchClaimType;
  readonly evidenceIds: readonly string[];
  readonly scope?: string | null;
  readonly qualifier?: string | null;
  readonly status?: ResearchClaimStatus;
};

export type ResearchGapImportance = "critical" | "material" | "minor";

export type ResearchGapOrigin =
  | "insufficient_evidence"
  | "conflicting_evidence"
  | "source_unavailable"
  | "search_exhausted"
  | "unclear_scope"
  | "possible_counterevidence"
  | "out_of_scope_lead";

export type ResearchGapStatus = "open" | "mitigated" | "unresolved" | "impossible";

/** Gap 状态机：impossible 是终态（确认无法获得，不是放弃研究）。 */
export const RESEARCH_GAP_STATUS_TRANSITIONS: Readonly<
  Record<ResearchGapStatus, readonly ResearchGapStatus[]>
> = {
  open: ["mitigated", "unresolved", "impossible"],
  mitigated: ["unresolved", "impossible"],
  unresolved: ["mitigated", "impossible"],
  impossible: [],
};

export type ResearchGap = {
  readonly id: string;
  readonly taskId: string;
  readonly questionId: string;
  readonly description: string;
  readonly importance: ResearchGapImportance;
  readonly origin: ResearchGapOrigin;
  readonly attemptedSearchIds: readonly string[];
  readonly status: ResearchGapStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ResearchGapDraft = {
  readonly questionId: string;
  readonly description: string;
  readonly importance: ResearchGapImportance;
  readonly origin: ResearchGapOrigin;
  readonly attemptedSearchIds?: readonly string[];
  readonly status?: ResearchGapStatus;
};

export type ResearchConflictNature =
  | "factual"
  | "definition"
  | "timeframe"
  | "methodology"
  | "interpretation";

export type ResearchConflictStatus = "unresolved" | "reconciled" | "scoped";

/** Conflict 状态机：unresolved 是唯一可推进状态；reconciled/scoped 都是终态。 */
export const RESEARCH_CONFLICT_STATUS_TRANSITIONS: Readonly<
  Record<ResearchConflictStatus, readonly ResearchConflictStatus[]>
> = {
  unresolved: ["reconciled", "scoped"],
  reconciled: [],
  scoped: [],
};

export type ResearchConflict = {
  readonly id: string;
  readonly taskId: string;
  readonly questionIds: readonly string[];
  readonly claimAId: string;
  readonly claimBId: string;
  readonly evidenceAIds: readonly string[];
  readonly evidenceBIds: readonly string[];
  readonly nature: ResearchConflictNature;
  readonly status: ResearchConflictStatus;
  readonly resolutionNote: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ResearchConflictDraft = {
  readonly questionIds: readonly string[];
  readonly claimAId: string;
  readonly claimBId: string;
  readonly evidenceAIds: readonly string[];
  readonly evidenceBIds: readonly string[];
  readonly nature: ResearchConflictNature;
  readonly status?: ResearchConflictStatus;
};

/** 报告归因类型：SOURCE_STATEMENT / SYNTHESIS / INFERENCE（设计草案 §6.5）。 */
export type ResearchAttributionType = "source_statement" | "synthesis" | "inference";

export type ResearchReportSpan = {
  readonly id: string;
  readonly taskId: string;
  readonly reportId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly claimIds: readonly string[];
  readonly attributionType: ResearchAttributionType;
  readonly citationSourceIds: readonly string[];
  readonly createdAt: number;
};

export type ResearchReportSpanDraft = {
  readonly text: string;
  readonly claimIds: readonly string[];
  readonly attributionType: ResearchAttributionType;
  readonly citationSourceIds: readonly string[];
};

export type ResearchReport = {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly spans: readonly ResearchReportSpan[];
  readonly createdAt: number;
};

export type ResearchCitationVerdict =
  | "supports"
  | "partially_supports"
  | "contradicts"
  | "does_not_support"
  | "insufficient_context";

export type ResearchCitationCheck = {
  readonly id: string;
  readonly taskId: string;
  readonly reportSpanId: string;
  readonly claimId: string | null;
  readonly verdict: ResearchCitationVerdict;
  /** 抽样核验标记：抽样不阻断发布，只作回归指标（D4）。 */
  readonly sampled: boolean;
  readonly verifierInput: string | null;
  readonly verifierOutput: string | null;
  readonly verifierModel: string | null;
  readonly createdAt: number;
};

export type ResearchCitationCheckDraft = {
  readonly reportSpanId: string;
  readonly verdict: ResearchCitationVerdict;
  readonly sampled: boolean;
  readonly claimId?: string | null;
  readonly verifierInput?: string | null;
  readonly verifierOutput?: string | null;
  readonly verifierModel?: string | null;
};

/**
 * 动作事件：模型内容块（含推理字段）、工具调用及完整参数、工具结果与失败分类、
 * 账本变更与 ResourceState 转换（ADR §2.6）。SourceFetch 与 CheckpointSummary
 * 按 ADR §2.1「可后置」处理：先以版本化 JSON 事件持久化，不建正式表。
 */
export type ResearchActionEventKind =
  | "model_content"
  | "tool_call"
  | "tool_result"
  | "ledger_change"
  | "resource_state_change"
  | "source_fetch"
  | "checkpoint_summary";

/** 事件负载信封：版本化 JSON，kind 专属形状由消费方按 version 解析。 */
export type ResearchActionEventPayload = {
  readonly version: number;
  readonly [key: string]: unknown;
};

export type ResearchActionEvent = {
  readonly id: string;
  readonly taskId: string;
  readonly kind: ResearchActionEventKind;
  /** 工具入参携带、框架校验：轨迹经 questionRefs 可 Join 问题树（ADR §2.6）。 */
  readonly questionRefs: readonly string[];
  readonly payload: ResearchActionEventPayload;
  readonly createdAt: number;
};

export type ResearchActionEventDraft = {
  readonly kind: ResearchActionEventKind;
  readonly questionRefs?: readonly string[];
  readonly payload: ResearchActionEventPayload;
};

/** SourceFetch 的版本化 JSON 形状（后置实体，先以事件持久化）。 */
export type ResearchSourceFetchPayload = {
  readonly version: 1;
  readonly sourceId: string;
  readonly status: "succeeded" | "timeout" | "http_error" | "parse_error" | "paywalled" | "cancelled";
  readonly retryable: boolean;
  readonly bytesRead: number | null;
  readonly contentHash: string | null;
  readonly requestedAt: number;
  readonly completedAt: number | null;
};

/** CheckpointSummary 的版本化 JSON 形状：模型生成的工作记忆，保留实体 id 回指。 */
export type ResearchCheckpointSummaryPayload = {
  readonly version: 1;
  readonly text: string;
  readonly retainedClaimIds: readonly string[];
  readonly retainedGapIds: readonly string[];
  readonly retainedConflictIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly supersedesCheckpointId: string | null;
};

// ---------------------------------------------------------------------------
// 工具层动作事实的版本化 JSON 形状（ADR 0001 §2.1 / §2.6）
//
// 研究 loop 的 search/fetch 工具是框架自己的外部调用路径：调用是否真的发生、
// 读到了什么、失败属于哪一类，都由工具落账，模型无法自述这些事实。
// SearchAttempt 没有专属事件 kind（research/1 的 kind CHECK 冻结，本切片不改 DDL），
// 因此动作与结果分别落在共用的 tool_call / tool_result kind 上，按 payload 的
// version 与 tool 字段解析；SourceFetch / CheckpointSummary 有专属 kind 与严格负载。
// ---------------------------------------------------------------------------

/** 外部动作失败分类：框架按真实失败原因归类；程序分支看 class，detail 只作展示。 */
export type ResearchActionFailureClass =
  | "not_configured"
  | "invalid_input"
  | "timeout"
  | "http_error"
  | "parse_error"
  | "cancelled";

/**
 * 「这类失败值不值得再试」是框架策略：分类决定 retryable，
 * 重试次数上界在 RESEARCH_POLICY，模型只决定换来源或记 Gap，无权选择重试次数。
 */
export const RESEARCH_ACTION_FAILURE_RETRYABLE: Readonly<
  Record<ResearchActionFailureClass, boolean>
> = {
  not_configured: false,
  invalid_input: false,
  timeout: true,
  http_error: true,
  parse_error: true,
  cancelled: false,
};

export type ResearchActionFailure = {
  readonly class: ResearchActionFailureClass;
  readonly retryable: boolean;
  /** 适配器返回的原始 code；展示与诊断用，不承担程序分支。 */
  readonly detail: string;
};

/** SearchAttempt 的版本化 JSON 形状（后置实体，先以动作事件持久化）。 */
export type ResearchSearchAttemptPayload = {
  readonly version: 1;
  readonly tool: "research_search";
  readonly query: string;
  /** 工具入参携带、仓储校验：轨迹经 questionRefs 可 Join 问题树（ADR §2.6）。 */
  readonly questionRefs: readonly string[];
  readonly requestedAt: number;
  /** 是否真的发出了外部检索：重复查询或到达策略上界时框架跳过外部调用。 */
  readonly executed: boolean;
  /** 精确查询去重：与任务内之前某次尝试完全相同的查询。 */
  readonly duplicateQuery: { readonly previousEventId: string } | null;
  /** 模型显式要求执行被判定重复的查询；override 事实本身要落账。 */
  readonly overrideDuplicateQuery: boolean;
};

/** 一次检索的结果事实：按 canonical URL 去重后的入列、重复与失败分类。 */
export type ResearchSearchOutcomePayload = {
  readonly version: 1;
  readonly tool: "research_search";
  readonly status: "completed" | "failed" | "duplicate_skipped" | "policy_ceiling";
  readonly requestedAt: number;
  readonly completedAt: number;
  readonly appendedSourceIds: readonly string[];
  readonly duplicateSourceIds: readonly string[];
  readonly failure: ResearchActionFailure | null;
};

/** 抓取尝试：内容 hash 去重判定与模型显式 override 的事实。 */
export type ResearchFetchAttemptPayload = {
  readonly version: 1;
  readonly tool: "research_fetch";
  readonly sourceId: string;
  readonly url: string;
  readonly questionRefs: readonly string[];
  readonly requestedAt: number;
  readonly executed: boolean;
  /** 内容 hash 去重：该来源已按同一 hash 读过，重复抓取不产生新事实。 */
  readonly duplicateContentHash: {
    readonly contentHash: string;
    readonly accessLevel: ResearchSourceAccessLevel;
  } | null;
  /** 模型显式要求重读已读过的来源；override 事实本身要落账。 */
  readonly overrideDuplicateRead: boolean;
};

/** StopAssessment 的版本化 JSON 形状（后置实体；循环对它的机械解释归执行层）。 */
export type ResearchStopAssessmentPayload = {
  readonly version: 1;
  readonly tool: "research_propose_stop";
  readonly assessment: {
    readonly unresolvedCriticalQuestionIds: readonly string[];
    readonly unresolvedGapIds: readonly string[];
    readonly unresolvedConflictIds: readonly string[];
    readonly strongestConclusionAtRisk: string;
    readonly nextBestAction: string | null;
    readonly expectedInformationGain: "high" | "medium" | "low";
    readonly recentSearchYield: "material" | "marginal" | "none";
    readonly recommendation: "continue" | "stop";
    readonly reason: string;
  };
  readonly recordedAt: number;
};

/**
 * 未真正发出抓取时的结果事实（重复跳过 / 策略上界）。
 *
 * 真实抓取的结果落在 `source_fetch`（SourceFetch 后置实体）上；这里的形状只描述
 * 「这一次没有抓取」的原因，两种落账渠道互不重复。
 */
export type ResearchFetchOutcomePayload = {
  readonly version: 1;
  readonly tool: "research_fetch";
  readonly status: "duplicate_skipped" | "policy_ceiling";
  readonly requestedAt: number;
  readonly completedAt: number;
  readonly failure: ResearchActionFailure | null;
};



export type ResearchQuestionUpdate = {
  readonly questionId: string;
  readonly status?: ResearchQuestionStatus;
  readonly priority?: ResearchQuestionNodePriority;
  readonly boundaryNote?: string;
};

export type ResearchClaimUpdate = {
  readonly claimId: string;
  readonly status?: ResearchClaimStatus;
  readonly text?: string;
  readonly scope?: string;
  readonly qualifier?: string;
};

/**
 * research_apply_observations 的批量形状（设计草案 §7.2）：
 * 模型负责填充语义内容，框架负责分配/校验 ID、校验引用、校验状态迁移、事务写入。
 * 一次批量就是一次模型判断的原子状态变更。
 */
export type ResearchObservationBatch = {
  readonly questionUpdates?: readonly ResearchQuestionUpdate[];
  readonly newQuestions?: readonly ResearchQuestionNodeDraft[];
  readonly evidenceItems?: readonly ResearchEvidenceItemDraft[];
  readonly claimUpdates?: readonly ResearchClaimUpdate[];
  readonly newGaps?: readonly ResearchGapDraft[];
  readonly newConflicts?: readonly ResearchConflictDraft[];
  readonly reopenQuestionIds?: readonly string[];
};

export type ResearchObservationResult = {
  readonly questions: readonly ResearchQuestionNode[];
  readonly evidenceItems: readonly ResearchEvidenceItem[];
  readonly claims: readonly ResearchClaim[];
  readonly gaps: readonly ResearchGap[];
  readonly conflicts: readonly ResearchConflict[];
};

/** 一次读取返回的完整账本图（D11：detail 返回结构化图，不是 Markdown 字符串）。 */
export type ResearchLedger = {
  readonly taskId: string;
  readonly brief: ResearchBrief | null;
  readonly questions: readonly ResearchQuestionNodeRead[];
  readonly questionEdges: readonly ResearchQuestionEdge[];
  readonly sources: readonly ResearchSourceEntry[];
  readonly evidence: readonly ResearchEvidenceItemRead[];
  readonly claims: readonly ResearchClaimRead[];
  readonly gaps: readonly ResearchGap[];
  readonly conflicts: readonly ResearchConflict[];
  readonly report: ResearchReport | null;
  readonly citationChecks: readonly ResearchCitationCheck[];
  readonly actionEvents: readonly ResearchActionEvent[];
};

/**
 * 写入入口。全部命令在 Feature 的串行队列内执行；跨表的复合写入
 * （入列来源并按序编号、领取队列任务）由实现放进单个事务。
 *
 * 账本段（brief 及以下）的不变量：
 * 1. ID 由框架分配、单调递增、不回收；模型输入不携带 ID；
 * 2. access_level 只能由框架抓取路径写入（markSourceAccess）；证据快照写入时派生；
 * 3. Conflict 必须双边各绑定 ≥2 个不同来源的 Evidence，单边一律拒绝；
 * 4. 新增 Question 必须携带 origin；Question/Claim/Gap/Conflict 状态迁移过状态机；
 * 5. finishTask 的报告（Report+ReportSpan）与终态同事务，重复提交不覆盖终态；
 * 6. recoverInterrupted 只把 running 残留标记 interrupted，绝不自动重放。
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
  /**
   * 完成：报告（Report+ReportSpan，新账本形状）与终态在同一事务内写入，
   * 重复提交不覆盖已有终态。completion/reason/ceilingHit 是终态事实；
   * 旧流水线的 reportTitle/reportMarkdown 列在 S4 移除前继续可用。
   */
  finishTask(input: {
    readonly id: string;
    readonly status: "completed" | "failed" | "cancelled" | "interrupted";
    readonly reportTitle?: string;
    readonly reportMarkdown?: string;
    readonly errorCode?: string;
    readonly errorMessage?: string;
    readonly usage: ResearchUsage;
    readonly endedAt: number;
    readonly completion?: ResearchCompletion | null;
    readonly reason?: string | null;
    readonly ceilingHit?: string | null;
    readonly report?: {
      readonly title: string;
      readonly spans: readonly ResearchReportSpanDraft[];
    };
  }): Promise<ResearchTask | undefined>;
  isCancelRequested(id: string): Promise<boolean>;
  /** 请求取消：只置标记，不改终态；执行侧在步骤边界读取并自行收敛。 */
  requestCancel(id: string): Promise<void>;
  /** 启动恢复：把残留 running 标记为 interrupted；返回恢复数量。不自动重放。 */
  recoverInterrupted(input: { readonly endedAt: number }): Promise<number>;

  // ---- 账本段：brief / question 树 / source / evidence / claim / gap / conflict / 报告 / 核验 / 事件 ----

  /** 落账用户批准的范围：brief 与 scopeApproval 同事务写入；重复批准拒绝（范围不可变）。 */
  approveScope(input: {
    readonly taskId: string;
    readonly approval: ResearchScopeApproval;
    readonly brief: ResearchBriefDraft;
  }): Promise<ResearchBrief>;
  readBrief(taskId: string): Promise<ResearchBrief | undefined>;

  /** 追加问题树节点：origin 必填且引用必须存在；ID 由框架分配。 */
  appendQuestions(input: {
    readonly taskId: string;
    readonly questions: readonly ResearchQuestionNodeDraft[];
    readonly edges?: readonly ResearchQuestionEdgeDraft[];
  }): Promise<readonly ResearchQuestionNode[]>;
  listQuestions(taskId: string): Promise<readonly ResearchQuestionNodeRead[]>;
  listQuestionEdges(taskId: string): Promise<readonly ResearchQuestionEdge[]>;

  /** 来源入列：按 canonicalUrl 去重；accessLevel 由框架给值（默认 snippet）。 */
  appendSourceEntries(input: {
    readonly taskId: string;
    readonly drafts: readonly ResearchSourceEntryDraft[];
  }): Promise<readonly ResearchSourceEntry[]>;
  /** 框架抓取路径：按真实抓取结果写 access_level 与 content_hash。 */
  markSourceAccess(input: {
    readonly taskId: string;
    readonly sourceId: string;
    readonly accessLevel: ResearchSourceAccessLevel;
    readonly contentHash: string | null;
  }): Promise<void>;
  /** 框架复核路径：来源内容与已存 hash 的一致性结论。 */
  markSourceProvenance(input: {
    readonly taskId: string;
    readonly sourceId: string;
    readonly provenanceStatus: ResearchSourceProvenanceStatus;
  }): Promise<void>;
  listSourceEntries(taskId: string): Promise<readonly ResearchSourceEntry[]>;

  /** 记录证据：source/question 引用必须存在；access_level 快照由来源行派生。 */
  appendEvidenceItems(input: {
    readonly taskId: string;
    readonly items: readonly ResearchEvidenceItemDraft[];
  }): Promise<readonly ResearchEvidenceItem[]>;
  listEvidenceItems(taskId: string): Promise<readonly ResearchEvidenceItemRead[]>;

  /** 落账 Claim：evidence 引用必须存在；type 由模型判断，状态机校验迁移。 */
  appendClaims(input: {
    readonly taskId: string;
    readonly claims: readonly ResearchClaimDraft[];
  }): Promise<readonly ResearchClaim[]>;
  listClaims(taskId: string): Promise<readonly ResearchClaimRead[]>;

  appendGaps(input: {
    readonly taskId: string;
    readonly gaps: readonly ResearchGapDraft[];
  }): Promise<readonly ResearchGap[]>;
  listGaps(taskId: string): Promise<readonly ResearchGap[]>;

  /** 建立 Conflict：双边各 ≥2 个不同来源的 Evidence，单边一律拒绝。 */
  createConflict(input: {
    readonly taskId: string;
    readonly conflict: ResearchConflictDraft;
  }): Promise<ResearchConflict>;
  listConflicts(taskId: string): Promise<readonly ResearchConflict[]>;

  /** 读取报告（含 span）；报告只经 finishTask 同事务写入。 */
  readReport(taskId: string): Promise<ResearchReport | undefined>;

  appendCitationChecks(input: {
    readonly taskId: string;
    readonly checks: readonly ResearchCitationCheckDraft[];
  }): Promise<readonly ResearchCitationCheck[]>;
  listCitationChecks(taskId: string): Promise<readonly ResearchCitationCheck[]>;

  /** 动作事件批量写入；SourceFetch/CheckpointSummary 以版本化 JSON 负载落此。 */
  appendActionEvents(input: {
    readonly taskId: string;
    readonly events: readonly ResearchActionEventDraft[];
  }): Promise<readonly ResearchActionEvent[]>;
  listActionEvents(taskId: string): Promise<readonly ResearchActionEvent[]>;

  /** 批量观察提交：一次模型判断的原子状态变更；任一结构校验失败整批拒绝。 */
  applyObservations(input: {
    readonly taskId: string;
    readonly batch: ResearchObservationBatch;
  }): Promise<ResearchObservationResult>;

  /** 一次读取返回完整账本图（一致快照）。 */
  readLedger(taskId: string): Promise<ResearchLedger | undefined>;
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
      readonly completion?: ResearchCompletion | null;
      readonly reason?: string | null;
      readonly ceilingHit?: string | null;
      readonly report?: {
        readonly title: string;
        readonly spans: readonly ResearchReportSpanDraft[];
      };
    }): Promise<ResearchTask | undefined>;
    approveScope(input: {
      readonly taskId: string;
      readonly approval: ResearchScopeApproval;
      readonly brief: ResearchBriefDraft;
    }): Promise<ResearchBrief>;
    appendQuestions(input: {
      readonly taskId: string;
      readonly questions: readonly ResearchQuestionNodeDraft[];
      readonly edges?: readonly ResearchQuestionEdgeDraft[];
    }): Promise<readonly ResearchQuestionNode[]>;
    appendSourceEntries(input: {
      readonly taskId: string;
      readonly drafts: readonly ResearchSourceEntryDraft[];
    }): Promise<readonly ResearchSourceEntry[]>;
    markSourceAccess(input: {
      readonly taskId: string;
      readonly sourceId: string;
      readonly accessLevel: ResearchSourceAccessLevel;
      readonly contentHash: string | null;
    }): Promise<void>;
    markSourceProvenance(input: {
      readonly taskId: string;
      readonly sourceId: string;
      readonly provenanceStatus: ResearchSourceProvenanceStatus;
    }): Promise<void>;
    appendEvidenceItems(input: {
      readonly taskId: string;
      readonly items: readonly ResearchEvidenceItemDraft[];
    }): Promise<readonly ResearchEvidenceItem[]>;
    appendClaims(input: {
      readonly taskId: string;
      readonly claims: readonly ResearchClaimDraft[];
    }): Promise<readonly ResearchClaim[]>;
    appendGaps(input: {
      readonly taskId: string;
      readonly gaps: readonly ResearchGapDraft[];
    }): Promise<readonly ResearchGap[]>;
    createConflict(input: {
      readonly taskId: string;
      readonly conflict: ResearchConflictDraft;
    }): Promise<ResearchConflict>;
    appendCitationChecks(input: {
      readonly taskId: string;
      readonly checks: readonly ResearchCitationCheckDraft[];
    }): Promise<readonly ResearchCitationCheck[]>;
    appendActionEvents(input: {
      readonly taskId: string;
      readonly events: readonly ResearchActionEventDraft[];
    }): Promise<readonly ResearchActionEvent[]>;
    applyObservations(input: {
      readonly taskId: string;
      readonly batch: ResearchObservationBatch;
    }): Promise<ResearchObservationResult>;
  };
  readonly queries: {
    summaryList(input?: { readonly limit?: number }): Promise<readonly ResearchTaskSummary[]>;
    detail(id: string): Promise<ResearchTaskDetail | undefined>;
    isCancelRequested(id: string): Promise<boolean>;
    hasQueuedTasks(): Promise<boolean>;
    /** 完整账本图（brief/question 树/来源/证据/主张/缺口/分歧/报告/核验/事件）。 */
    ledger(taskId: string): Promise<ResearchLedger | undefined>;
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
  | "research_repository_failure"
  | "research_scope_incomplete"
  | "research_scope_approval_mismatch"
  | "research_scope_approval_failed";

export class ResearchError extends Error {
  readonly name = "ResearchError";

  constructor(readonly code: ResearchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// 结构校验（Feature 串行队列与 repository 事务共用的唯一规则实现）
//
// 两边都调用同一函数：Feature 在串行队列内预检（快速失败），repository 在事务内
// 复验（port 边界完整性）。规则只有这一份实现，不各写一份。
// ---------------------------------------------------------------------------

/** 状态迁移守卫：不在表内的迁移一律拒绝（含自我迁移以外的任何跳跃）。 */
export function canTransitionQuestionStatus(
  from: ResearchQuestionStatus,
  to: ResearchQuestionStatus,
): boolean {
  return from === to || RESEARCH_QUESTION_STATUS_TRANSITIONS[from].includes(to);
}

export function canTransitionClaimStatus(
  from: ResearchClaimStatus,
  to: ResearchClaimStatus,
): boolean {
  return from === to || RESEARCH_CLAIM_STATUS_TRANSITIONS[from].includes(to);
}

export function canTransitionGapStatus(
  from: ResearchGapStatus,
  to: ResearchGapStatus,
): boolean {
  return from === to || RESEARCH_GAP_STATUS_TRANSITIONS[from].includes(to);
}

export function canTransitionConflictStatus(
  from: ResearchConflictStatus,
  to: ResearchConflictStatus,
): boolean {
  return from === to || RESEARCH_CONFLICT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * 新增 Question 必须携带 origin（ADR §2.1 / D8）：kind 合法、scopeBasis 非空、
 * question/evidence 类 origin 的引用 id 非空。引用是否存在由 repository 在事务内校验。
 */
export function assertQuestionOrigin(origin: ResearchQuestionOrigin): void {
  if (origin === null || typeof origin !== "object") {
    throw new ResearchError("research_invalid_input", "新增问题必须携带 origin。");
  }
  const scopeBasis = (origin as { scopeBasis?: unknown }).scopeBasis;
  if (typeof scopeBasis !== "string" || scopeBasis.trim().length === 0) {
    throw new ResearchError("research_invalid_input", "问题 origin 必须说明 scope_basis（落在批准范围内的依据）。");
  }
  const kind = (origin as { kind?: unknown }).kind;
  if (kind === "brief") return;
  if (kind === "question" || kind === "evidence") {
    const refId = kind === "question"
      ? (origin as { questionId?: unknown }).questionId
      : (origin as { evidenceId?: unknown }).evidenceId;
    if (typeof refId !== "string" || refId.trim().length === 0) {
      throw new ResearchError("research_invalid_input", `问题 origin(kind=${kind}) 必须携带引用 id。`);
    }
    return;
  }
  throw new ResearchError("research_invalid_input", `问题 origin kind 无效：${String(kind)}。`);
}

/**
 * Conflict 双边结构：每边各绑定 ≥2 个不同来源的 Evidence，单边一律拒绝
 * （ADR §2.1）。只有一边有证据的只能记为 Gap(possible_counterevidence)。
 *
 * evidenceSourceIds 是任务内 evidenceId → sourceId 的当前映射：Feature 用串行队列内
 * 读到的账本，repository 用事务内读到的行，同一函数同一规则。
 */
export function assertConflictSidesBalanced(input: {
  readonly evidenceAIds: readonly string[];
  readonly evidenceBIds: readonly string[];
  readonly evidenceSourceIds: ReadonlyMap<string, string>;
}): void {
  const checkSide = (label: "A" | "B", ids: readonly string[]): void => {
    const sourceIds = new Set<string>();
    for (const evidenceId of ids) {
      const sourceId = input.evidenceSourceIds.get(evidenceId);
      if (sourceId === undefined) {
        throw new ResearchError(
          "research_invalid_input",
          `冲突${label}边引用了不存在的证据 ${evidenceId}。`,
        );
      }
      sourceIds.add(sourceId);
    }
    if (ids.length < 2) {
      throw new ResearchError(
        "research_invalid_input",
        `冲突必须双边各绑定至少 2 条 Evidence，${label}边当前 ${ids.length} 条；单边争议只能记为 Gap(possible_counterevidence)。`,
      );
    }
    if (sourceIds.size < 2) {
      throw new ResearchError(
        "research_invalid_input",
        `冲突${label}边的 Evidence 必须来自至少 2 个不同来源，当前 ${sourceIds.size} 个。`,
      );
    }
  };
  checkSide("A", input.evidenceAIds);
  checkSide("B", input.evidenceBIds);
}
