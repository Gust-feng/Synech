import type {
  ResearchAccessLevelView,
  ResearchActionEventKindView,
  ResearchActionEventView,
  ResearchActionFailureClassView,
  ResearchConflictNode,
  ResearchEvidenceNode,
  ResearchGapNode,
  ResearchLedgerView,
  ResearchQuestionTreeNode,
  ResearchResourceStateView,
  ResearchStateTreeView,
} from "../../research.js";

/**
 * 研究账本的 UI 有界投影（client-safe，无 node 依赖，Panel UI 经 ui-read-model
 * facade 导入；ADR 0001 §2.6 / 设计草案 §7.5）。
 *
 * 两条硬纪律：
 * 1. 上下文炸弹防线：工具调用参数 / 推理 / 摘录只保留长度受限的派生字段，
 *    绝不原样透传 payload；完整事实留在账本内，按 ID 诊断读取。
 * 2. 结构字段负责程序分支（kind / tool / status / failureClass / resourceState），
 *    显示字段（label / summary）只作展示；reasoning 仅在端点返回推理内容时出现，
 *    无推理内容时消费者不渲染空白区。
 *
 * 输入用结构化的 "Like" 形状而非直接 import 研究 Feature，保持 client-safe 与解耦。
 */

export type {
  ResearchActionEventKindView,
  ResearchActionEventView,
  ResearchConflictNode,
  ResearchEvidenceNode,
  ResearchGapNode,
  ResearchLedgerView,
  ResearchQuestionTreeNode,
  ResearchResourceStateView,
  ResearchStateTreeView,
} from "../../research.js";

/** 有界上限：工具参数与摘录的截断阈值（上限要小到不能成为上下文炸弹）。 */
const TOOL_PARAM_LIMIT = 220;
const REASONING_LIMIT = 2_000;
const EXCERPT_LIMIT = 280;
const QUESTION_TEXT_LIMIT = 200;

const EVENT_KINDS: ReadonlySet<string> = new Set<ResearchActionEventKindView>([
  "model_content",
  "tool_call",
  "tool_result",
  "ledger_change",
  "resource_state_change",
  "source_fetch",
  "checkpoint_summary",
]);

const FAILURE_CLASSES: ReadonlySet<string> = new Set<ResearchActionFailureClassView>([
  "not_configured",
  "invalid_input",
  "timeout",
  "http_error",
  "parse_error",
  "cancelled",
]);

const RESOURCE_STATES: ReadonlySet<string> = new Set<ResearchResourceStateView>([
  "normal",
  "constrained",
  "finalization_required",
]);

const ACCESS_LEVELS: ReadonlySet<string> = new Set<ResearchAccessLevelView>([
  "snippet",
  "partial",
  "fulltext",
  "unavailable",
]);

// ---------------------------------------------------------------------------
// 结构化输入形状（Like）：与账本 action_event / ledger 读取形状同构，但不依赖 Feature。
// ---------------------------------------------------------------------------

export type ResearchActionEventInput = {
  readonly id: string;
  readonly taskId: string;
  readonly kind: string;
  readonly questionRefs: readonly string[];
  readonly payload: { readonly version?: number } & { readonly [key: string]: unknown };
  readonly createdAt: number;
};

export type ResearchLedgerInput = {
  readonly questions: readonly {
    readonly id: string;
    readonly text: string;
    readonly status: string;
    readonly priority: string;
    readonly boundaryNote: string;
    readonly evidenceCount: number;
    readonly evidenceStatus: string;
    readonly reopenedCount: number;
  }[];
  readonly evidence: readonly {
    readonly id: string;
    readonly sourceId: string;
    readonly stance: string;
    readonly accessLevelSnapshot: string;
    readonly questionIds: readonly string[];
    readonly excerpt: string;
  }[];
  readonly claims: readonly { readonly id: string }[];
  readonly gaps: readonly {
    readonly id: string;
    readonly questionId: string;
    readonly description: string;
    readonly importance: string;
    readonly origin: string;
    readonly status: string;
  }[];
  readonly conflicts: readonly {
    readonly id: string;
    readonly questionIds: readonly string[];
    readonly nature: string;
    readonly status: string;
    readonly resolutionNote: string | null;
    readonly evidenceAIds: readonly string[];
    readonly evidenceBIds: readonly string[];
  }[];
  readonly sources: readonly { readonly id: string }[];
  readonly actionEvents: readonly ResearchActionEventInput[];
};

