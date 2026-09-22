/**
 * 深度研究的 Panel API DTO（前后端共用，纯类型 + 共享解析）。
 *
 * 只描述产品事实：任务、来源、检索记录、报告与可用性。
 * 不透传模型原始响应，也不暴露端口实现细节。
 *
 * 范围卡（ADR 0001 §2.2）是对话侧 UI 新能力：结构化提案 → 可确认卡片 →
 * 用户点击产生携带 payload 的用户命令。这里的载荷与缺失字段清单契约由
 * 服务端与面板共用同一份定义，避免两侧各写一份解析规则。
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
  /** 观察面完整投影（状态树 + 动作事件流 + 用户可见面）：与 detail 其余字段同源权威快照。 */
  readonly ledger: ResearchObservationView;
};

/**
 * 观察面：动作事件流与研究状态树（ADR 0001 §2.6 / 设计草案 §7.5）
 *
 * 动作事件（模型内容块含推理字段、工具调用及完整参数、工具结果与失败分类、
 * 账本变更、ResourceState 转换）由研究账本持久化，经 questionRefs 可 Join
 * 问题树。这里只放【有界投影】：工具调用参数是结构化意图但可能是上下文炸弹，
 * 绝不原样透传 payload，只保留长度受限的关键字段；reasoning 仅在端点返回推理
 * 内容时出现，无推理内容时消费者不渲染空白区（reasoning_available 是任务事实）。
 * kind / status / failureClass / resourceState 等结构字段负责程序分支，
 * label / summary 只负责展示。
 */

/** 事件种类（负责程序分支）：与账本 action_event.kind 同集合。 */
export type ResearchActionEventKindView =
  | "model_content"
  | "tool_call"
  | "tool_result"
  | "ledger_change"
  | "resource_state_change"
  | "source_fetch"
  | "checkpoint_summary";

/** 外部动作失败分类（负责程序分支）：框架按真实失败原因归类，failureDetail 只作展示。 */
export type ResearchActionFailureClassView =
  | "not_configured"
  | "invalid_input"
  | "timeout"
  | "http_error"
  | "parse_error"
  | "cancelled";

/** ResourceState 三档（投影器注册槽位，ADR §2.4）：只改变行动优先级，不等于研究充分度。 */
export type ResearchResourceStateView = "normal" | "constrained" | "finalization_required";

/** 读取深度（框架按真实抓取结果写入）：摘要、部分正文、完整正文、抓取失败。 */
export type ResearchAccessLevelView = "snippet" | "partial" | "fulltext" | "unavailable";

/**
 * 单条动作事件的有界投影（上下文炸弹防线）。
 *
 * query / reason / excerpt / summary 全部长度截断，绝不原样透传工具全参数；
 * 工具调用参数只保留派生后的有界字段，完整入参留在账本内按 ID 诊断读取。
 */
export type ResearchActionEventView = {
  readonly id: string;
  readonly taskId: string;
  readonly kind: ResearchActionEventKindView;
  readonly createdAt: number;
  readonly questionRefs: readonly string[];
  /** 有界标题：由 kind + 关键字段派生，只作展示。 */
  readonly label: string;
  /** 有界摘要：工具名 / 查询 / 来源 / 失败分类等关键字段的截断呈现，只作展示。 */
  readonly summary: string;
  /** 工具类事件的研究工具标识（research_search / research_fetch / …）。 */
  readonly tool?: string;
  /** 工具结果 / 抓取的结果状态（结构）。 */
  readonly status?: string;
  /** 检索类调用的查询文本（有界截断）。 */
  readonly query?: string;
  /** 抓取类调用的来源 ID（结构）。 */
  readonly sourceId?: string;
  /** 抓取读取深度（框架事实）。 */
  readonly accessLevel?: ResearchAccessLevelView;
  /** 本次调用是否真的发出外部动作（重复 / 策略上界时框架跳过）。 */
  readonly executed?: boolean;
  /** 工具结果 / 抓取的失败分类（结构）。 */
  readonly failureClass?: ResearchActionFailureClassView;
  /** 「这类失败值不值得再试」是框架策略事实。 */
  readonly failureRetryable?: boolean;
  /** 适配器原始失败 code：展示与诊断用，不承担程序分支（有界截断）。 */
  readonly failureDetail?: string;
  /** resource_state_change 的目标档位（结构）。 */
  readonly resourceState?: ResearchResourceStateView;
  /** 模型内容块的推理文本（有界截断）：仅在端点返回推理内容时出现。 */
  readonly reasoning?: string;
};

/** 问题树节点（状态树第一层）。 */
export type ResearchQuestionTreeNode = {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly priority: string;
  readonly boundaryNote: string;
  readonly evidenceCount: number;
  readonly evidenceStatus: string;
  readonly reopenedCount: number;
};

/** 证据摘要（状态树；全文摘录按来源按需读取，这里只给有界 excerpt）。 */
export type ResearchEvidenceNode = {
  readonly id: string;
  readonly sourceId: string;
  readonly stance: string;
  readonly accessLevel: ResearchAccessLevelView;
  readonly questionIds: readonly string[];
  readonly excerpt: string;
};

/** 缺口（状态树；「向用户展示缺口」是硬要求，不折叠）。 */
export type ResearchGapNode = {
  readonly id: string;
  readonly questionId: string;
  readonly description: string;
  readonly importance: string;
  readonly origin: string;
  readonly status: string;
};

/** 分歧（状态树；双边证据约束是结构事实，evidenceSides 供呈现）。 */
export type ResearchConflictNode = {
  readonly id: string;
  readonly questionIds: readonly string[];
  readonly nature: string;
  readonly status: string;
  readonly resolutionNote: string;
  readonly evidenceAIds: readonly string[];
  readonly evidenceBIds: readonly string[];
};

/**
 * 状态树（第一屏设计视图）：问题 / 证据计数 / 缺口 / 分歧 / ResourceState + 任务事实。
 *
 * resourceState 取账本内最近一次 resource_state_change 的目标档位，无转换时 normal。
 * reasoningAvailable 是任务事实（是否捕获到推理内容）：为 false 时消费者不得渲染
 * 空白推理区；本字段是观察面对该事实的只读投影。
 */
export type ResearchStateTreeView = {
  readonly questions: readonly ResearchQuestionTreeNode[];
  readonly evidence: readonly ResearchEvidenceNode[];
  readonly gaps: readonly ResearchGapNode[];
  readonly conflicts: readonly ResearchConflictNode[];
  readonly resourceState: ResearchResourceStateView;
  readonly reasoningAvailable: boolean;
  readonly counts: {
    readonly questions: number;
    readonly evidence: number;
    readonly claims: number;
    readonly sources: number;
    readonly gaps: number;
    readonly conflicts: number;
    readonly events: number;
  };
};

/**
 * 研究账本的 UI 有界投影（facade 输出）：状态树 + 动作事件流。
 * 这是 detail 内新增字段，随 detail 的权威快照一起刷新。
 */
export type ResearchLedgerView = {
  readonly stateTree: ResearchStateTreeView;
  readonly events: readonly ResearchActionEventView[];
};

/**
 * detail 的观察面完整投影：read-model 的状态树 + 事件流，叠加 S7 收口的
 * 用户可见面（报告 / 发布判定 / 抽样核验摘要 / 用量区插桩）。
 *
 * 组合而不是扩展 ResearchLedgerView：read-model（panel-api/read-model/**）继续
 * 只拥有状态树与事件流契约，用户可见面投影是 detail  authoritative 快照上的
 * 同源派生（投影函数均为 client-safe 纯函数，路由组装时调用）。
 */