// ---------------------------------------------------------------------------
// 有界小工具：类型收窄 + 截断；只按 typeof / 结构集合判定，不解析显示文案。
// ---------------------------------------------------------------------------

function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function failureClass(value: unknown): ResearchActionFailureClassView | undefined {
  return typeof value === "string" && FAILURE_CLASSES.has(value)
    ? (value as ResearchActionFailureClassView)
    : undefined;
}

function accessLevel(value: unknown): ResearchAccessLevelView | undefined {
  return typeof value === "string" && ACCESS_LEVELS.has(value)
    ? (value as ResearchAccessLevelView)
    : undefined;
}

function resourceState(value: unknown): ResearchResourceStateView | undefined {
  return typeof value === "string" && RESOURCE_STATES.has(value)
    ? (value as ResearchResourceStateView)
    : undefined;
}

const KIND_LABELS: Readonly<Record<ResearchActionEventKindView, string>> = {
  model_content: "模型内容",
  tool_call: "调用工具",
  tool_result: "工具结果",
  ledger_change: "账本变更",
  resource_state_change: "资源状态",
  source_fetch: "抓取正文",
  checkpoint_summary: "检查点",
};

const RESOURCE_STATE_LABELS: Readonly<Record<ResearchResourceStateView, string>> = {
  normal: "正常",
  constrained: "资源趋紧",
  finalization_required: "请求收尾",
};

// ---------------------------------------------------------------------------
// 单条事件的有界投影。
// ---------------------------------------------------------------------------

export function projectResearchActionEvent(event: ResearchActionEventInput): ResearchActionEventView {
  const kind: ResearchActionEventKindView = EVENT_KINDS.has(event.kind)
    ? (event.kind as ResearchActionEventKindView)
    : "ledger_change";
  const payload = event.payload;
  const view: ResearchActionEventView = {
    id: event.id,
    taskId: event.taskId,
    kind,
    createdAt: event.createdAt,
    questionRefs: stringArray(event.questionRefs),
    label: KIND_LABELS[kind],
    summary: "",
  };
  return applyKindProjection(view, kind, payload);
}

function applyKindProjection(
  base: ResearchActionEventView,
  kind: ResearchActionEventKindView,
  payload: { readonly [key: string]: unknown },
): ResearchActionEventView {
  switch (kind) {
    case "tool_call":
      return projectToolCall(base, payload);
    case "tool_result":
      return projectToolResult(base, payload);
    case "source_fetch":
      return projectSourceFetch(base, payload);
    case "checkpoint_summary":
      return projectCheckpoint(base, payload);
    case "resource_state_change":
      return projectResourceState(base, payload);
    case "model_content":
      return projectModelContent(base, payload);
    case "ledger_change":
    default:
      return projectLedgerChange(base, payload);
  }
}