export type ResearchObservationView = ResearchLedgerView & {
  /**
   * 报告的用户可见投影（ADR 0001 §2.5）：标题 + 有界 span。
   * 引用以人类可解析的来源指向（标题 + URL + access_level）呈现——
   * evidenceId / sourceId 等内部标识不进用户可见产物（D13）。
   */
  readonly report: ResearchReportView | null;
  /** 确定性硬门的发布判定（结构字段；失败码负责程序分支，不依赖展示文案）。 */
  readonly reportGate: ResearchReportGateView;
  /** 抽样核验摘要（测量，不阻断发布）：不含 verifier 输入/输出原文。 */
  readonly citationChecks: readonly ResearchCitationCheckSummaryView[];
  /**
   * 用户可见用量区（评估插桩，S7）：turn / 每轮投影 token / 终态事实 / 支撑率。
   * 这些数据只进用户面，不进模型上下文（投影器 never_enter.usage_totals 注册在案）。
   */
  readonly instrumentation: ResearchInstrumentationView;
};

// ---------------------------------------------------------------------------
// 报告 / 发布判定 / 用量区投影（用户可见面）
//
// 输入用结构化 "Like" 形状：与账本读取形状同构，不依赖研究 Feature 实现，
// 也不透传模型原始响应。所有投影函数是 client-safe 纯函数（无时钟/随机/IO），
// 服务端路由组装 detail 权威快照时调用；Panel UI 只拿结果渲染。
// ---------------------------------------------------------------------------

/** 终态完成方式：normal=语义充分后成稿；forced=资源天花板强制收尾；incomplete=未能成稿。 */
export type ResearchCompletionView = "normal" | "forced" | "incomplete";

/** 触发的运行安全天花板（终态结构字段；展示层不得改写其语义）。 */
export type ResearchCeilingKindView = "wall_clock" | "external_actions" | "no_progress";

/** 报告引用（自包含指向：离开应用后仍成立，ADR §2.5）。 */
export type ResearchReportCitationView = {
  readonly title: string;
  readonly url: string;
  readonly accessLevel: ResearchAccessLevelView;
};

/** 一条报告 span 的用户可见投影：正文 + 归因类型 + 来源指向（不含内部 id）。 */
export type ResearchReportSpanView = {
  readonly ordinal: number;
  readonly text: string;
  /** source_statement / synthesis / inference（结构值；展示映射归 UI）。 */
  readonly attributionType: string;
  readonly citations: readonly ResearchReportCitationView[];
};

export type ResearchReportView = {
  readonly title: string;
  readonly spans: readonly ResearchReportSpanView[];
};

/** 发布判定：passed=报告已发布（硬门通过）；rejected=硬门拒绝（失败码结构清单）；not_reached=未到成稿判定。 */
export type ResearchReportGateView = {
  readonly outcome: "passed" | "rejected" | "not_reached";
  readonly failureCodes: readonly string[];
};

/** 本任务引用支撑率（抽样测量；不阻断发布，作回归指标）。 */
export type ResearchCitationSupportView = {
  readonly sampled: number;
  readonly supporting: number;
  /** verifier 输出非五值枚举的条数：单列不计入支撑率分子分母。 */
  readonly rejected: number;
  /** (supports + partially_supports) / sampled；无抽样项为 null。 */
  readonly supportRate: number | null;
};

/** 一条抽样核验摘要：span 序号是展示序，verdict 是结构值；内部 id 不外泄。 */
export type ResearchCitationCheckSummaryView = {
  readonly spanOrdinal: number;
  readonly verdict: string;
  readonly sampled: boolean;
  readonly verifierModel: string | null;
};

/** 每轮投影 token 测量（评估插桩：只埋点不调参）。 */
export type ResearchProjectionTurnView = {
  readonly turn: number;
  readonly projectorVersion: string;
  readonly instructionTokens: number;
  readonly stateTokens: number;
  readonly totalTokens: number;
  readonly slotsIncluded: number;
};

/** token 计数身份：固定通用编码的近似测量，与用户实际模型不保证逐 token 一致。 */
export type ResearchTokenizerView = {
  readonly source: string;
  readonly encoding: string;
  readonly exactMatch: boolean;
};

/**
 * 用户可见用量区（ResearchTask 既有 usage/completion/ceilingHit 之上的派生投影）。
 *
 * 覆盖 Phase 4 标定要用的实测字段：每轮投影 token 量、turn 数、forced/incomplete
 * 的终态事实与原因、检索/抓取/model 用量（usage）、抽样引用支撑率。
 * 硬边界：全部只进用户面，不进模型上下文。
 */
export type ResearchInstrumentationView = {
  readonly usage: ResearchUsageView;
  /** 已装配投影的 turn 数（执行事实，不是研究策略输入）。 */
  readonly turns: number;
  readonly projectionTurns: readonly ResearchProjectionTurnView[];
  /** 全部 turn 投影 token 合计。 */
  readonly projectionTokens: number;
  readonly tokenizer: ResearchTokenizerView | null;
  readonly completion: ResearchCompletionView | null;
  /** 终态原因结构值（如 provider_unavailable / report_gate_rejected）。 */
  readonly reason: string | null;
  readonly ceilingHit: ResearchCeilingKindView | null;
  /** finalization_required 转换次数（从 ResourceState 转换事件派生）。 */
  readonly ceilingTriggers: number;
  readonly citationSupport: ResearchCitationSupportView | null;
};

/** 账本动作事件的 "Like" 输入：与本文件 DTO 同构，不依赖 Feature 实现。 */
export type ResearchInstrumentationEventInput = {
  readonly kind: string;
  readonly payload: { readonly [key: string]: unknown };
};

/** 报告投影输入（结构 Like：账本 report + sources 的读取形状）。 */
export type ResearchReportProjectionInput = {
  readonly report: {
    readonly title: string;
    readonly spans: readonly {
      readonly ordinal: number;
      readonly text: string;
      readonly attributionType: string;
      readonly citationSourceIds: readonly string[];
    }[];
  } | null;
  readonly sources: readonly {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly accessLevel: string;
  }[];
};

const ATTRIBUTION_TYPES: ReadonlySet<string> = new Set([
  "source_statement",
  "synthesis",
  "inference",
]);

const ACCESS_LEVELS: ReadonlySet<string> = new Set<ResearchAccessLevelView>([
  "snippet",
  "partial",
  "fulltext",
  "unavailable",
]);

function researchAccessLevel(value: unknown): ResearchAccessLevelView {
  return typeof value === "string" && ACCESS_LEVELS.has(value)
    ? (value as ResearchAccessLevelView)
    : "snippet";
}

function attributionType(value: unknown): string {
  return typeof value === "string" && ATTRIBUTION_TYPES.has(value) ? value : "inference";
}

function countOfEventPayload(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function eventString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function eventStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function eventBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** 反向扫描事件：同一 (entity, change) 多次落账时取最新一条。 */
function latestLedgerChange(
  events: readonly ResearchInstrumentationEventInput[],
  entity: string,
  change: string,
): { readonly [key: string]: unknown } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.kind !== "ledger_change") continue;
    if (event.payload.entity === entity && event.payload.change === change) return event.payload;
  }
  return null;
}

function collectProjectionTurns(
  events: readonly ResearchInstrumentationEventInput[],
): readonly ResearchProjectionTurnView[] {
  const turns: ResearchProjectionTurnView[] = [];
  for (const event of events) {
    if (event.kind !== "ledger_change") continue;
    if (event.payload.entity !== "context_projection" || event.payload.change !== "turn_projection") continue;
    const turn = countOfEventPayload(event.payload.turn);
    const instructionTokens = countOfEventPayload(event.payload.instructionTokens);
    const stateTokens = countOfEventPayload(event.payload.stateTokens);
    const totalTokens = countOfEventPayload(event.payload.totalTokens);
    if (turn === undefined || instructionTokens === undefined
      || stateTokens === undefined || totalTokens === undefined) continue;
    turns.push({
      turn,
      projectorVersion: eventString(event.payload.projectorVersion) ?? "",
      instructionTokens,
      stateTokens,
      totalTokens,
      slotsIncluded: countOfEventPayload(event.payload.slotsIncluded) ?? 0,
    });
  }
  return turns.sort((left, right) => left.turn - right.turn);
}