function projectToolCall(
  base: ResearchActionEventView,
  payload: { readonly [key: string]: unknown },
): ResearchActionEventView {
  const tool = stringOrUndefined(payload.tool);
  const query = boundedText(payload.query, TOOL_PARAM_LIMIT);
  const sourceId = stringOrUndefined(payload.sourceId);
  const executed = booleanOrUndefined(payload.executed);
  const skipped = executed === false;
  const parts: string[] = [];
  if (query !== undefined) parts.push(`查询「${query}」`);
  if (sourceId !== undefined) parts.push(`来源 ${sourceId}`);
  if (payload.overrideDuplicateQuery === true || payload.overrideDuplicateRead === true) {
    parts.push("模型强制重复执行");
  } else if (skipped) {
    parts.push("框架判定重复，未发出外部调用");
  }
  return {
    ...base,
    ...(tool === undefined ? {} : { tool }),
    ...(query === undefined ? {} : { query }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(executed === undefined ? {} : { executed }),
    summary: parts.join("；"),
  };
}

function projectToolResult(
  base: ResearchActionEventView,
  payload: { readonly [key: string]: unknown },
): ResearchActionEventView {
  const tool = stringOrUndefined(payload.tool);
  const status = stringOrUndefined(payload.status);
  const failure = readFailure(payload.failure);
  const appended = stringArray(payload.appendedSourceIds).length;
  const duplicates = stringArray(payload.duplicateSourceIds).length;
  const parts: string[] = [];
  if (status !== undefined) parts.push(status);
  if (appended > 0) parts.push(`新增 ${appended} 个来源`);
  if (duplicates > 0) parts.push(`重复 ${duplicates} 个`);
  if (failure !== undefined) parts.push(failure.summaryText);
  return {
    ...base,
    ...(tool === undefined ? {} : { tool }),
    ...(status === undefined ? {} : { status }),
    ...(failure === undefined
      ? {}
      : {
          failureClass: failure.klass,
          failureRetryable: failure.retryable,
          failureDetail: failure.detailText,
        }),
    summary: parts.join("；"),
  };
}

function projectSourceFetch(
  base: ResearchActionEventView,
  payload: { readonly [key: string]: unknown },
): ResearchActionEventView {
  const sourceId = stringOrUndefined(payload.sourceId);
  const status = stringOrUndefined(payload.status);
  const retryable = booleanOrUndefined(payload.retryable);
  const bytesRead = countOf(payload.bytesRead);
  const level = accessLevel(payload.accessLevel);
  const parts: string[] = [];
  if (status !== undefined) parts.push(status);
  if (level !== undefined) parts.push(`读取深度 ${level}`);
  if (bytesRead !== undefined) parts.push(`${bytesRead} 字节`);
  return {
    ...base,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(status === undefined ? {} : { status }),
    ...(level === undefined ? {} : { accessLevel: level }),
    summary: parts.join("；"),
    ...(retryable === undefined ? {} : { failureRetryable: retryable }),
  };
}

function projectCheckpoint(
  base: ResearchActionEventView,
  payload: { readonly [key: string]: unknown },
): ResearchActionEventView {
  const text = boundedText(payload.text, REASONING_LIMIT) ?? "";
  const claimCount = stringArray(payload.retainedClaimIds).length;
  const gapCount = stringArray(payload.retainedGapIds).length;
  const conflictCount = stringArray(payload.retainedConflictIds).length;
  return {
    ...base,
    summary: text,
    ...(claimCount + gapCount + conflictCount > 0
      ? { tool: "research_checkpoint" }
      : {}),
  };
}

function projectResourceState(
  base: ResearchActionEventView,
  payload: { readonly [key: string]: unknown },
): ResearchActionEventView {
  const next =
    resourceState(payload.state) ??
    resourceState(payload.to) ??
    resourceState(payload.resourceState) ??
    resourceState(payload.next);
  return {
    ...base,
    ...(next === undefined ? {} : { resourceState: next }),
    summary: next === undefined ? "" : RESOURCE_STATE_LABELS[next],
  };
}

function projectModelContent(
  base: ResearchActionEventView,
  payload: { readonly [key: string]: unknown },
): ResearchActionEventView {
  const reasoning = boundedText(payload.reasoning, REASONING_LIMIT);
  const answer = boundedText(payload.text, REASONING_LIMIT) ?? boundedText(payload.content, REASONING_LIMIT);
  const parts: string[] = [];
  if (answer !== undefined) parts.push(answer);
  if (reasoning !== undefined) parts.push(`含推理内容`);
  return {
    ...base,
    ...(reasoning === undefined ? {} : { reasoning }),
    summary: parts.join("；"),
  };
}

function projectLedgerChange(
  base: ResearchActionEventView,
  payload: { readonly [key: string]: unknown },
): ResearchActionEventView {
  const entity = stringOrUndefined(payload.entity) ?? stringOrUndefined(payload.entityKind);
  const change = stringOrUndefined(payload.change) ?? stringOrUndefined(payload.action);
  const parts: string[] = [];
  if (entity !== undefined) parts.push(entity);
  if (change !== undefined) parts.push(change);
  return { ...base, summary: parts.join(" · ") };
}

function readFailure(value: unknown): {
  readonly klass: ResearchActionFailureClassView;
  readonly retryable: boolean;
  readonly detailText: string | undefined;
  readonly summaryText: string;
} | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { readonly [key: string]: unknown };
  const klass = failureClass(record.class);
  if (klass === undefined) return undefined;
  const retryable = record.retryable === true;
  const detailText = boundedText(record.detail, TOOL_PARAM_LIMIT);
  return {
    klass,
    retryable,
    detailText,
    summaryText: detailText === undefined ? `失败 ${klass}` : `失败 ${klass}：${detailText}`,
  };
}