/**
 * 报告 → 用户可见投影：引用解析为人类可读来源指向（标题 + URL + access_level）。
 * 找不到的来源（账本不一致）不渲染占位：不给用户不可解析的引用。
 */
export function projectResearchReportView(
  input: ResearchReportProjectionInput,
): ResearchReportView | null {
  if (input.report === null) return null;
  const sourcesById = new Map(input.sources.map((source) => [source.id, source]));
  return {
    title: input.report.title,
    spans: input.report.spans.map((span) => ({
      ordinal: span.ordinal,
      text: span.text,
      attributionType: attributionType(span.attributionType),
      citations: span.citationSourceIds
        .map((sourceId) => sourcesById.get(sourceId))
        .filter((source): source is NonNullable<typeof source> => source !== undefined)
        .map((source) => ({
          title: source.title,
          url: source.url,
          accessLevel: researchAccessLevel(source.accessLevel),
        })),
    })),
  };
}

/** 确定性硬门的发布判定：报告存在即通过；否则看拒绝事件（失败码结构清单）。 */
export function projectResearchReportGateView(input: {
  readonly hasReport: boolean;
  readonly errorCode: string | null;
  readonly events: readonly ResearchInstrumentationEventInput[];
}): ResearchReportGateView {
  if (input.hasReport) return { outcome: "passed", failureCodes: [] };
  const rejected = latestLedgerChange(input.events, "report", "gate_rejected");
  if (rejected !== null) {
    return { outcome: "rejected", failureCodes: eventStringList(rejected.failureCodes) };
  }
  // 拒绝事件缺失（历史数据）时退回 errorCode：仍是结构分支，不从文案反推。
  if (input.errorCode === "research_report_gate_rejected") {
    return { outcome: "rejected", failureCodes: [] };
  }
  return { outcome: "not_reached", failureCodes: [] };
}

/** 抽样核验摘要：span 序号映射自报告；verifier 输入/输出等 bulky 字段不进 DTO。 */
export function projectResearchCitationCheckSummary(input: {
  readonly checks: readonly {
    readonly reportSpanId: string;
    readonly verdict: string;
    readonly sampled: boolean;
    readonly verifierModel: string | null;
  }[];
  readonly report: { readonly spans: readonly { readonly id: string; readonly ordinal: number }[] } | null;
}): readonly ResearchCitationCheckSummaryView[] {
  if (input.report === null) return [];
  const ordinalBySpanId = new Map(input.report.spans.map((span) => [span.id, span.ordinal]));
  const summaries: ResearchCitationCheckSummaryView[] = [];
  for (const check of input.checks) {
    const spanOrdinal = ordinalBySpanId.get(check.reportSpanId);
    if (spanOrdinal === undefined) continue;
    summaries.push({
      spanOrdinal,
      verdict: check.verdict,
      sampled: check.sampled,
      verifierModel: check.verifierModel,
    });
  }
  return summaries;
}

/**
 * 用户可见用量区投影：usage + turn/投影 token + 终态事实 + 支撑率。
 *
 * 全部从既有持久事实派生（task 终态字段 + 动作事件），不落第二份状态；
 * 展示层不得从文案反推数字（结构字段负责程序分支）。
 */
export function projectResearchInstrumentationView(input: {
  readonly usage: ResearchUsageView;
  readonly completion: ResearchCompletionView | null;
  readonly reason: string | null;
  readonly ceilingHit: ResearchCeilingKindView | null;
  readonly events: readonly ResearchInstrumentationEventInput[];
}): ResearchInstrumentationView {
  const projectionTurns = collectProjectionTurns(input.events);
  const tokenizer = readProjectionTokenizer(input.events);
  let ceilingTriggers = 0;
  for (const event of input.events) {
    if (event.kind !== "resource_state_change") continue;
    if (event.payload.to === "finalization_required") ceilingTriggers += 1;
  }
  return {
    usage: input.usage,
    turns: projectionTurns.length,
    projectionTurns,
    projectionTokens: projectionTurns.reduce((total, turn) => total + turn.totalTokens, 0),
    tokenizer,
    completion: input.completion,
    reason: input.reason,
    ceilingHit: input.ceilingHit,
    ceilingTriggers,
    citationSupport: readCitationSupport(input.events),
  };
}

function readProjectionTokenizer(
  events: readonly ResearchInstrumentationEventInput[],
): ResearchTokenizerView | null {
  const latest = latestProjectionTurn(events);
  if (latest === null) return null;
  const tokenizer = latest.tokenizer;
  return {
    source: eventString(tokenizer.source) ?? "",
    encoding: eventString(tokenizer.encoding) ?? "",
    exactMatch: eventBoolean(tokenizer.exactMatch) ?? false,
  };
}

function latestProjectionTurn(
  events: readonly ResearchInstrumentationEventInput[],
): { readonly tokenizer: { readonly [key: string]: unknown } } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.kind !== "ledger_change") continue;
    if (event.payload.entity !== "context_projection" || event.payload.change !== "turn_projection") continue;
    const tokenizer = event.payload.tokenizer;
    if (typeof tokenizer === "object" && tokenizer !== null) {
      return { tokenizer: tokenizer as { readonly [key: string]: unknown } };
    }
  }
  return null;
}

/** 抽样支撑率：唯一事实源是成稿期落账的 citation_support_rate 事件。 */
function readCitationSupport(
  events: readonly ResearchInstrumentationEventInput[],
): ResearchCitationSupportView | null {
  const payload = latestLedgerChange(events, "citation_check", "citation_support_rate");
  if (payload === null) return null;
  const sampled = countOfEventPayload(payload.sampled);
  const supporting = countOfEventPayload(payload.supporting);
  const rejected = countOfEventPayload(payload.rejected);
  if (sampled === undefined || supporting === undefined || rejected === undefined) return null;
  return {
    sampled,
    supporting,
    rejected,
    supportRate: payload.supportRate === null
      ? null
      : (typeof payload.supportRate === "number" && Number.isFinite(payload.supportRate)
        ? payload.supportRate
        : null),
  };
}

export type ResearchReadinessView = {
  readonly search: { readonly available: boolean; readonly reason?: string };
};

// ---------------------------------------------------------------------------
// 范围卡 / 启动载荷（ADR 0001 §2.2 / 设计草案 §8.1）
//
// `ResearchStartPayload` 是 `ResearchApplication.start` 在 HTTP 与 Agent 工具两侧
// 的同一份形状：语义充分性由用户在范围卡上判定，框架只做结构完整性校验。
// ---------------------------------------------------------------------------

export type ResearchScopeBriefView = {
  readonly objective: string;
  readonly inclusions: readonly string[];
  readonly exclusions: readonly string[];
  readonly audience: string;
  readonly answerCriteria: string;
};

export type ResearchScopeQuestionView = {
  readonly text: string;
  readonly priority: "critical" | "normal" | "optional";
  readonly boundaryNote: string;
};

export type ResearchScopeApprovalView = {
  /** 可选：框架按规范化 payload 计算落账，提供时必须与框架计算值一致。 */
  readonly payloadHash?: string;
  readonly approvedAt: number;
  readonly conversationRef: string;
};

/** 澄清期受限检索披露：仅摘要级、有次数上限、不进入证据账本、不可被报告引用。 */
export type ResearchScopeSearchDisclosureView = {
  readonly snippetSearches: number;
};

export type ResearchStartPayload = {
  readonly brief: ResearchScopeBriefView;
  readonly questions: readonly ResearchScopeQuestionView[];
  readonly approval: ResearchScopeApprovalView;
  readonly scopeSearchDisclosure?: ResearchScopeSearchDisclosureView;
};

/** 结构校验门的单条缺失字段：`field` 定位，`code` 负责程序分支，`message` 只做展示。 */
export type ResearchScopeGateFailureView = {
  readonly field: string;
  readonly code: string;
  readonly message: string;
};