// ---------------------------------------------------------------------------
// 状态树（第一屏设计视图）+ 账本投影。
// ---------------------------------------------------------------------------

export function projectResearchLedgerView(ledger: ResearchLedgerInput): ResearchLedgerView {
  const events = ledger.actionEvents.map(projectResearchActionEvent);
  return {
    stateTree: {
      questions: ledger.questions.map((question) => ({
        id: question.id,
        text: boundedText(question.text, QUESTION_TEXT_LIMIT) ?? "",
        status: question.status,
        priority: question.priority,
        boundaryNote: question.boundaryNote,
        evidenceCount: question.evidenceCount,
        evidenceStatus: question.evidenceStatus,
        reopenedCount: question.reopenedCount,
      })),
      evidence: ledger.evidence.map((item) => ({
        id: item.id,
        sourceId: item.sourceId,
        stance: item.stance,
        accessLevel: (accessLevel(item.accessLevelSnapshot) ?? "snippet"),
        questionIds: stringArray(item.questionIds),
        excerpt: boundedText(item.excerpt, EXCERPT_LIMIT) ?? "",
      })),
      gaps: ledger.gaps.map((gap) => ({
        id: gap.id,
        questionId: gap.questionId,
        description: boundedText(gap.description, EXCERPT_LIMIT) ?? "",
        importance: gap.importance,
        origin: gap.origin,
        status: gap.status,
      })),
      conflicts: ledger.conflicts.map((conflict) => ({
        id: conflict.id,
        questionIds: stringArray(conflict.questionIds),
        nature: conflict.nature,
        status: conflict.status,
        resolutionNote: boundedText(conflict.resolutionNote, EXCERPT_LIMIT) ?? "",
        evidenceAIds: stringArray(conflict.evidenceAIds),
        evidenceBIds: stringArray(conflict.evidenceBIds),
      })),
      resourceState: currentResourceState(events),
      reasoningAvailable: reasoningCaptured(events),
      counts: {
        questions: ledger.questions.length,
        evidence: ledger.evidence.length,
        claims: ledger.claims.length,
        sources: ledger.sources.length,
        gaps: ledger.gaps.length,
        conflicts: ledger.conflicts.length,
        events: events.length,
      },
    },
    events,
  };
}

/** 当前 ResourceState：账本内最近一次 resource_state_change 的目标档位，无则 normal。 */
function currentResourceState(events: readonly ResearchActionEventView[]): ResearchResourceStateView {
  let state: ResearchResourceStateView = "normal";
  for (const event of events) {
    if (event.kind === "resource_state_change" && event.resourceState !== undefined) {
      state = event.resourceState;
    }
  }
  return state;
}

/** 是否捕获到推理内容：任一模型内容块带推理即为 true（reasoning_available 的观察面投影）。 */
function reasoningCaptured(events: readonly ResearchActionEventView[]): boolean {
  return events.some((event) => event.kind === "model_content" && event.reasoning !== undefined);
}

/** 按问题过滤事件流（questionRefs 命中即保留）：「按问题过滤轨迹」是一次纯函数查询。 */
export function filterResearchEventsByQuestion(
  events: readonly ResearchActionEventView[],
  questionId: string | null,
): readonly ResearchActionEventView[] {
  if (questionId === null) return events;
  return events.filter((event) => event.questionRefs.includes(questionId));
}