/** 范围门拒绝：HTTP 400 语义，`missing` 是完整结构化缺失字段清单。 */
export type ResearchStartRejectedResponse = {
  readonly ok: false;
  readonly status: "failed";
  readonly error: { readonly code: string; readonly message: string };
  readonly missing: readonly ResearchScopeGateFailureView[];
};

/**
 * 对话侧结构化提案的信封：主会话 agent 把澄清结果交给范围卡渲染。
 *
 * 版本化（`version` 只增不改）是为了让解析规则可以演进；`brief` 与 `questions`
 * 之外的一切内容都是展示性正文，由卡片自行呈现，不参与程序分支。
 */
export const RESEARCH_SCOPE_PROPOSAL_VERSION = 1;

export type ResearchScopeProposal = {
  readonly version: typeof RESEARCH_SCOPE_PROPOSAL_VERSION;
  readonly brief: ResearchScopeBriefView;
  readonly questions: readonly ResearchScopeQuestionView[];
  readonly scopeSearchDisclosure?: ResearchScopeSearchDisclosureView;
};

/**
 * 从对话侧产出的文本里取出待确认的结构化提案。
 *
 * 这是唯一的提案解析实现（面板与文档共用）：只认版本化信封， rejected 时返回
 * undefined，调用方不得回退到自由文本解析。
 */
export function readResearchScopeProposal(text: string): ResearchScopeProposal | undefined {
  const block = RESEARCH_SCOPE_PROPOSAL_BLOCK.exec(text);
  if (block === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block[1] ?? "") as unknown;
  } catch {
    return undefined;
  }
  return parseResearchScopeProposal(parsed);
}

export function parseResearchScopeProposal(value: unknown): ResearchScopeProposal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== RESEARCH_SCOPE_PROPOSAL_VERSION) return undefined;
  const brief = parseScopeBrief(record.brief);
  const questions = parseScopeQuestions(record.questions);
  if (brief === undefined || questions === undefined) return undefined;
  const disclosure = parseScopeSearchDisclosure(record.scopeSearchDisclosure);
  return {
    version: RESEARCH_SCOPE_PROPOSAL_VERSION,
    brief,
    questions,
    ...(disclosure === undefined ? {} : { scopeSearchDisclosure: disclosure }),
  };
}

const RESEARCH_SCOPE_PROPOSAL_BLOCK =
  /```research-scope\s*\n([\s\S]*?)```/u;

function parseScopeBrief(value: unknown): ResearchScopeBriefView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const objective = nonBlank(record.objective);
  const exclusions = nonBlankList(record.exclusions);
  const answerCriteria = nonBlank(record.answerCriteria);
  if (objective === undefined || exclusions === undefined || answerCriteria === undefined) return undefined;
  return {
    objective,
    inclusions: stringList(record.inclusions),
    exclusions,
    audience: nonBlank(record.audience) ?? "",
    answerCriteria,
  };
}

function parseScopeQuestions(value: unknown): readonly ResearchScopeQuestionView[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const questions: ResearchScopeQuestionView[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    const text = nonBlank(record.text);
    const boundaryNote = nonBlank(record.boundaryNote);
    const priority = record.priority;
    if (text === undefined || boundaryNote === undefined) return undefined;
    if (priority !== "critical" && priority !== "normal" && priority !== "optional") return undefined;
    questions.push({ text, priority, boundaryNote });
  }
  return questions;
}

function parseScopeSearchDisclosure(value: unknown): ResearchScopeSearchDisclosureView | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const snippetSearches = record.snippetSearches;
  if (typeof snippetSearches !== "number" || !Number.isInteger(snippetSearches) || snippetSearches < 0) {
    return undefined;
  }
  return { snippetSearches };
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
}

function nonBlankList(value: unknown): readonly string[] | undefined {
  const list = stringList(value).filter((item) => item.length > 0);
  return list.length === 0 ? undefined : list;
}

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
